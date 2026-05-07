import { describe, it, expect } from "vitest";
import {
  assessProposal,
  matchesScope,
  filterProposalsByScope,
  rankProposals,
} from "./score.js";
import type { RefactorProposal } from "./types.js";

const mk = (over: Partial<RefactorProposal>): RefactorProposal => ({
  id: "p",
  title: "t",
  rationale: "r",
  filesAffected: ["src/foo.ts"],
  estimatedLocDelta: 10,
  estimatedValueScore: 5,
  ...over,
});

describe("assessProposal", () => {
  it("computes cost = |loc| * files", () => {
    const a = assessProposal(mk({ estimatedLocDelta: 20, filesAffected: ["a", "b", "c"] }));
    expect(a.costScore).toBe(60);
  });

  it("clamps cost ≥ 1 so benefitPerCost is finite", () => {
    const a = assessProposal(mk({ estimatedLocDelta: 0, filesAffected: ["a"] }));
    expect(a.costScore).toBe(1);
    expect(a.benefitPerCost).toBe(5);
  });

  it("benefit = estimatedValueScore as-is", () => {
    const a = assessProposal(mk({ estimatedValueScore: 8 }));
    expect(a.benefitScore).toBe(8);
  });

  it("treats negative LOC delta the same as positive (abs)", () => {
    const a = assessProposal(mk({ estimatedLocDelta: -50, filesAffected: ["a", "b"] }));
    expect(a.costScore).toBe(100);
  });

  it("benefitPerCost = benefit / cost", () => {
    const a = assessProposal(mk({ estimatedLocDelta: 10, filesAffected: ["a"], estimatedValueScore: 8 }));
    expect(a.benefitPerCost).toBe(0.8);
  });

  it("zero files still produces cost ≥ 1", () => {
    const a = assessProposal(mk({ filesAffected: [], estimatedLocDelta: 5 }));
    expect(a.costScore).toBe(5); // |5| * max(1, 0) = 5
  });
});

describe("matchesScope", () => {
  it("exact match", () => {
    expect(matchesScope("src/foo.ts", "src/foo.ts")).toBe(true);
  });

  it("directory prefix with trailing slash", () => {
    expect(matchesScope("src/components/X.tsx", "src/")).toBe(true);
    expect(matchesScope("tests/integration/x.ts", "src/")).toBe(false);
  });

  it("single-star one segment", () => {
    expect(matchesScope("src/components/Foo.tsx", "src/components/*")).toBe(true);
    expect(matchesScope("src/components/members/Foo.tsx", "src/components/*")).toBe(false);
    expect(matchesScope("src/lib/foo.ts", "src/components/*")).toBe(false);
  });

  it("double-star any depth", () => {
    expect(matchesScope("src/components/members/Foo.tsx", "src/**")).toBe(true);
    expect(matchesScope("src/foo.ts", "src/**")).toBe(true);
    expect(matchesScope("tests/integration/x.ts", "src/**")).toBe(false);
  });

  it("rejects unsupported patterns gracefully", () => {
    // Star in the middle isn't supported in α.7 — returns false
    expect(matchesScope("src/foo/bar.ts", "src/*/bar.ts")).toBe(false);
  });
});

describe("filterProposalsByScope", () => {
  it("returns all proposals when scope is empty", () => {
    const ps = [mk({ id: "a" }), mk({ id: "b" })];
    expect(filterProposalsByScope(ps, []).map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("excludes proposals with ANY out-of-scope file (boundedness)", () => {
    const ps = [
      mk({ id: "in-scope", filesAffected: ["src/a.ts", "src/b.ts"] }),
      mk({ id: "mixed", filesAffected: ["src/a.ts", "tests/x.ts"] }),
      mk({ id: "out", filesAffected: ["tests/x.ts"] }),
    ];
    const filtered = filterProposalsByScope(ps, ["src/**"]);
    expect(filtered.map((p) => p.id)).toEqual(["in-scope"]);
  });

  it("respects multiple scope patterns (any-of)", () => {
    const ps = [
      mk({ id: "a", filesAffected: ["src/components/X.tsx"] }),
      mk({ id: "b", filesAffected: ["packages/lib/y.ts"] }),
      mk({ id: "c", filesAffected: ["docs/z.md"] }),
    ];
    const filtered = filterProposalsByScope(ps, ["src/**", "packages/**"]);
    expect(filtered.map((p) => p.id)).toEqual(["a", "b"]);
  });
});

describe("rankProposals", () => {
  it("orders by benefit-per-cost descending", () => {
    const ps = [
      mk({ id: "expensive", estimatedLocDelta: 100, estimatedValueScore: 5 }), // 0.05
      mk({ id: "cheap", estimatedLocDelta: 5, estimatedValueScore: 8 }), // 1.6
      mk({ id: "medium", estimatedLocDelta: 20, estimatedValueScore: 6 }), // 0.3
    ];
    const ranked = rankProposals(ps);
    expect(ranked.map((r) => r.proposal.id)).toEqual(["cheap", "medium", "expensive"]);
  });

  it("is stable for ties", () => {
    const ps = [
      mk({ id: "a", estimatedLocDelta: 10, estimatedValueScore: 5 }),
      mk({ id: "b", estimatedLocDelta: 10, estimatedValueScore: 5 }),
      mk({ id: "c", estimatedLocDelta: 10, estimatedValueScore: 5 }),
    ];
    const ranked = rankProposals(ps);
    expect(ranked.map((r) => r.proposal.id)).toEqual(["a", "b", "c"]);
  });

  it("doesn't mutate input array", () => {
    const ps = [
      mk({ id: "lo", estimatedValueScore: 1 }),
      mk({ id: "hi", estimatedValueScore: 9 }),
    ];
    const before = ps.map((p) => p.id);
    rankProposals(ps);
    expect(ps.map((p) => p.id)).toEqual(before);
  });

  it("attaches the assessment alongside the proposal", () => {
    const ps = [mk({ id: "x", estimatedLocDelta: 10, estimatedValueScore: 8 })];
    const ranked = rankProposals(ps);
    expect(ranked[0]!.proposal.id).toBe("x");
    expect(ranked[0]!.assessment.proposalId).toBe("x");
    expect(ranked[0]!.assessment.benefitPerCost).toBe(0.8);
  });
});
