import { describe, it, expect } from "vitest";
import {
  deriveJobs,
  deriveClarifyAnsweredJobs,
  DERIVED_CLARIFY_ANSWERED_TRIGGER,
  deriveBrewJobs,
  deriveBrewHaltParks,
  deriveSplitDecidedJobs,
  DERIVED_SPLIT_DECIDED_TRIGGER,
  brewHaltGate,
  renderHaltChoiceComment,
  DERIVED_BREW_READY_TRIGGER,
  DERIVED_PM_REBREW_TRIGGER,
  DERIVED_HALT_ANSWERED_TRIGGER,
  type BrewReadyFact,
  type BrewHaltGate,
  evaluatePreconditions,
  summarizeWorkload,
  renderWorkloadLine,
  type IssueFact,
  type StoryArtifactFacts,
} from "./plan.js";

function issue(over: Partial<IssueFact> & { number: number }): IssueFact {
  return {
    title: `Issue ${over.number}`,
    body: "a body",
    labels: [],
    createdAt: "2026-08-01T00:00:00Z",
    ...over,
  };
}

const noFacts = (): StoryArtifactFacts => ({});

describe("deriveJobs", () => {
  it("maps each trigger label to its agent and cmd", () => {
    const jobs = deriveJobs(
      [issue({ number: 7, labels: ["agent:refine"] })],
      noFacts
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.agent).toBe("refine");
    expect(jobs[0]!.cmd).toEqual(["slowcook", "refine", "--issue", "7"]);
  });

  it("ignores issues with no trigger label", () => {
    const jobs = deriveJobs([issue({ number: 1, labels: ["bug"] })], noFacts);
    expect(jobs).toHaveLength(0);
  });

  it("agent:failed is terminal — no jobs even with a trigger present", () => {
    const jobs = deriveJobs(
      [issue({ number: 2, labels: ["agent:refine", "agent:failed"] })],
      noFacts
    );
    expect(jobs).toHaveLength(0);
  });

  it("an issue with two trigger labels yields two jobs", () => {
    const jobs = deriveJobs(
      [issue({ number: 3, labels: ["agent:refine", "agent:brew"] })],
      () => ({ storyId: "003" })
    );
    expect(jobs.map((j) => j.agent).sort()).toEqual(["brew", "refine"]);
  });

  it("uses the resolved storyId in recipe/brew/eye cmds", () => {
    const jobs = deriveJobs(
      [issue({ number: 4, labels: ["agent:brew"] })],
      () => ({ storyId: "021", manifestExists: true, testsDiscoverable: true })
    );
    expect(jobs[0]!.cmd).toEqual(["slowcook", "brew", "--story", "021"]);
  });

  it("orders blocked jobs before runnable ones (unblock before advance)", () => {
    const jobs = deriveJobs(
      [
        issue({ number: 10, labels: ["agent:refine"], createdAt: "2026-08-01T00:00:00Z" }),
        issue({ number: 11, labels: ["agent:refine"], body: "", createdAt: "2026-08-02T00:00:00Z" }),
      ],
      noFacts
    );
    expect(jobs[0]!.issue).toBe(11); // blocked (empty body) surfaces first
    expect(jobs[0]!.runnable).toBe(false);
    expect(jobs[1]!.issue).toBe(10);
  });

  it("orders by priority label, then oldest first", () => {
    const jobs = deriveJobs(
      [
        issue({ number: 20, labels: ["agent:refine"], createdAt: "2026-08-01T00:00:00Z" }),
        issue({ number: 21, labels: ["agent:refine", "priority:1"], createdAt: "2026-08-05T00:00:00Z" }),
        issue({ number: 22, labels: ["agent:refine"], createdAt: "2026-07-01T00:00:00Z" }),
      ],
      noFacts
    );
    expect(jobs.map((j) => j.issue)).toEqual([21, 22, 20]);
  });
});

