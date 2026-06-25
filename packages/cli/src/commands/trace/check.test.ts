import { describe, it, expect } from "vitest";
import {
  checkTrace,
  checkCoverage,
  checkSurfaces,
  routeSatisfies,
  parseLcrProvenance,
  normalizeAnchorBody,
  contentHash,
  anchorHash,
  checkFreshness,
  computeImpact,
  diffPrdStates,
  type SpecNode,
  type LcrNode,
  type SpecSurface,
} from "./check.js";

describe("parseLcrProvenance", () => {
  it("recognizes @story / story-N / @convention / @craft forms", () => {
    const src = `
      // @story story-007 — the browse page
      /* @convention WCAG AA */
      // @craft rate-limit login (no requirement; security best-practice)
    `;
    expect(parseLcrProvenance(src)).toEqual([
      { kind: "story", id: "story-007" },
      { kind: "convention", ref: "WCAG AA" },
      { kind: "craft", rationale: "rate-limit login (no requirement; security best-practice)" },
    ]);
  });
  it("returns [] for a file with no provenance comment", () => {
    expect(parseLcrProvenance("export const X = 1;")).toEqual([]);
  });
});

const spec = (over: Partial<SpecNode>): SpecNode => ({ storyId: "001", ...over });
const lcr = (file: string, prov: LcrNode["provenance"]): LcrNode => ({ file, provenance: prov });

