// Ladder mode: the suite is coherent up front, revealed one rung at a time.
import { describe, it, expect } from "vitest";
import { ladderWindow, describeWindow, type LadderTest } from "./ladder.js";

const T = (id: string, order?: number): LadderTest => ({ id, ...(order !== undefined ? { release_order: order } : {}) });
const g = (...ids: string[]) => new Set(ids);

describe("ladderWindow", () => {
  const suite = [T("smoke", 1), T("inv-a", 2), T("inv-b", 2), T("beh-1", 3), T("beh-2", 3), T("integ", 4)];

  it("releases only up to the first non-green rung — the wall cannot form", () => {
    const w = ladderWindow(suite, g());
    expect([...w.released]).toEqual(["smoke"]);   // rung 1 only
    expect(w.frontier).toEqual(["smoke"]);
    expect(w.held).toBe(5);
    expect(w.complete).toBe(false);
  });

  it("advances when a rung goes fully green", () => {
    const w = ladderWindow(suite, g("smoke"));
    expect(w.rung).toBe(2);
    expect(w.frontier.sort()).toEqual(["inv-a", "inv-b"]);
    expect(w.released.size).toBe(3);              // smoke + both invariants
  });

  it("a half-green rung does not advance — both invariants must pass", () => {
    const w = ladderWindow(suite, g("smoke", "inv-a"));
    expect(w.rung).toBe(2);
    expect(w.frontier).toEqual(["inv-b"]);
  });

  it("earlier green rungs stay released — regressions on them are still caught", () => {
    const w = ladderWindow(suite, g("smoke", "inv-a", "inv-b"));
    expect(w.released.has("smoke")).toBe(true);   // still scored
    expect(w.rung).toBe(3);
  });

  it("no orders at all = one rung containing everything (today's behavior)", () => {
    const flat = [T("a"), T("b"), T("c")];
    const w = ladderWindow(flat, g("a"));
    expect(w.released.size).toBe(3);
    expect(w.frontier.sort()).toEqual(["b", "c"]);
  });

  it("complete when every rung is green", () => {
    const w = ladderWindow(suite, g("smoke", "inv-a", "inv-b", "beh-1", "beh-2", "integ"));
    expect(w.complete).toBe(true);
    expect(w.held).toBe(0);
  });

  it("empty manifest is trivially complete", () => {
    expect(ladderWindow([], g()).complete).toBe(true);
  });
});

describe("describeWindow", () => {
  it("names the frontier honestly", () => {
    const w = ladderWindow([T("smoke", 1), T("x", 2)], g());
    expect(describeWindow(w, 2)).toContain("rung 1");
    expect(describeWindow(w, 2)).toContain("1 held back");
  });
});
