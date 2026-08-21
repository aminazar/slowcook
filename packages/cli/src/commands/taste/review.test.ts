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
    expect(brew.system).toContain("TEST TAMPERING IS ALWAYS BLOCKING");
    expect(brew.system).toContain("ADVISORY");
    expect(brew.user).toContain("frozen contract");
  });
});