describe("checkTrace — provenance-completeness, not coverage", () => {
  it("passes a fully-anchored greenfield spine", () => {
    const r = checkTrace({
      specs: [spec({ storyId: "007", prdAnchor: "onboarding" })],
      prdAnchors: ["onboarding"],
      lcrNodes: [lcr("mock/src/components/Browse.tsx", [{ kind: "story", id: "story-007" }])],
    });
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("flags a spec citing a non-existent PRD anchor (dangling)", () => {
    const r = checkTrace({ specs: [spec({ storyId: "007", prdAnchor: "ghost" })], prdAnchors: ["onboarding"], lcrNodes: [] });
    expect(r.violations).toMatchObject([{ code: "dangling-prd-ref", subject: "story-007" }]);
  });

  it("flags a spec with NO requirement provenance (orphan)", () => {
    const r = checkTrace({ specs: [spec({ storyId: "007" })], prdAnchors: ["onboarding"], lcrNodes: [] });
    expect(r.violations).toMatchObject([{ code: "orphan-spec", subject: "story-007" }]);
  });

  it("brownfield: a spec with source_issue (no PRD) passes", () => {
    const r = checkTrace({ specs: [spec({ storyId: "007", sourceIssue: "#42" })], prdAnchors: [], lcrNodes: [] });
    expect(r.ok).toBe(true);
  });

  it("craft passes (honest provenance) and is reported, never blocked", () => {
    const r = checkTrace({
      specs: [],
      prdAnchors: [],
      lcrNodes: [lcr("mock/src/components/Login.tsx", [{ kind: "craft", rationale: "focus trap" }])],
    });
    expect(r.ok).toBe(true);
    expect(r.craft).toEqual([{ file: "mock/src/components/Login.tsx", rationale: "focus trap" }]);
  });

  it("flags an LCR file with no provenance at all (true orphan → error)", () => {
    const r = checkTrace({ specs: [], prdAnchors: [], lcrNodes: [lcr("mock/src/components/Mystery.tsx", [])] });
    expect(r.violations).toMatchObject([{ code: "orphan-lcr", subject: "mock/src/components/Mystery.tsx" }]);
  });

  it("flags an LCR file citing a story that has no spec (dangling)", () => {
    const r = checkTrace({
      specs: [spec({ storyId: "007", prdAnchor: "onboarding" })],
      prdAnchors: ["onboarding"],
      lcrNodes: [lcr("mock/src/components/Old.tsx", [{ kind: "story", id: "story-099" }])],
    });
    expect(r.violations).toMatchObject([{ code: "dangling-lcr-story", subject: "mock/src/components/Old.tsx" }]);
  });
});

describe("checkCoverage — the inverse: every story has a surface", () => {
  const spec2 = (id: string): SpecNode => ({ storyId: id });
  it("passes when every story is referenced by an LCR surface", () => {
    const r = checkCoverage({
      specs: [spec2("101"), spec2("109")],
      lcrNodes: [
        lcr("mock/src/components/Feed.tsx", [{ kind: "story", id: "story-101" }]),
        lcr("mock/src/pages/rewowner/Overview.tsx", [{ kind: "story", id: "story-109" }]),
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.uncovered).toEqual([]);
    expect(r.coveredCount).toBe(2);
  });
  it("flags stories with no surface (the persona-coverage gap)", () => {
    const r = checkCoverage({
      specs: [spec2("101"), spec2("113"), spec2("115")],
      lcrNodes: [lcr("mock/src/components/Feed.tsx", [{ kind: "story", id: "story-101" }])],
    });
    expect(r.ok).toBe(false);
    expect(r.uncovered).toEqual(["story-113", "story-115"]);
    expect(r.coveredCount).toBe(1);
    expect(r.totalStories).toBe(3);
  });
  it("is empty-safe", () => {
    expect(checkCoverage({ specs: [], lcrNodes: [] })).toMatchObject({ ok: true, uncovered: [] });
  });
});

describe("checkSurfaces — persona surfaces resolve to real routes", () => {
  const surf = (persona: string, route: string, home = false): SpecSurface => ({ storyId: `story-1`, persona, route, home });
  it("routeSatisfies matches param segments", () => {
    expect(routeSatisfies("/u/:handle", "/u/you")).toBe(true);
    expect(routeSatisfies("/rewowner", "/rewowner")).toBe(true);
    expect(routeSatisfies("/admin/uue", "/admin/taxonomy")).toBe(false);
    expect(routeSatisfies("/r/:slug", "/r/x/y")).toBe(false); // segment count differs
  });
  it("passes when every declared surface route exists in the router", () => {
    const r = checkSurfaces({
      surfaces: [surf("member", "/", true), surf("member", "/u/you"), surf("rewowner", "/rewowner", true)],
      routes: ["/", "/u/:handle", "/rewowner", "/rewowner/claim"],
    });
    expect(r.ok).toBe(true);
    expect(r.dangling).toEqual([]);
  });
  it("flags a surface the mock doesn't expose (dangling) — same rule as dangling-lcr-story", () => {
    const r = checkSurfaces({
      surfaces: [surf("moderator", "/admin/moderation", true), surf("ghost", "/admin/nope", true)],
      routes: ["/admin/moderation"],
    });
    expect(r.ok).toBe(false);
    expect(r.dangling.map((s) => s.route)).toEqual(["/admin/nope"]);
    expect(r.unreachablePersonas).toContain("ghost");
  });
  it("is empty-safe", () => {
    expect(checkSurfaces({ surfaces: [], routes: [] })).toMatchObject({ ok: true, dangling: [] });
  });
});

describe("PRD↔spec interdependency", () => {
  describe("content fingerprint", () => {
    it("normalizeAnchorBody ignores trailing ws + blank-line runs", () => {
      expect(normalizeAnchorBody("a   \n\n\n\nb  ")).toBe("a\n\nb");
    });
    it("anchorHash is stable under cosmetic reflow but moves on a semantic edit", () => {
      const a = "The operator certifies workers.\n\nAggregates only.";
      const cosmetic = "The operator certifies workers.   \n\n\nAggregates only.\n\n";
      const semantic = "The operator certifies agencies.\n\nAggregates only.";
      expect(anchorHash(a)).toBe(anchorHash(cosmetic));
      expect(anchorHash(a)).not.toBe(anchorHash(semantic));
    });
    it("contentHash is 16-hex and deterministic", () => {
      expect(contentHash("x")).toMatch(/^[0-9a-f]{16}$/);
      expect(contentHash("hello")).toBe(contentHash("hello"));
    });
  });

  describe("checkFreshness", () => {
    const anchors = [
      { anchor: "personas-operator", hash: "aaaa" },
      { anchor: "wallet", hash: "bbbb" },
    ];
    it("flags a spec whose recorded sha no longer matches (PRD moved)", () => {
      const r = checkFreshness({
        specs: [{ storyId: "019", prdAnchor: "personas-operator", prdSha: "OLD" }],
        anchors,
      });
      expect(r.stale).toEqual([{ storyId: "019", anchor: "personas-operator", recorded: "OLD", current: "aaaa" }]);
      expect(r.freshCount).toBe(0);
    });
    it("counts a matching spec as fresh, not stale", () => {
      const r = checkFreshness({ specs: [{ storyId: "007", prdAnchor: "wallet", prdSha: "bbbb" }], anchors });
      expect(r.stale).toHaveLength(0);
      expect(r.freshCount).toBe(1);
    });
    it("reports unstamped specs separately (unknown freshness, not stale)", () => {
      const r = checkFreshness({ specs: [{ storyId: "019", prdAnchor: "personas-operator" }], anchors });
      expect(r.stale).toHaveLength(0);
      expect(r.unstamped).toEqual([{ storyId: "019", anchor: "personas-operator" }]);
    });
    it("skips specs with no anchor and anchors absent from the PRD", () => {
      const r = checkFreshness({
        specs: [{ storyId: "100" }, { storyId: "101", prdAnchor: "ghost", prdSha: "x" }],
        anchors,
      });
      expect(r.stale).toHaveLength(0);
      expect(r.unstamped).toHaveLength(0);
    });
  });

  describe("computeImpact", () => {
    const specs = [
      { storyId: "002", prdAnchor: "personas-members" },
      { storyId: "019", prdAnchor: "personas-operator" },
      { storyId: "007", prdAnchor: "wallet" },
    ];
    it("returns the stories that link a changed anchor", () => {
      const { affected } = computeImpact({ specs, changedAnchors: ["personas-operator", "wallet"] });
      expect(affected).toEqual([
        { storyId: "019", anchor: "personas-operator" },
        { storyId: "007", anchor: "wallet" },
      ]);
    });
    it("is empty when nothing relevant changed", () => {
      expect(computeImpact({ specs, changedAnchors: ["forecast"] }).affected).toHaveLength(0);
    });
  });

  describe("diffPrdStates", () => {
    it("classifies changed / added / removed anchors", () => {
      const before = [{ anchor: "a", hash: "1" }, { anchor: "b", hash: "2" }, { anchor: "gone", hash: "9" }];
      const after = [{ anchor: "a", hash: "1" }, { anchor: "b", hash: "CHANGED" }, { anchor: "new", hash: "5" }];
      expect(diffPrdStates(before, after)).toEqual({ changed: ["b"], added: ["new"], removed: ["gone"] });
    });
  });
});
