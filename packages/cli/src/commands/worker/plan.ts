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

export type AgentKind = "refine" | "recipe" | "brew" | "eye" | "taste";

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
  taste: "agent:tasted", // rarely used — the posted review/merge IS the state
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
    case "taste":
      return ["slowcook", "taste", "--pr", String(issue), "--merge"];
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
    case "taste":
      return [
        {
          name: "pr-open-unreviewed",
          status: "pass",
          detail: `agent PR #${issue.number} awaits review`,
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

/**
 * The agent↔agent conversation is BOUNDED: past this many submitted
 * reviews on one PR, neither taste nor the author agent re-fires — the
 * PM (cc'd on every changes-request) arbitrates. Runaway review loops
 * are two models politely burning money.
 */
export const MAX_REVIEW_ROUNDS = 4;

/**
 * One author-agent resubmit job per open agent PR whose newest submitted
 * review (human OR taste) is newer than its newest commit — feedback the
 * artifact has not yet answered. Spec PRs route to refine, tests PRs to
 * recipe: the artifact's OWNER answers its reviews.
 */
export function deriveResubmitJobs(prs: AgentPrFact[]): WorkerJob[] {
  const jobs: WorkerJob[] = [];
  for (const pr of prs) {
    const kind = pr.headBranch.includes("slowcook/spec/")
      ? ("spec" as const)
      : pr.headBranch.includes("slowcook/tests/")
        ? ("tests" as const)
        : null;
    if (!kind) continue;
    if (!pr.lastAnyReviewAt) continue;
    if (Date.parse(pr.lastAnyReviewAt) <= Date.parse(pr.lastCommitAt)) continue;
    if (pr.submittedReviewCount >= MAX_REVIEW_ROUNDS) continue; // PM arbitrates
    const agent: AgentKind = kind === "spec" ? "refine" : "recipe";
    jobs.push({
      issue: pr.prNumber,
      issueTitle: pr.title,
      agent,
      triggerLabel: DERIVED_SPEC_REVIEW_TRIGGER,
      cmd: ["slowcook", agent === "refine" ? "refine" : "recipe", "--pr", String(pr.prNumber)],
      preconditions: [
        {
          name: "pr-review-newer-than-code",
          status: "pass",
          detail: `review at ${pr.lastAnyReviewAt} > last commit at ${pr.lastCommitAt} on ${pr.headBranch} (round ${pr.submittedReviewCount}/${MAX_REVIEW_ROUNDS})`,
        },
      ],
      runnable: true,
      priority: 0, // unblock before advance — unanswered feedback compounds
    });
  }
  return jobs;
}

/**
 * The reviewer stage is triggered BY THE PR: any open agent-authored
 * spec/tests PR with no submitted review asks for taste; a PR whose
 * newest commit is newer than its newest review asks for a re-taste
 * after amendments. Submitted human activity always wins: a human
 * review newer than the last commit belongs to the AUTHOR agent's
 * resubmit derivation, never to taste.
 */
export const DERIVED_UNREVIEWED_PR_TRIGGER = "(derived) agent-pr-unreviewed";

export interface AgentPrFact {
  prNumber: number;
  headBranch: string;
  title: string;
  lastCommitAt: string;
  lastHumanReviewAt: string | null;
  /** Newest submitted review by ANYONE (bots included); null when none. */
  lastAnyReviewAt: string | null;
  /** Total submitted reviews — the round counter for MAX_REVIEW_ROUNDS. */
  submittedReviewCount: number;
}

export function deriveTasteJobs(prs: AgentPrFact[]): WorkerJob[] {
  const jobs: WorkerJob[] = [];
  for (const pr of prs) {
    // Brew (code) PRs get an ADVISORY review — taste never merges them
    // (brew is a human gate by default); the verdict is prep for the PM
    // (eleven-defects D8).
    if (
      !pr.headBranch.includes("slowcook/spec/") &&
      !pr.headBranch.includes("slowcook/tests/") &&
      !pr.headBranch.includes("slowcook/brew/")
    )
      continue;
    // ANY review newer than the code is the author-agent's turn.
    if (
      pr.lastAnyReviewAt &&
      Date.parse(pr.lastAnyReviewAt) > Date.parse(pr.lastCommitAt)
    )
      continue;
    if (pr.submittedReviewCount >= MAX_REVIEW_ROUNDS) continue; // PM arbitrates
    const unreviewed = pr.lastAnyReviewAt === null;
    const amendedSinceReview =
      pr.lastAnyReviewAt !== null &&
      Date.parse(pr.lastCommitAt) > Date.parse(pr.lastAnyReviewAt);
    if (!unreviewed && !amendedSinceReview) continue;
    jobs.push({
      issue: pr.prNumber,
      issueTitle: pr.title,
      agent: "taste",
      triggerLabel: DERIVED_UNREVIEWED_PR_TRIGGER,
      cmd: ["slowcook", "taste", "--pr", String(pr.prNumber), "--merge"],
      preconditions: [
        {
          name: "pr-open-unreviewed",
          status: "pass",
          detail: unreviewed
            ? `no submitted review on ${pr.headBranch}`
            : `amended since last review (commit ${pr.lastCommitAt} > review ${pr.lastAnyReviewAt})`,
        },
      ],
      runnable: true,
      priority: 5, // reviews unblock merges, which unblock everything downstream
    });
  }
  return jobs;
}

/**
 * W2: a MERGED spec with no tests and no open tests PR asks for recipe —
 * derived from artifacts (plan §1), not from anyone applying a label.
 * Auto-advance across the refine→recipe handoff; the human gate was the
 * spec PR review/merge that produced the state.
 */
export const DERIVED_SPEC_MERGED_TRIGGER = "(derived) spec-merged-no-tests";
export const DERIVED_SPEC_DRIFT_TRIGGER = "(derived) spec-manifest-drift";

export interface SpecReadyFact {
  storyId: string;
  /** Source issue number (labels/comments target); null when unknown. */
  sourceIssue: number | null;
  title: string;
  specParses: boolean;
  invariantsNonEmpty: boolean;
  manifestExists: boolean;
  /** The spec's content hash no longer matches the one the manifest was
   *  recorded against (D10) — the tests certify a spec that no longer
   *  exists. False when either hash is unknown (pre-drift manifests). */
  specDrifted: boolean;
  /** An open slowcook/tests PR already covers this story. */
  openTestsPr: boolean;
  /** #536 — the story already SHIPPED (source issue closed or
   *  agent:brewed). Post-ship drift means the RECORD is stale, not the
   *  tests: regeneration would rewrite a sanctioned merged suite. The
   *  wrapper populates this only for drifted facts (one API call each);
   *  absent = false. */
  storyShipped?: boolean;
}

export function deriveRecipeJobs(facts: SpecReadyFact[]): WorkerJob[] {
  const jobs: WorkerJob[] = [];
  for (const f of facts) {
    if (!f.specParses || !f.invariantsNonEmpty) continue; // not recipe-ready
    if (f.openTestsPr) continue; // revision already in flight
    // Tests exist AND still certify the current spec — nothing to do.
    // A drifted manifest (D10) is a regeneration job: the tests certify
    // a spec that no longer exists.
    if (f.manifestExists && !f.specDrifted) continue;
    if (f.sourceIssue === null) continue; // nowhere to report — skip, visible in workload
    const drift = f.manifestExists && f.specDrifted;
    // #536 — drift on a SHIPPED story parks for the PM instead of
    // regenerating: the first cheap-model-season pass regenerated tests
    // for story-019 (shipped weeks earlier) off a stale manifest hash.
    // The fix is a manifest re-record or a PM ruling, never testgen.
    if (drift && f.storyShipped) {
      jobs.push({
        issue: f.sourceIssue,
        issueTitle: f.title,
        agent: "recipe",
        triggerLabel: DERIVED_SPEC_DRIFT_TRIGGER,
        storyId: f.storyId,
        cmd: ["slowcook", "recipe", "--spec", f.storyId],
        preconditions: [
          {
            name: "drift-on-shipped-story",
            status: "fail",
            detail:
              `story-${f.storyId}: manifest spec-hash drift, but the story already shipped — ` +
              `the record is stale, not the tests. Re-record the manifest ` +
              `(slowcook manifest record --story ${f.storyId}) or rule on the spec change; ` +
              `regeneration is refused.`,
          },
        ],
        runnable: false,
        priority: 10,
      });
      continue;
    }
    jobs.push({
      issue: f.sourceIssue,
      issueTitle: f.title,
      agent: "recipe",
      triggerLabel: drift ? DERIVED_SPEC_DRIFT_TRIGGER : DERIVED_SPEC_MERGED_TRIGGER,
      storyId: f.storyId,
      cmd: ["slowcook", "recipe", "--spec", f.storyId],
      preconditions: [
        drift
          ? {
              name: "spec-manifest-drift",
              status: "pass",
              detail: `spec story-${f.storyId} changed since its tests were recorded (content hash mismatch) — regenerate tests against the current spec`,
            }
          : {
              name: "spec-merged-no-tests",
              status: "pass",
              detail: `spec story-${f.storyId} parses with invariants; no manifest, no open tests PR`,
            },
      ],
      runnable: true,
      priority: 10, // after unblocks/resubmits, before fresh label triggers
    });
  }
  return jobs;
}

/**
 * W2-brew: a story with a merged spec AND a recorded manifest AND no brew
 * PR (open or done) asks for brew — the implementation stage. Real spend:
 * enabled only when the operator's --enable includes brew ("go brew",
 * 2026-08-21). Guards: source issue must not already carry agent:brewed /
 * agent:failed (checked by the wrapper), and an open slowcook/brew branch
 * for the story suppresses the job (the re-fire guard).
 */
export const DERIVED_BREW_READY_TRIGGER = "(derived) tests-merged-no-impl";

export interface BrewReadyFact {
  storyId: string;
  sourceIssue: number | null;
  title: string;
  manifestExists: boolean;
  specParses: boolean;
  /** An open slowcook/brew PR already covers this story. */
  openBrewPr: boolean;
  /** An open tests PR is REVISING this story's tests — the manifest on
   *  main is contested; brewing against it builds to a stale contract
   *  (eleven-defects D12, caught by the first `slowcook workload` run). */
  openTestsPr: boolean;
  /** The spec changed since the tests were recorded (D10) — brewing
   *  would implement a spec the frozen tests don't certify. */
  specDrifted: boolean;
  /** Source issue already carries agent:brewed or agent:failed. */
  issueSettled: boolean;
}

export function deriveBrewJobs(facts: BrewReadyFact[]): WorkerJob[] {
  const jobs: WorkerJob[] = [];
  for (const f of facts) {
    if (!f.manifestExists || !f.specParses) continue;
    if (f.openBrewPr || f.issueSettled) continue;
    if (f.sourceIssue === null) continue;
    const testsContested = f.openTestsPr || f.specDrifted;
    jobs.push({
      issue: f.sourceIssue,
      issueTitle: f.title,
      agent: "brew",
      triggerLabel: DERIVED_BREW_READY_TRIGGER,
      storyId: f.storyId,
      cmd: ["slowcook", "brew", "--story", f.storyId, "--budget-usd", "10"],
      preconditions: [
        testsContested
          ? {
              name: "tests-settled",
              status: "fail" as const,
              upstream: f.specDrifted ? "recipe" : "taste",
              detail: f.specDrifted
                ? `story-${f.storyId}: the spec changed since its tests were recorded (content-hash drift) — recipe must regenerate before brew implements`
                : `story-${f.storyId}: an open tests PR is revising this story's tests — the manifest on main is contested; brew waits for the review loop to settle`,
            }
          : {
              name: "tests-merged-no-impl",
              status: "pass" as const,
              detail: `story-${f.storyId}: spec + manifest on main, no brew PR, no open tests PR, issue unsettled`,
            },
      ],
      runnable: !testsContested,
      priority: 15, // after reviews (5) and recipe (10); before fresh label triggers
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