describe("deriveResubmitJobs", () => {
  const pr = (over: Partial<import("./plan.js").AgentPrFact>) => ({
    prNumber: 218,
    headBranch: "slowcook/spec/story-019",
    title: "spec: story-019",
    lastCommitAt: "2026-08-20T13:35:00Z",
    lastHumanReviewAt: null as string | null,
    lastAnyReviewAt: null as string | null,
    submittedReviewCount: 0,
    ...over,
  });

  it("a review newer than the last commit yields a refine --pr job (spec PR)", () => {
    const jobs = require_deriveResubmit([
      pr({ lastAnyReviewAt: "2026-08-20T14:00:00Z", submittedReviewCount: 1 }),
    ]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.cmd).toEqual(["slowcook", "refine", "--pr", "218"]);
    expect(jobs[0]!.agent).toBe("refine");
  });

  it("a tests PR routes to recipe — the artifact's owner answers", () => {
    const jobs = require_deriveResubmit([
      pr({
        prNumber: 223,
        headBranch: "slowcook/tests/story-021",
        lastAnyReviewAt: "2026-08-20T14:00:00Z",
        submittedReviewCount: 1,
      }),
    ]);
    expect(jobs[0]!.agent).toBe("recipe");
    expect(jobs[0]!.cmd).toEqual(["slowcook", "recipe", "--pr", "223"]);
  });

  it("a review older than the last commit is already answered — no job", () => {
    expect(
      require_deriveResubmit([
        pr({ lastAnyReviewAt: "2026-08-20T13:00:00Z", submittedReviewCount: 1 }),
      ])
    ).toHaveLength(0);
  });

  it("no review, no job; past MAX_REVIEW_ROUNDS the PM arbitrates", () => {
    expect(require_deriveResubmit([pr({})])).toHaveLength(0);
    expect(
      require_deriveResubmit([
        pr({ lastAnyReviewAt: "2026-08-20T14:00:00Z", submittedReviewCount: 4 }),
      ])
    ).toHaveLength(0);
  });
});

import { deriveResubmitJobs as require_deriveResubmit } from "./plan.js";

describe("evaluatePreconditions", () => {
  it("refine fails on an empty issue body, with no upstream (operator-owned)", () => {
    const checks = evaluatePreconditions("refine", issue({ number: 5, body: "  " }), {});
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("fail");
    expect(checks[0]!.upstream).toBeUndefined();
  });

  it("recipe with no story in the index names refine as the upstream", () => {
    const checks = evaluatePreconditions("recipe", issue({ number: 6 }), {});
    const specExists = checks.find((c) => c.name === "spec-exists")!;
    expect(specExists.status).toBe("fail");
    expect(specExists.upstream).toBe("refine");
    expect(specExists.detail).toContain("#6");
  });

  it("recipe passes when the spec parses and has invariants", () => {
    const checks = evaluatePreconditions("recipe", issue({ number: 6 }), {
      storyId: "006",
      specParses: true,
      invariantsNonEmpty: true,
    });
    expect(checks.every((c) => c.status === "pass")).toBe(true);
  });

  it("brew names recipe as upstream for a missing manifest", () => {
    const checks = evaluatePreconditions("brew", issue({ number: 8 }), {
      storyId: "008",
      manifestExists: false,
    });
    const m = checks.find((c) => c.name === "manifest-exists")!;
    expect(m.status).toBe("fail");
    expect(m.upstream).toBe("recipe");
  });

  it("ungathered facts are unknown, never pass", () => {
    const checks = evaluatePreconditions("brew", issue({ number: 9 }), { storyId: "009" });
    const m = checks.find((c) => c.name === "manifest-exists")!;
    expect(m.status).toBe("unknown");
    expect(m.detail).toContain("not gathered");
  });

  it("eye's build/deploy checks are unknown in W0 and say why", () => {
    const checks = evaluatePreconditions("eye", issue({ number: 12 }), { storyId: "012" });
    expect(checks.map((c) => c.status)).toEqual(["unknown", "unknown"]);
  });
});

