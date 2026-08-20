/**
 * `slowcook worker` pure planner — W0 (docs/plans/rewo-agent-workers.md).
 *
 * The worker's job is to turn GitHub trigger labels into at most ONE job
 * per pass, with every precondition the target agent needs evaluated and
 * NAMED before anything runs. The defect class this hunts: an agent
 * consuming a previous agent's under-delivered output and failing three
 * stages downstream. A `fail` here names the upstream agent at the point
 * of the gap instead.
 *
 * Pure module — no fs, no network, no clock. The CLI wrapper
 * (`./index.ts`) gathers `IssueFact`s from the forge and
 * `StoryArtifactFacts` from the consumer repo, and owns all IO.
 *
 * Trigger table (plan §1):
 *
 * | Trigger label  | Worker runs                  |
 * |----------------|------------------------------|
 * | `agent:refine` | `slowcook refine --issue N`  |
 * | `agent:recipe` | `slowcook recipe --spec ID`  |
 * | `agent:brew`   | `slowcook brew --story ID`   |
 * | `agent:eye`    | `slowcook eye --story ID`    |
 *
 * `agent:failed` is terminal until a human relabels — issues carrying it
 * are excluded from job derivation and reported in the workload summary.
 */

export type AgentKind = "refine" | "recipe" | "brew" | "eye";

export const TRIGGER_LABELS: Readonly<Record<string, AgentKind>> = {
  "agent:refine": "refine",
  "agent:recipe": "recipe",
  "agent:brew": "brew",
  "agent:eye": "eye",
};

export const FAILED_LABEL = "agent:failed";

/** Label the worker applies on success, per agent. */
export const RESULT_LABELS: Readonly<Record<AgentKind, string>> = {
  refine: "agent:refined",
  recipe: "agent:reciped",
  brew: "agent:brewed",
  eye: "agent:qa-pass", // or agent:qa-fail — eye's verdict decides
};

/** An issue as fetched from the forge. */
export interface IssueFact {
  number: number;
  title: string;
  /** Issue body; empty string when GitHub returns null. */
  body: string;
  labels: string[];
  /** ISO-8601. Used for oldest-first ordering. */
  createdAt: string;
}

/**
 * What exists on disk / in the index for the story behind an issue.
 * Every field is tri-state: true / false / undefined = not gathered.
 * The planner treats undefined as `unknown` — recorded loudly, never
 * silently passed. Fail closed is the doctor's job; the worker's job
 * is to never claim it checked something it did not.
 */
export interface StoryArtifactFacts {
  /** Story id resolved from specs/_index.yaml via source_issue. */
  storyId?: string;
  /** specs/story-<id>.yaml exists AND parses. */
  specParses?: boolean;
  /** Parsed spec has a non-empty invariants list. */
  invariantsNonEmpty?: boolean;
  /** .brewing/manifests/story-<id>.json exists AND parses. */
  manifestExists?: boolean;
  /** Manifest has a non-empty tests list and every test file exists. */
  testsDiscoverable?: boolean;
}

export type CheckStatus = "pass" | "fail" | "unknown";

export interface PreconditionCheck {
  /** Stable machine name, e.g. "spec-parses". */
  name: string;
  status: CheckStatus;
  /** Human sentence: what was required and what was actually found. */
  detail: string;
  /**
   * The agent whose output this precondition is — set on fail/unknown so a
   * `precondition-missing` outcome names the UPSTREAM under-deliverer.
   * Absent for preconditions owned by the operator (e.g. issue body).
   */
  upstream?: AgentKind;
}

export interface WorkerJob {
  issue: number;
  issueTitle: string;
  agent: AgentKind;
  triggerLabel: string;
  storyId?: string;
  /** Exact argv the worker would run (dry-run) or runs (live). */
  cmd: string[];
  preconditions: PreconditionCheck[];
  /**
   * false when any precondition FAILED — the job's outcome is
   * `precondition-missing`: record and stop, never repair (plan §3).
   * `unknown` checks do not block; they are recorded as unknown.
   */
  runnable: boolean;
  /** Numeric priority from a `priority:N` label; lower runs first. */
  priority: number;
}

/**
 * Derive jobs from labelled issues. One job per (issue × trigger label);
 * an issue with two trigger labels yields two jobs (a human said so —
 * record it, don't second-guess). Issues carrying `agent:failed` yield
 * no jobs: terminal until a human relabels.
 */
