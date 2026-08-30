import { describe, it, expect } from "vitest";
import {
  deriveJobs,
  deriveClarifyAnsweredJobs,
  DERIVED_CLARIFY_ANSWERED_TRIGGER,
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