describe("workload summary", () => {
  it("counts scanned issues, triggers, blocked, and failed-awaiting-human", () => {
    const issues = [
      issue({ number: 1, labels: ["agent:refine"] }),
      issue({ number: 2, labels: ["agent:refine"], body: "" }),
      issue({ number: 3, labels: ["agent:failed"] }),
    ];
    const jobs = deriveJobs(issues, noFacts);
    const s = summarizeWorkload(issues, jobs);
    expect(s.issuesScanned).toBe(3);
    expect(s.triggersFound).toBe(2);
    expect(s.failedAwaitingHuman).toEqual([3]);
    const line = renderWorkloadLine(s);
    expect(line).toContain("3 issues scanned");
    expect(line).toContain("2 triggers");
    expect(line).toContain("1 blocked");
    expect(line).toContain("1 agent:failed");
  });
});

import { deriveRecipeJobs } from "./plan.js";

describe("deriveRecipeJobs (W2)", () => {
  const fact = (over: Partial<import("./plan.js").SpecReadyFact>) => ({
    storyId: "019",
    sourceIssue: 215,
    title: "Crawler dedupe",
    specParses: true,
    invariantsNonEmpty: true,
    manifestExists: false,
    openTestsPr: false,
    ...over,
  });

  it("a merged spec with no tests yields a recipe job on the source issue", () => {
    const jobs = deriveRecipeJobs([fact({})]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.cmd).toEqual(["slowcook", "recipe", "--spec", "019"]);
    expect(jobs[0]!.issue).toBe(215);
    expect(jobs[0]!.agent).toBe("recipe");
  });

  it("an existing manifest or open tests PR suppresses the job", () => {
    expect(deriveRecipeJobs([fact({ manifestExists: true })])).toHaveLength(0);
    expect(deriveRecipeJobs([fact({ openTestsPr: true })])).toHaveLength(0);
  });

  it("an unparseable spec or empty invariants is not recipe-ready", () => {
    expect(deriveRecipeJobs([fact({ specParses: false })])).toHaveLength(0);
    expect(deriveRecipeJobs([fact({ invariantsNonEmpty: false })])).toHaveLength(0);
  });

  it("no source issue = nowhere to report — skipped", () => {
    expect(deriveRecipeJobs([fact({ sourceIssue: null })])).toHaveLength(0);
  });
});

import { deriveTasteJobs } from "./plan.js";

describe("deriveTasteJobs (reviewer stage)", () => {
  const pr = (over: Partial<import("./plan.js").AgentPrFact>) => ({
    prNumber: 221,
    headBranch: "slowcook/tests/story-019",
    title: "tests: story-019",
    lastCommitAt: "2026-08-20T17:00:00Z",
    lastHumanReviewAt: null as string | null,
    lastAnyReviewAt: null as string | null,
    submittedReviewCount: 0,
    ...over,
  });

  it("past MAX_REVIEW_ROUNDS taste stands down", () => {
    const jobs = deriveTasteJobs([
      pr({ submittedReviewCount: 4, lastAnyReviewAt: "2026-08-20T16:00:00Z" }),
    ]);
    expect(jobs).toHaveLength(0);
  });

  it("an unreviewed agent PR yields a taste job with merge authority", () => {
    const jobs = deriveTasteJobs([pr({})]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.cmd).toEqual(["slowcook", "taste", "--pr", "221", "--merge"]);
    expect(jobs[0]!.agent).toBe("taste");
  });

  it("amended-since-review re-tastes", () => {
    const jobs = deriveTasteJobs([
      pr({ lastAnyReviewAt: "2026-08-20T16:00:00Z", lastCommitAt: "2026-08-20T17:00:00Z" }),
    ]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.preconditions[0]!.detail).toContain("amended since");
  });

  it("a review newer than the code suppresses taste", () => {
    expect(
      deriveTasteJobs([pr({ lastAnyReviewAt: "2026-08-20T18:00:00Z" })])
    ).toHaveLength(0);
  });

  it("a fresh HUMAN review belongs to the author agent, never taste", () => {
    expect(
      deriveTasteJobs([
        pr({ lastHumanReviewAt: "2026-08-20T18:00:00Z", lastAnyReviewAt: "2026-08-20T18:00:00Z" }),
      ])
    ).toHaveLength(0);
  });

  it("non-agent branches are not taste's business", () => {
    expect(deriveTasteJobs([pr({ headBranch: "feature/foo" })])).toHaveLength(0);
  });

  it("brew (code) PRs derive an advisory taste job (D8)", () => {
    const jobs = deriveTasteJobs([pr({ headBranch: "slowcook/brew/story-019" })]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.cmd).toContain("taste");
  });
});

