import { describe, it, expect } from "vitest";
import { checkTrace, checkCoverage, parseLcrProvenance, type SpecNode, type LcrNode } from "./check.js";

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
