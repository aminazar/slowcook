// The checker's pure parts: plan retargeting (foreign worlds skip
// world-sensitive data asserts) and repetition mining. Domain-neutral.
import { describe, it, expect } from "vitest";
import { repeatedPatterns, retargetPlan } from "./checker.js";
import type { CompiledWalk } from "./walks.js";

const walk = (id: string, affs: string[], steps: CompiledWalk["plan"]["steps"]): CompiledWalk => ({
  walkId: id, journeyId: id, branchId: null, world: "empty", redRouteRank: 1, diceSeed: 1,
  clock: { start: "a", end: "b" },
  affordances: affs.map((a, i) => ({ step: `s${i}`, id: a, route: "/r", destructive: false })),
  plan: { name: id, baseUrl: "http://x", steps },
});

describe("retargetPlan", () => {
  const w = walk("w", ["a"], [
    { action: "goto", url: "/r?world=empty" },
    { action: "assert", expr: "window.__slowcook.data.list().then(x=>x.length===2)" },
    { action: "assert", expr: "!!document.querySelector('[data-affordance=\"a\"]')" },
    { action: "screenshot", path: "shots/w--s0.png" },
  ]);
  const p = retargetPlan(w, "gen-b", "http://y");

  it("swaps the world on the entry goto", () => {
    expect(p.steps[0]!.url).toBe("/r?world=gen-b");
  });
  it("drops world-sensitive data asserts, keeps structural ones", () => {
    const exprs = p.steps.filter((s) => s.action === "assert").map((s) => s.expr);
    expect(exprs).toHaveLength(1);
    expect(exprs[0]).toContain("data-affordance");
  });
  it("world-suffixes screenshots so runs don't overwrite each other", () => {
    expect(p.steps.find((s) => s.action === "screenshot")!.path).toBe("shots/w--s0.gen-b.png");
  });
});

describe("repeatedPatterns", () => {
  it("finds consecutive pairs recurring across ≥2 walks", () => {
    const mk = (id: string) => walk(id, ["open-item", "save-item"], []);
    const pats = repeatedPatterns([mk("w1"), mk("w2"), walk("w3", ["other"], [])]);
    expect(pats).toHaveLength(1);
    expect(pats[0]!.pattern).toContain("open-item");
    expect(pats[0]!.walks).toBe(2);
  });
});