import { deriveBrewJobs, deriveRecipeJobs } from "./plan.js";

describe("deriveBrewJobs (W2-brew)", () => {
  const fact = (over: Partial<import("./plan.js").BrewReadyFact>) => ({
    storyId: "019",
    sourceIssue: 215,
    title: "Crawler dedupe",
    manifestExists: true,
    specParses: true,
    openBrewPr: false,
    openTestsPr: false,
    specDrifted: false,
    issueSettled: false,
    ...over,
  });

  it("spec+manifest with no impl yields a budget-capped brew job", () => {
    const jobs = deriveBrewJobs([fact({})]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.cmd).toEqual(["slowcook", "brew", "--story", "019", "--budget-usd", "10"]);
    expect(jobs[0]!.agent).toBe("brew");
  });

  it("an open brew PR or a settled issue suppresses the job", () => {
    expect(deriveBrewJobs([fact({ openBrewPr: true })])).toHaveLength(0);
    expect(deriveBrewJobs([fact({ issueSettled: true })])).toHaveLength(0);
  });

  it("no manifest = not brew-ready", () => {
    expect(deriveBrewJobs([fact({ manifestExists: false })])).toHaveLength(0);
  });

  it("spec drift blocks brew (upstream: recipe) and derives regeneration (D10)", () => {
    const bjobs = deriveBrewJobs([fact({ specDrifted: true })]);
    expect(bjobs[0]!.runnable).toBe(false);
    expect(bjobs[0]!.preconditions[0]!.upstream).toBe("recipe");
    const sf = {
      storyId: "020",
      sourceIssue: 216,
      title: "taxonomy",
      specParses: true,
      invariantsNonEmpty: true,
      manifestExists: true,
      specDrifted: true,
      openTestsPr: false,
    };
    const rjobs = deriveRecipeJobs([sf]);
    expect(rjobs).toHaveLength(1);
    expect(rjobs[0]!.preconditions[0]!.name).toBe("spec-manifest-drift");
    expect(deriveRecipeJobs([{ ...sf, specDrifted: false }])).toHaveLength(0);
  });

  it("an open tests PR contests the manifest — job derived but BLOCKED on taste (D12)", () => {
    const jobs = deriveBrewJobs([fact({ openTestsPr: true })]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.runnable).toBe(false);
    const pre = jobs[0]!.preconditions[0]!;
    expect(pre.name).toBe("tests-settled");
    expect(pre.status).toBe("fail");
    expect(pre.upstream).toBe("taste");
  });
});

describe("#536 — drift on shipped stories parks for the PM", () => {
  const base = {
    storyId: "019",
    sourceIssue: 215,
    title: "story 019",
    specParses: true,
    invariantsNonEmpty: true,
    manifestExists: true,
    specDrifted: true,
    openTestsPr: false,
  };

  it("drift + shipped → non-runnable job naming manifest re-record, never testgen", () => {
    const jobs = deriveRecipeJobs([{ ...base, storyShipped: true }]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.runnable).toBe(false);
    expect(jobs[0]!.preconditions[0]!.name).toBe("drift-on-shipped-story");
    expect(jobs[0]!.preconditions[0]!.detail).toContain("manifest record --story 019");
  });

  it("drift + NOT shipped → the regeneration path stays runnable (D10 unchanged)", () => {
    const jobs = deriveRecipeJobs([{ ...base, storyShipped: false }]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.runnable).toBe(true);
    expect(jobs[0]!.preconditions[0]!.name).toBe("spec-manifest-drift");
  });

  it("absent storyShipped (fs-only callers) behaves as not-shipped", () => {
    const jobs = deriveRecipeJobs([base]);
    expect(jobs[0]!.runnable).toBe(true);
  });
});