export function deriveJobs(
  issues: IssueFact[],
  factsFor: (issue: IssueFact) => StoryArtifactFacts
): WorkerJob[] {
  const jobs: WorkerJob[] = [];
  for (const issue of issues) {
    if (issue.labels.includes(FAILED_LABEL)) continue;
    for (const label of issue.labels) {
      const agent = TRIGGER_LABELS[label];
      if (!agent) continue;
      const facts = factsFor(issue);
      const preconditions = evaluatePreconditions(agent, issue, facts);
      jobs.push({
        issue: issue.number,
        issueTitle: issue.title,
        agent,
        triggerLabel: label,
        ...(facts.storyId !== undefined ? { storyId: facts.storyId } : {}),
        cmd: cmdFor(agent, issue.number, facts.storyId),
        preconditions,
        runnable: preconditions.every((c) => c.status !== "fail"),
        priority: priorityOf(issue.labels),
      });
    }
  }
  return orderJobs(jobs, issues);
}

/**
 * Ordering policy (plan §1, configurable later):
 *   1. unblock before advance — a job whose preconditions FAIL is surfaced
 *      first (its processing is the report that names the upstream gap;
 *      staleness compounds while it waits);
 *   2. then by declared priority (`priority:N` label, lower first);
 *   3. then oldest issue first.
 */
export function orderJobs(jobs: WorkerJob[], issues: IssueFact[]): WorkerJob[] {
  const createdAt = new Map(issues.map((i) => [i.number, Date.parse(i.createdAt) || 0]));
  return [...jobs].sort((a, b) => {
    const aBlocked = a.runnable ? 1 : 0;
    const bBlocked = b.runnable ? 1 : 0;
    if (aBlocked !== bBlocked) return aBlocked - bBlocked;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return (createdAt.get(a.issue) ?? 0) - (createdAt.get(b.issue) ?? 0);
  });
}

function priorityOf(labels: string[]): number {
  for (const l of labels) {
    const m = l.match(/^priority:(\d+)$/);
    if (m) return Number(m[1]);
  }
  return Number.MAX_SAFE_INTEGER;
}

function cmdFor(agent: AgentKind, issue: number, storyId: string | undefined): string[] {
  switch (agent) {
    case "refine":
      return ["slowcook", "refine", "--issue", String(issue)];
    case "recipe":
      return ["slowcook", "recipe", "--spec", storyId ?? "<unresolved>"];
    case "brew":
      return ["slowcook", "brew", "--story", storyId ?? "<unresolved>"];
    case "eye":
      return ["slowcook", "eye", "--story", storyId ?? "<unresolved>"];
  }
}

/**
 * What each agent REQUIRES from its upstream, evaluated against gathered
 * facts (plan §3). Tri-state per check; a fact the wrapper could not
 * gather is `unknown`, stated as such — never a silent pass.
 */
export function evaluatePreconditions(
  agent: AgentKind,
  issue: IssueFact,
  facts: StoryArtifactFacts
): PreconditionCheck[] {
  const tri = (
    name: string,
    value: boolean | undefined,
    passDetail: string,
    failDetail: string,
    upstream?: AgentKind
  ): PreconditionCheck => ({
    name,
    status: value === undefined ? "unknown" : value ? "pass" : "fail",
    detail:
      value === undefined
        ? `not gathered this pass — treat as unverified, not as satisfied`
        : value
          ? passDetail
          : failDetail,
    ...(upstream !== undefined && value !== true ? { upstream } : {}),
  });

  switch (agent) {
    case "refine":
      return [
        {
          name: "issue-body-non-empty",
          status: issue.body.trim().length > 0 ? "pass" : "fail",
          detail:
            issue.body.trim().length > 0
              ? `issue #${issue.number} body is ${issue.body.trim().length} chars`
              : `issue #${issue.number} has an empty body — refine has nothing to refine`,
        },
      ];
    case "recipe":
      return [
        tri(
          "spec-exists",
          facts.storyId === undefined ? false : facts.specParses,
          `spec story-${facts.storyId} found and parses`,
          facts.storyId === undefined
            ? `no story in specs/_index.yaml has source_issue #${issue.number} — refine never delivered`
            : `spec story-${facts.storyId} is indexed but missing or unparsable on disk`,
          "refine"
        ),
        tri(
          "spec-invariants-non-empty",
          facts.invariantsNonEmpty,
          `spec has invariants`,
          `spec story-${facts.storyId ?? "?"} has an empty invariants list — recipe would generate tests of nothing`,
          "refine"
        ),
      ];
    case "brew":
      return [
        tri(
          "manifest-exists",
          facts.manifestExists,
          `.brewing/manifests/story-${facts.storyId ?? "?"}.json found and parses`,
          `no test manifest for story-${facts.storyId ?? "?"} — recipe never froze one`,
          "recipe"
        ),
        tri(
          "tests-discoverable",
          facts.testsDiscoverable,
          `every manifest test file exists`,
          `manifest names tests whose files are missing — brew would chase deleted tests`,
          "recipe"
        ),
        {
          name: "tests-red-at-baseline",
          status: "unknown",
          detail: "requires a test run; not checked in dry-run (W0)",
          upstream: "recipe",
        },
      ];
    case "eye":
      return [
        {
          name: "mock-builds",
          status: "unknown",
          detail: "requires a build; not checked in dry-run (W0)",
          upstream: "brew",
        },
        {
          name: "deploy-responds",
          status: "unknown",
          detail: "requires the deployed URL from config; not checked in dry-run (W0)",
          upstream: "brew",
        },
      ];
  }
}

