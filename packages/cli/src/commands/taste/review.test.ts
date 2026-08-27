import { describe, it, expect } from "vitest";
import { parseTasteVerdict, renderReviewBody, buildTastePrompt } from "./review.js";

describe("parseTasteVerdict", () => {
  it("parses a clean approve", () => {
    const v = parseTasteVerdict(
      '{"verdict":"approve","summary":"Covers all invariants.","findings":[{"severity":"nit","note":"naming"}]}'
    );
    expect(v!.verdict).toBe("approve");
    expect(v!.findings).toHaveLength(1);
  });

  it("a blocking finding can never ride an approve", () => {
    const v = parseTasteVerdict(
      '{"verdict":"approve","summary":"looks ok","findings":[{"severity":"blocking","note":"invariant 3 untested"}]}'
    );
    expect(v!.verdict).toBe("request_changes");
  });

  it("unparseable output is null — the caller fails closed", () => {
    expect(parseTasteVerdict("I think this looks fine!")).toBeNull();
    expect(parseTasteVerdict('{"verdict":"maybe"}')).toBeNull();
  });

  it("tolerates fenced json and prose around it", () => {
    const v = parseTasteVerdict(
      'Here is my review:\n```json\n{"verdict":"request_changes","summary":"gap","findings":[]}\n```\nThanks!'
    );
    expect(v!.verdict).toBe("request_changes");
  });
});

describe("renderReviewBody", () => {
  const v = {
    verdict: "approve" as const,
    summary: "All invariants covered.",
    findings: [{ severity: "nit" as const, note: "prefer describe blocks" }],
  };
  it("shows merged state and findings", () => {
    const body = renderReviewBody(v, { header: "**slowcook-taste** · PR #221", merged: true, mergeAuthority: true });
    expect(body).toContain("approve");
    expect(body).toContain("merged");
    expect(body).toContain("💅");
  });
  it("says when merge was left to a human", () => {
    const body = renderReviewBody(v, { header: "h", merged: false, mergeAuthority: false });
    expect(body).toContain("merge left to a human");
  });
});

describe("buildTastePrompt", () => {
  it("tests-PR prompts judge coverage against the spec; spec prompts judge issue fidelity", () => {
    const base = {
      prNumber: 221,
      prTitle: "tests: story-019",
      prBody: "",
      headBranch: "slowcook/tests/story-019",
      storyId: "019",
      diff: "diff",
      specYaml: "invariants: []",
      sourceIssueTitle: "#215 dedupe",
      sourceIssueBody: "body",
      issueThread: "@pm: 1. b",
      prThread: "@aminazar: ruling — option 2 stands",
      manifestJson: null,
    };
    expect(buildTastePrompt({ ...base, kind: "tests" as const }).system).toContain("invariant with no test");
    expect(buildTastePrompt({ ...base, kind: "spec" as const }).system).toContain("source issue");
    const user = buildTastePrompt({ ...base, kind: "tests" as const }).user;
    expect(user).toContain("#215 dedupe");
    expect(user).toContain("PM Q&A");
    expect(user).toContain("PR discussion thread");
    expect(user).toContain("ruling — option 2 stands");
    expect(buildTastePrompt({ ...base, prThread: null, kind: "spec" as const }).user).not.toContain(
      "PR discussion thread"
    );
    const brew = buildTastePrompt({
      ...base,
      kind: "brew" as const,
      headBranch: "slowcook/brew/story-019",
      manifestJson: '{"tests":["tests/integration/story-019.test.ts > merges"]}',
    });
    expect(brew.system).toContain("TEST TAMPERING");
    expect(brew.system).toContain("ADVISORY");
    expect(brew.user).toContain("frozen contract");
  });
});

describe("PR-D (2026-08-23): present-vs-history evidence", () => {
  const base = {
    prNumber: 9,
    prTitle: "t",
    prBody: "",
    headBranch: "slowcook/brew/story-016",
    kind: "brew" as const,
    storyId: "016",
    diff: "diff --git a/x b/x",
    specYaml: null,
    sourceIssueTitle: null,
    sourceIssueBody: null,
    issueThread: null,
    prThread: null,
    manifestJson: null,
    headFiles: null,
    commitSubjects: null,
    constitution: "",
    analyzeFindings: "",
  };

  it("renders current head files as authoritative over thread claims", () => {
    const { user } = buildTastePrompt({
      ...base,
      headFiles: [{ path: "tests/integration/story-016.test.ts", content: "it('x')" }],
    });
    expect(user).toContain("Current state of key files at the PR head");
    expect(user).toContain("authoritative over any historical claims");
    expect(user).toContain("tests/integration/story-016.test.ts");
  });

  it("renders commit subjects so arbitration commits are visible", () => {
    const { user } = buildTastePrompt({
      ...base,
      commitSubjects: ["fix(human gate): byline column", "brew iter 3"],
      constitution: "",
      analyzeFindings: "",
    });
    expect(user).toContain("Commits on this PR branch");
    expect(user).toContain("fix(human gate): byline column");
  });

  it("system prompt carries the history-is-history rule for every kind", () => {
    for (const kind of ["spec", "tests", "brew"] as const) {
      const { system } = buildTastePrompt({ ...base, kind });
      expect(system).toContain("The PR thread and any errors it mentions are HISTORY");
      expect(system).toContain("NEVER report a defect as current");
    }
  });

  it("brew tampering rule carries the PM-arbitration exception", () => {
    const { system } = buildTastePrompt(base);
    expect(system).toContain("PM arbitration");
    expect(system).toContain("AUTHORIZED");
    expect(system).toContain("faithfully implement the recorded ruling");
  });

  it("omits the sections cleanly when absent", () => {
    const { user } = buildTastePrompt(base);
    expect(user).not.toContain("Current state of key files");
    expect(user).not.toContain("Commits on this PR branch");
  });
});

describe("mock-boundary review dimension (2026-08-24)", () => {
  it("tests-kind prompts carry the mocked-seam and fixture-shape rules", () => {
    const { system } = buildTastePrompt({
      prNumber: 1,
      prTitle: "t",
      prBody: "",
      headBranch: "slowcook/tests/story-020",
      kind: "tests",
      storyId: "020",
      diff: "",
      specYaml: null,
      sourceIssueTitle: null,
      sourceIssueBody: null,
      issueThread: null,
      prThread: null,
      manifestJson: null,
      headFiles: null,
      commitSubjects: null,
      constitution: "",
      analyzeFindings: "",
    });
    expect(system).toContain("ARCHITECTURAL CLAIM");
    expect(system).toContain("service-role (admin) client");
    expect(system).toContain("ARRAYS for multi-row selects");
  });
});