describe("deriveClarifyAnsweredJobs (#554 — an answered 👍 re-derives the job)", () => {
  const parked = (number: number, extra: string[] = []) =>
    issue({ number, labels: ["needs-refinement", "slowcook-awaiting-pm", ...extra] });

  it("derives one refine job per answered park, with the derived trigger", () => {
    const jobs = deriveClarifyAnsweredJobs([parked(292)], noFacts);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.agent).toBe("refine");
    expect(jobs[0]!.triggerLabel).toBe(DERIVED_CLARIFY_ANSWERED_TRIGGER);
    expect(jobs[0]!.cmd).toEqual(["slowcook", "refine", "--issue", "292"]);
    expect(jobs[0]!.runnable).toBe(true);
  });

  it("skips issues the labeled trigger already owns", () => {
    expect(
      deriveClarifyAnsweredJobs([parked(292, ["agent:refine"])], noFacts)
    ).toHaveLength(0);
  });

  it("agent:failed stays terminal even when the PM has answered", () => {
    expect(
      deriveClarifyAnsweredJobs([parked(292, ["agent:failed"])], noFacts)
    ).toHaveLength(0);
  });

  it("carries the resolved story id into the job", () => {
    const jobs = deriveClarifyAnsweredJobs([parked(292)], () => ({ storyId: "024" }));
    expect(jobs[0]!.storyId).toBe("024");
  });
});

