// The storyteller's pure core: scheduling (dice law), the story clock,
// plan compilation (build-cue asserts, confirm-step, acceptance asserts,
// mere-change floor), and checker scoring. Domain-neutral fixtures.
import { describe, it, expect } from "vitest";
import { compileWalkPlan, mulberry32, scheduleWalks, scoreAffordances, selectTopAffordances, storyClock } from "./walks.js";
import type { Journey, JourneysFile } from "./journeys-schema.js";

const j = (id: string, rank: number, branches = 0): Journey => ({
  id, epic: "E", persona: "member", title: `t-${id}`, start_world: "empty", red_route_rank: rank,
  source: { kind: "authored" },
  steps: [
    { id: "s1", text: "opens", route: "/", action: "goto", expect: [] },
    {
      id: "s2", text: "acts", route: "/", action: "click", affordance: `${id}-act`,
      expect: [{ kind: "query", expr: "window.__slowcook.data.count().then(c=>c===1)" }],
      ...(branches > 0
        ? { branches: Array.from({ length: branches }, (_, i) => ({ id: `b${i}`, given: `case ${i}`, steps: [{ id: `b${i}s`, text: "alt", route: "/", action: "click" as const, affordance: `${id}-alt${i}`, expect: [{ kind: "dom" as const, expr: "true" }] }] })) }
        : {}),
    },
  ],
});

describe("scheduleWalks (law 2 — seeded dice)", () => {
  it("keeps document order while ≤3 walks pend", () => {
    const file: JourneysFile = { schema_version: 1, journeys: [j("a", 1), j("b", 2)] };
    expect(scheduleWalks(file, 7).map((w) => w.walkId)).toEqual(["a--main", "b--main"]);
  });

  it("dices deterministically when >3 pend — same seed, same order; different seed, different order", () => {
    const file: JourneysFile = { schema_version: 1, journeys: [j("a", 1, 2), j("b", 2, 2)] }; // 6 walks
    const s1 = scheduleWalks(file, 42).map((w) => w.walkId);
    const s2 = scheduleWalks(file, 42).map((w) => w.walkId);
    const s3 = scheduleWalks(file, 43).map((w) => w.walkId);
    expect(s1).toEqual(s2);
    expect(s1).not.toEqual(s3);
    expect([...s1].sort()).toEqual([...s3].sort()); // exhaustion holds
  });
});

describe("storyClock (law 1)", () => {
  it("advances monotonically and deterministically", () => {
    const t1 = storyClock("2026-01-05T09:00:00.000Z", mulberry32(1));
    const t2 = storyClock("2026-01-05T09:00:00.000Z", mulberry32(1));
    const a = [t1(), t1(), t1()];
    expect([t2(), t2(), t2()]).toEqual(a);
    expect(Date.parse(a[1]!)).toBeGreaterThan(Date.parse(a[0]!));
  });
});

describe("compileWalkPlan", () => {
  const journey: Journey = {
    id: "buy", epic: "Shop", persona: "member", title: "buys a thing", start_world: "stocked",
    red_route_rank: 1, source: { kind: "authored" },
    steps: [
      { id: "s1", text: "browses", route: "/items", action: "goto", expect: [] },
      { id: "s2", text: "purchases", route: "/items", action: "click", affordance: "buy-item", destructive: true, expect: [{ kind: "query", expr: "Q1" }] },
    ],
  };
  const c = compileWalkPlan(journey, null, { baseUrl: "http://x", clockStart: "2026-01-05T09:00:00.000Z", diceSeed: 1 });

  it("first goto carries the world; later gotos do not", () => {
    const gotos = c.plan.steps.filter((s) => s.action === "goto");
    expect(gotos[0]!.url).toBe("/items?world=stocked");
  });

  it("asserts the affordance EXISTS before acting (law 4 build cue)", () => {
    const i = c.plan.steps.findIndex((s) => s.expr?.includes('data-affordance=\\"buy-item\\"') || s.expr?.includes('data-affordance="buy-item"'));
    const click = c.plan.steps.findIndex((s) => s.action === "click" && s.selector?.includes("buy-item"));
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(click);
  });

  it("destructive steps exercise the confirm affordance", () => {
    const exprs = c.plan.steps.map((s) => s.expr ?? s.selector ?? "");
    expect(exprs.some((e) => e.includes("data-confirm-step"))).toBe(true);
    const confirmClick = c.plan.steps.filter((s) => s.action === "click" && s.selector === "[data-confirm-step]");
    expect(confirmClick).toHaveLength(1);
  });

  it("compiles acceptance asserts AND the mere-change floor (law 5)", () => {
    const exprs = c.plan.steps.filter((s) => s.action === "assert").map((s) => s.expr!);
    expect(exprs).toContain("Q1");
    expect(exprs.some((e) => e.includes("__sc_pre") && e.includes("!=="))).toBe(true);
  });

  it("publishes the advancing clock to the page (law 1)", () => {
    const clocks = c.plan.steps.filter((s) => s.expr?.includes("__slowcook.clock"));
    expect(clocks.length).toBe(2); // one per journey step
    expect(c.clock.end > c.clock.start).toBe(true);
  });
});

