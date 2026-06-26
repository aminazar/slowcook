import { describe, it, expect } from "vitest";
import type { Spec } from "@slowcook-ai/core";
import { extractDrivers, estimateStory, monteCarloPortfolio, sampleTriangular, SEED_CALIBRATION } from "./model.js";

function spec(over: Partial<Spec>): Spec {
  return {
    story_id: "001", title: "T", status: "active", created_at: "", supersedes: [], superseded_by: null,
    actors: [], preconditions: [], invariants: [], acceptance_scenarios: [], non_goals: [],
    ...over,
  } as Spec;
}

describe("extractDrivers", () => {
  it("counts entities/fields/relations/api/surfaces/EPSS-cells/scenarios", () => {
    const d = extractDrivers(spec({
      data_contract: {
        entities: [{ name: "A", fields: [{ name: "id", type: "uuid" }, { name: "x", type: "int" }], relations: ["A.x → B.id"] }],
        api: [{ method: "GET", path: "/a" }],
      },
      surfaces: [{ route: "/a", states: ["empty", "populated"] }, { route: "/b" }],
      acceptance_scenarios: ["Given a, When b, Then c"],
      invariants: ["i1", "i2"],
      fidelity: { modes: ["light", "dark"] },
    }));
    expect(d.entities).toBe(1);
    expect(d.fields).toBe(2);
    expect(d.relations).toBe(1);
    expect(d.endpoints).toBe(1);
    expect(d.surfaces).toBe(2);
    expect(d.epssCells).toBe(3); // 2 states + 1 default
    expect(d.scenarios).toBe(1);
    expect(d.invariants).toBe(2);
    expect(d.fidelityModes).toBe(2);
  });
});

describe("estimateStory", () => {
  it("produces a right-skewed 3-point (p − m > m − o)", () => {
    const e = estimateStory(spec({ surfaces: [{ route: "/a" }], effort: { design: "m", build: "m", qa: "m", drivers: [], risk: "medium", confidence: 0.6 } }));
    expect(e.hours.o).toBeLessThan(e.hours.m);
    expect(e.hours.m).toBeLessThan(e.hours.p);
    expect(e.hours.p - e.hours.m).toBeGreaterThan(e.hours.m - e.hours.o); // right skew
  });

  it("qualitative drivers raise the estimate", () => {
    const base = estimateStory(spec({ effort: { design: "m", build: "m", qa: "m", drivers: [], risk: "low", confidence: 0.8 } }));
    const heavy = estimateStory(spec({ effort: { design: "m", build: "m", qa: "m", drivers: ["external-integration", "novel-algorithm"], risk: "low", confidence: 0.8 } }));
    expect(heavy.costCents.m).toBeGreaterThan(base.costCents.m);
  });

  it("lower confidence + higher risk widens the band", () => {
    const tight = estimateStory(spec({ effort: { design: "m", build: "m", qa: "m", drivers: [], risk: "low", confidence: 0.9 } }));
    const loose = estimateStory(spec({ effort: { design: "m", build: "m", qa: "m", drivers: [], risk: "high", confidence: 0.4 } }));
    const w = (e: { hours: { o: number; p: number; m: number } }) => (e.hours.p - e.hours.o) / e.hours.m;
    expect(w(loose)).toBeGreaterThan(w(tight));
  });

  it("a bigger t-shirt costs more", () => {
    const s = estimateStory(spec({ effort: { design: "s", build: "s", qa: "s", drivers: [], risk: "low", confidence: 0.8 } }));
    const xl = estimateStory(spec({ effort: { design: "xl", build: "xl", qa: "xl", drivers: [], risk: "low", confidence: 0.8 } }));
    expect(xl.costCents.m).toBeGreaterThan(s.costCents.m);
  });

  it("works with no effort block (structural only)", () => {
    const e = estimateStory(spec({ surfaces: [{ route: "/a", states: ["empty", "populated"] }], invariants: ["i1"] }));
    expect(e.costCents.m).toBeGreaterThan(0);
    expect(e.qualitativeDrivers).toEqual([]);
  });
});

describe("sampleTriangular", () => {
  it("stays within [o, p] and returns o when degenerate", () => {
    const tp = { o: 10, m: 20, p: 40 };
    for (const u of [0, 0.25, 0.5, 0.75, 0.999]) {
      const x = sampleTriangular(tp, u);
      expect(x).toBeGreaterThanOrEqual(tp.o - 1e-9);
      expect(x).toBeLessThanOrEqual(tp.p + 1e-9);
    }
    expect(sampleTriangular({ o: 5, m: 5, p: 5 }, 0.3)).toBe(5);
  });
});

describe("monteCarloPortfolio", () => {
  it("is deterministic (seeded) and ordered p50 ≤ p85 ≤ p95", () => {
    const ests = [
      estimateStory(spec({ story_id: "1", surfaces: [{ route: "/a" }], effort: { design: "m", build: "l", qa: "m", drivers: ["external-integration"], risk: "high", confidence: 0.5 } })),
      estimateStory(spec({ story_id: "2", surfaces: [{ route: "/b" }], effort: { design: "s", build: "s", qa: "s", drivers: [], risk: "low", confidence: 0.8 } })),
    ];
    const a = monteCarloPortfolio(ests, 2000);
    const b = monteCarloPortfolio(ests, 2000);
    expect(a.costCents).toEqual(b.costCents); // reproducible
    expect(a.costCents.p50).toBeLessThanOrEqual(a.costCents.p85);
    expect(a.costCents.p85).toBeLessThanOrEqual(a.costCents.p95);
    // p85 sits above the deterministic Σ-of-most-likely (the fat right tail)
    expect(a.costCents.p85).toBeGreaterThan(a.deterministic.costCents);
    expect(a.stories).toBe(2);
  });
});

describe("SEED_CALIBRATION", () => {
  it("has a weight for every t-shirt size", () => {
    for (const sz of ["xs", "s", "m", "l", "xl"] as const) expect(SEED_CALIBRATION.weight[sz]).toBeGreaterThan(0);
  });
});