describe("#556 — brew halts are derivation state", () => {
  const halt = (created_at: string, over: Partial<{ kind: string; checkpoints: number; model: string }> = {}) => ({
    id: 1,
    body:
      `### slowcook · brew halted — \`${over.kind ?? "ITERATION_CAP"}\`\n\nstuff\n\n` +
      `<!-- slowcook:cost agent=brew usd=1.00 iterations=10 checkpoints=${over.checkpoints ?? 2} model=${over.model ?? "claude-haiku-4-5"} halted=${over.kind ?? "ITERATION_CAP"} -->`,
    created_at,
  });
  const human = (created_at: string, body: string) => ({ id: 2, body, created_at });
  const agentNote = (created_at: string) => ({
    id: 3,
    body: "### slowcook · tests opened\n\nPR #295",
    created_at,
  });

  const fact = (gate: BrewHaltGate | null, over: Partial<BrewReadyFact> = {}): BrewReadyFact => ({
    storyId: "023",
    sourceIssue: 285,
    title: "React from the feed",
    manifestExists: true,
    specParses: true,
    openBrewPr: false,
    openTestsPr: false,
    specDrifted: false,
    issueSettled: false,
    haltGate: gate,
    ...over,
  });

  it("parses the gate from halt cost-markers, newest halt wins", () => {
    const g = brewHaltGate([
      halt("2026-08-28T23:00:00Z", { model: "claude-haiku-4-5" }),
      halt("2026-08-29T01:00:00Z", { kind: "BUDGET_EXHAUSTED", checkpoints: 0, model: "claude-sonnet-5" }),
    ])!;
    expect(g.haltKind).toBe("BUDGET_EXHAUSTED");
    expect(g.checkpoints).toBe(0);
    expect(g.haltCount).toBe(2);
    expect(g.models).toEqual(["claude-haiku-4-5", "claude-sonnet-5"]);
    expect(g.humanTurn).toBe(false);
  });

  it("no halts → null gate → plain derivation unchanged", () => {
    expect(brewHaltGate([agentNote("2026-08-28T23:00:00Z")])).toBeNull();
    const jobs = deriveBrewJobs([fact(null)]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.triggerLabel).toBe(DERIVED_BREW_READY_TRIGGER);
  });

  it("a terminal halt with no human word derives NO job — it parks", () => {
    const g = brewHaltGate([halt("2026-08-29T01:00:00Z")])!;
    expect(deriveBrewJobs([fact(g)])).toHaveLength(0);
    const parks = deriveBrewHaltParks([fact(g)]);
    expect(parks).toHaveLength(1);
    expect(parks[0]!.needsChoiceComment).toBe(true);
  });

  it("an agent comment after the halt does not open the gate", () => {
    const g = brewHaltGate([halt("2026-08-29T01:00:00Z"), agentNote("2026-08-29T12:00:00Z")])!;
    expect(g.humanTurn).toBe(false);
  });

  it("a human comment older than the newest agent comment stays parked (one answer routes one job)", () => {
    const g = brewHaltGate([
      halt("2026-08-29T01:00:00Z"),
      human("2026-08-29T02:00:00Z", "parked, not abandoned"),
      agentNote("2026-08-29T12:00:00Z"),
    ])!;
    expect(g.humanTurn).toBe(false);
  });

  it("rebrew: $8 sonnet derives exactly that brew", () => {
    const g = brewHaltGate([
      halt("2026-08-29T01:00:00Z"),
      human("2026-08-30T10:00:00Z", "rebrew: $8 claude-sonnet-5"),
    ])!;
    expect(g.directive).toEqual({ kind: "rebrew", budgetUsd: 8, model: "claude-sonnet-5" });
    const jobs = deriveBrewJobs([fact(g)]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.triggerLabel).toBe(DERIVED_PM_REBREW_TRIGGER);
    expect(jobs[0]!.cmd).toEqual([
      "slowcook", "brew", "--story", "023", "--budget-usd", "8", "--model", "claude-sonnet-5",
    ]);
  });

  it("split and free text both route to refine", () => {
    for (const reply of ["split", "I think the API slice should land first, then the UI"]) {
      const g = brewHaltGate([halt("2026-08-29T01:00:00Z"), human("2026-08-30T10:00:00Z", reply)])!;
      const jobs = deriveBrewJobs([fact(g)]);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.agent).toBe("refine");
      expect(jobs[0]!.triggerLabel).toBe(DERIVED_HALT_ANSWERED_TRIGGER);
    }
  });

  it("handoff derives nothing and parks for the label", () => {
    const g = brewHaltGate([halt("2026-08-29T01:00:00Z"), human("2026-08-30T10:00:00Z", "handoff")])!;
    expect(deriveBrewJobs([fact(g)])).toHaveLength(0);
    const parks = deriveBrewHaltParks([fact(g)]);
    expect(parks).toHaveLength(1);
    expect(parks[0]!.handoff).toBe(true);
  });

  it("👍 accepts the recommendation: plateau → refine, single checkpointing halt → brew", () => {
    const choice = (haltTs: string) => ({
      id: 9,
      body: `### slowcook · brew halted — your call 🍲\n<!-- slowcook:brew-halt-choice story=023 halt=${haltTs} -->`,
      created_at: "2026-08-30T00:00:00Z",
    });
    const plateau = brewHaltGate([halt("2026-08-29T01:00:00Z", { checkpoints: 0 }), choice("2026-08-29T01:00:00Z")])!;
    const jobsA = deriveBrewJobs([fact(plateau, { thumbsUpOnChoice: true })]);
    expect(jobsA[0]!.agent).toBe("refine");
    const capped = brewHaltGate([halt("2026-08-29T01:00:00Z", { checkpoints: 3 }), choice("2026-08-29T01:00:00Z")])!;
    const jobsB = deriveBrewJobs([fact(capped, { thumbsUpOnChoice: true })]);
    expect(jobsB[0]!.agent).toBe("brew");
  });

  it("human-owned stories derive nothing, park nothing", () => {
    const g = brewHaltGate([halt("2026-08-29T01:00:00Z")])!;
    expect(deriveBrewJobs([fact(g, { humanOwned: true })])).toHaveLength(0);
    expect(deriveBrewHaltParks([fact(g, { humanOwned: true })])).toHaveLength(0);
  });

  it("the choice comment carries the idempotency marker and moves the recommended mark", () => {
    const g = brewHaltGate([halt("2026-08-29T01:00:00Z", { checkpoints: 0 })])!;
    const park = deriveBrewHaltParks([fact(g)])[0]!;
    const body = renderHaltChoiceComment(park, "cc @pm");
    expect(body).toContain("slowcook:brew-halt-choice story=023 halt=2026-08-29T01:00:00Z");
    expect(body).toContain("**split** **(recommended)**");
    expect(body).not.toContain("**rebrew** **(recommended)**");
    const g2 = brewHaltGate([
      halt("2026-08-29T01:00:00Z", { checkpoints: 0 }),
      human("2026-08-29T02:00:00Z", body),
    ])!;
    expect(g2.choicePosted).toBe(true);
    expect(g2.humanTurn).toBe(false); // the choice comment is agent-shaped, not a PM answer
  });
});