/**
 * A submitted human review on an open spec PR IS pipeline state (plan §1):
 * the spec's owner (refine) must answer it. The worker derives this — no
 * label, no human transport (ledger G8: a PM review sat unattended because
 * only the session knew to act).
 */
export const DERIVED_SPEC_REVIEW_TRIGGER = "(derived) spec-pr-review";

export interface SpecPrReviewFact {
  prNumber: number;
  headBranch: string;
  title: string;
  /** ISO time of the PR branch's last commit. */
  lastCommitAt: string;
  /** ISO time of the newest SUBMITTED human review; null when none. */
  lastHumanReviewAt: string | null;
}

/**
 * One refine-resubmit job per spec PR whose newest human review is newer
 * than its newest commit — feedback the spec has not yet answered.
 */
export function deriveResubmitJobs(specPrs: SpecPrReviewFact[]): WorkerJob[] {
  const jobs: WorkerJob[] = [];
  for (const pr of specPrs) {
    if (!pr.lastHumanReviewAt) continue;
    if (Date.parse(pr.lastHumanReviewAt) <= Date.parse(pr.lastCommitAt)) continue;
    jobs.push({
      issue: pr.prNumber,
      issueTitle: pr.title,
      agent: "refine",
      triggerLabel: DERIVED_SPEC_REVIEW_TRIGGER,
      cmd: ["slowcook", "refine", "--pr", String(pr.prNumber)],
      preconditions: [
        {
          name: "spec-pr-review-newer-than-spec",
          status: "pass",
          detail: `review at ${pr.lastHumanReviewAt} > last commit at ${pr.lastCommitAt} on ${pr.headBranch}`,
        },
      ],
      runnable: true,
      priority: 0, // unblock before advance — unanswered feedback compounds
    });
  }
  return jobs;
}

/** The per-pass report — impossible to state from labels alone (plan §1). */
export interface WorkloadSummary {
  issuesScanned: number;
  triggersFound: number;
  jobs: Array<{
    issue: number;
    agent: AgentKind;
    runnable: boolean;
    storyId?: string;
  }>;
  /** Issues terminal under agent:failed, awaiting a human relabel. */
  failedAwaitingHuman: number[];
}

export function summarizeWorkload(issues: IssueFact[], jobs: WorkerJob[]): WorkloadSummary {
  return {
    issuesScanned: issues.length,
    triggersFound: jobs.length,
    jobs: jobs.map((j) => ({
      issue: j.issue,
      agent: j.agent,
      runnable: j.runnable,
      ...(j.storyId !== undefined ? { storyId: j.storyId } : {}),
    })),
    failedAwaitingHuman: issues
      .filter((i) => i.labels.includes(FAILED_LABEL))
      .map((i) => i.number),
  };
}

export function renderWorkloadLine(s: WorkloadSummary): string {
  const blocked = s.jobs.filter((j) => !j.runnable).length;
  const parts = [
    `${s.issuesScanned} issue${s.issuesScanned === 1 ? "" : "s"} scanned`,
    `${s.triggersFound} trigger${s.triggersFound === 1 ? "" : "s"}`,
  ];
  if (blocked > 0) parts.push(`${blocked} blocked on a missing precondition`);
  if (s.failedAwaitingHuman.length > 0)
    parts.push(`${s.failedAwaitingHuman.length} agent:failed awaiting a human`);
  return parts.join(" — ");
}