describe("scoreAffordances / selectTopAffordances", () => {
  it("scores by coverage × inverted rank and selects the top 20%", () => {
    const mk = (walkId: string, rank: number, aff: string[]): Parameters<typeof scoreAffordances>[0][number] => ({
      walkId, journeyId: walkId, branchId: null, world: "empty", redRouteRank: rank, diceSeed: 1,
      clock: { start: "a", end: "b" },
      affordances: aff.map((id, i) => ({ step: `s${i}`, id, route: "/", destructive: false })),
      plan: { name: walkId, steps: aff.map(() => ({ action: "click" as const })) },
    });
    const walks = [mk("w1", 1, ["hot", "warm"]), mk("w2", 1, ["hot"]), mk("w3", 4, ["cold"])];
    const scores = scoreAffordances(walks);
    expect(scores[0]!.id).toBe("hot");
    expect(scores[0]!.score).toBe(2 * 4); // coverage 2 × (5-1)
    const top = selectTopAffordances(scores);
    expect(top.map((t) => t.id)).toEqual(["hot"]); // ceil(3*0.2)=1
  });
});

it("compiles the imagination floor around an imagine-declared step", () => {
  const j = {
    id: "adopt", epic: "adopt", persona: "founder", title: "t", start_world: "empty",
    red_route_rank: 1, source: { kind: "authored" as const, ref: "x" },
    steps: [{ id: "s1", text: "connect", route: "/k", action: "submit" as const, affordance: "connect", input: "acme/shop", imagine: "survey-reads-repo", expect: [] }],
  };
  const plan = compileWalkPlan(j as never, undefined, { diceSeed: 1, clockStart: "2026-01-01T09:00:00.000Z" });
  const exprs = plan.plan.steps.filter((s) => s.action === "assert").map((s) => s.expr ?? "");
  expect(exprs.some((e) => e.includes('__sc_im = ') && e.includes("survey-reads-repo"))).toBe(true);
  expect(exprs.some((e) => e.includes('imagined("survey-reads-repo") : -1) > window.__sc_im'))).toBe(true);
});

it("never gotos a parametric route — clicks carry the story there", () => {
  const j = {
    id: "review", epic: "review", persona: "founder", title: "t", start_world: "w",
    red_route_rank: 1, source: { kind: "authored" as const, ref: "x" },
    steps: [
      { id: "s1", text: "open", route: "/line", action: "click" as const, affordance: "open-artifact", expect: [] },
      { id: "s2", text: "pin", route: "/order/:id", action: "click" as const, affordance: "pin-comment", expect: [] },
    ],
  };
  const plan = compileWalkPlan(j as never, undefined, { diceSeed: 1, clockStart: "2026-01-01T09:00:00.000Z" });
  const gotos = plan.plan.steps.filter((s) => s.action === "goto").map((s) => s.url ?? "");
  expect(gotos).toHaveLength(1);
  expect(gotos[0]).toContain("/line");
});