describe("#556 fix round — the 👍 is one-shot; split decisions derive", () => {
  const halt = (created_at: string) => ({
    id: 1,
    body:
      "### slowcook · brew halted — `ITERATION_CAP`\n\n" +
      "<!-- slowcook:cost agent=brew usd=1.00 iterations=8 checkpoints=0 model=claude-haiku-4-5 halted=ITERATION_CAP -->",
    created_at,
  });
  const fact = (gate: BrewHaltGate | null, over: Partial<BrewReadyFact> = {}): BrewReadyFact => ({
    storyId: "023",
    sourceIssue: 285,
    title: "React from the feed",
    manifestExists: true,
    specParses: true,
    openBrewPr: false,
    openTestsPr: false,
    specDrifted: false,
    issueSettled: false,
    haltGate: gate,
    ...over,
  });
  const choiceBody = (haltTs: string) =>
    `### slowcook · brew halted — your call 🍲\n<!-- slowcook:brew-halt-choice story=023 halt=${haltTs} -->\noptions`;

  it("an agent response after the choice comment consumes the standing 👍 — no re-derive loop", () => {
    const ts = "2026-08-29T01:00:00Z";
    const answered = brewHaltGate([
      halt(ts),
      { id: 2, body: choiceBody(ts), created_at: "2026-09-01T09:00:00Z" },
      { id: 3, body: "### slowcook · overlap detected\n\nstuff", created_at: "2026-09-01T11:52:00Z" },
    ])!;
    expect(answered.choiceAwaitsAnswer).toBe(false);
    expect(deriveBrewJobs([fact(answered, { thumbsUpOnChoice: true })])).toHaveLength(0);
    const fresh = brewHaltGate([
      halt(ts),
      { id: 2, body: choiceBody(ts), created_at: "2026-09-01T09:00:00Z" },
    ])!;
    expect(fresh.choiceAwaitsAnswer).toBe(true);
    expect(deriveBrewJobs([fact(fresh, { thumbsUpOnChoice: true })])).toHaveLength(1);
  });

  it("deriveSplitDecidedJobs routes decided proposals to refine, skips owned/terminal issues", () => {
    const jobs = deriveSplitDecidedJobs(
      [issue({ number: 285, labels: ["slowcook-multifurcation-proposed"] })],
      () => ({ storyId: "023" })
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.agent).toBe("refine");
    expect(jobs[0]!.triggerLabel).toBe(DERIVED_SPLIT_DECIDED_TRIGGER);
    expect(
      deriveSplitDecidedJobs(
        [issue({ number: 285, labels: ["slowcook-multifurcation-proposed", "agent:refine"] })],
        noFacts
      )
    ).toHaveLength(0);
    expect(
      deriveSplitDecidedJobs(
        [issue({ number: 285, labels: ["slowcook-multifurcation-proposed", "agent:failed"] })],
        noFacts
      )
    ).toHaveLength(0);
  });
});
