/**
 * Budgeting — the deterministic estimation model (pure). Converts a story's
 * COUNTABLE drivers (spec structure) + the LLM's RELATIVE `effort` block into a
 * 3-point, dual-currency estimate (human manhours + agent tokens), then rolls a
 * backlog up to portfolio percentiles via Monte-Carlo simulation.
 *
 * Boundary: the LLM sizes relative + names qualitative drivers (it's unreliable at
 * absolute hours); THIS model owns the absolute conversion via calibrated
 * coefficients. The seed coefficients below are illustrative defaults — the real
 * ones are LEARNED from actuals (reference-class forecasting / the SizeCostTable).
 * See dash docs/BUDGETING-AND-ROADMAP.md.
 */
import type { Spec, EffortSize } from "@slowcook-ai/core";

/** Countable complexity drivers extracted from the spec structure (the inside view). */
export interface StoryDrivers {
  entities: number;
  fields: number;
  relations: number;
  endpoints: number;
  surfaces: number;
  /** Σ declared states across surfaces (≥1 per surface) — the EPSS matrix size. */
  epssCells: number;
  scenarios: number;
  invariants: number;
  fidelityModes: number;
  openQuestions: number;
  personas: number;
}

/** A 3-point estimate (optimistic / most-likely / pessimistic) in one unit. */
export interface ThreePoint {
  o: number;
  m: number;
  p: number;
}

/** A story's estimate across both currencies, 3-point each. */
export interface StoryEstimate {
  storyId: string;
  title: string;
  epic: string | null;
  /** human manhours (design + qa + review). */
  hours: ThreePoint;
  /** agent tokens (build + test). */
  tokens: ThreePoint;
  /** total cost in cents (labor + compute). */
  costCents: ThreePoint;
  risk: "low" | "medium" | "high";
  confidence: number;
  drivers: StoryDrivers;
  qualitativeDrivers: string[];
}

/** Calibration — seed coefficients (illustrative; calibrate from actuals). */
export interface Calibration {
  /** relative weight per t-shirt size. */
  weight: Record<EffortSize, number>;
  /** human hours per design/qa weight unit. */
  designHoursPerWeight: number;
  qaHoursPerWeight: number;
  /** agent k-tokens per build weight unit. */
  buildKTokPerWeight: number;
  /** structural coefficients (the inside view). */
  structural: {
    designBase: number; dSurf: number; dMode: number;
    buildBaseK: number; bEntity: number; bField: number; bApi: number; bSurf: number;
    qaBase: number; qCell: number; qInv: number;
    testBaseK: number; tScenario: number;
    reviewBase: number; rSurf: number; rInv: number;
  };
  /** multiplier per qualitative driver (default 1.0 when absent). */
  driverMult: Record<string, number>;
  /** added band per risk level. */
  riskAdd: Record<"low" | "medium" | "high", number>;
  baseBand: number;
  /** $/hour (cents) blended labor rate. */
  roleRateCents: number;
  /** $/million-tokens (cents) blended compute rate. */
  tokenRateCentsPerM: number;
}

export const SEED_CALIBRATION: Calibration = {
  weight: { xs: 1, s: 2, m: 4, l: 7, xl: 12 },
  designHoursPerWeight: 2.0,
  qaHoursPerWeight: 1.5,
  buildKTokPerWeight: 80,
  structural: {
    designBase: 1, dSurf: 1.5, dMode: 0.8,
    buildBaseK: 40, bEntity: 30, bField: 4, bApi: 15, bSurf: 20,
    qaBase: 1, qCell: 0.6, qInv: 0.4,
    testBaseK: 30, tScenario: 20,
    reviewBase: 0.5, rSurf: 0.4, rInv: 0.2,
  },
  driverMult: {
    "external-integration": 1.4, "novel-algorithm": 1.5, "stateful-flow": 1.25,
    "multi-persona": 1.2, "data-migration": 1.3, realtime: 1.4, compliance: 1.3,
    concurrency: 1.35, "ambiguous-requirements": 1.3,
  },
  riskAdd: { low: 0, medium: 0.25, high: 0.6 },
  baseBand: 0.5,
  roleRateCents: 8000,
  tokenRateCentsPerM: 900,
};

/** Count the structural drivers from a spec (the inside view). */
export function extractDrivers(spec: Spec): StoryDrivers {
  const entities = spec.data_contract?.entities ?? [];
  const surfaces = spec.surfaces ?? [];
  const epssCells = surfaces.reduce((n, s) => n + Math.max(1, s.states?.length ?? 1), 0);
  const personas = new Set<string>();
  if (spec.persona?.id) personas.add(spec.persona.id);
  for (const a of spec.actors ?? []) personas.add(a.name);
  return {
    entities: entities.length,
    fields: entities.reduce((n, e) => n + (e.fields?.length ?? 0), 0),
    relations: entities.reduce((n, e) => n + (e.relations?.length ?? 0), 0),
    endpoints: spec.data_contract?.api?.length ?? 0,
    surfaces: surfaces.length,
    epssCells,
    scenarios: spec.acceptance_scenarios?.length ?? 0,
    invariants: spec.invariants?.length ?? 0,
    fidelityModes: spec.fidelity?.modes?.length ?? 1,
    openQuestions: spec.open_questions?.addressable?.length ?? 0,
    personas: personas.size,
  };
}

/** Geometric mean of two positive numbers (blends structural + LLM views). */
const geomean = (a: number, b: number): number => Math.sqrt(Math.max(a, 0.01) * Math.max(b, 0.01));

/** Spread a most-likely value into a right-skewed 3-point using risk + confidence. */
function spread(m: number, risk: "low" | "medium" | "high", confidence: number, calib: Calibration): ThreePoint {
  const band = Math.min(1.2, Math.max(0.1, (calib.baseBand * (1 + calib.riskAdd[risk])) / Math.max(confidence, 0.3)));
  return { o: m * (1 - 0.35 * band), m, p: m * (1 + 1.0 * band) };
}

/** Estimate one story: countable drivers ⊕ the LLM effort block → 3-point dual-currency. */
export function estimateStory(spec: Spec, calib: Calibration = SEED_CALIBRATION): StoryEstimate {
  const d = extractDrivers(spec);
  const s = calib.structural;
  const eff = spec.effort;

  // Structural most-likely (the inside view).
  const designH_s = s.designBase + s.dSurf * d.surfaces + s.dMode * d.surfaces * Math.max(0, d.fidelityModes - 1);
  const buildK_s = s.buildBaseK + s.bEntity * d.entities + s.bField * d.fields + s.bApi * d.endpoints + s.bSurf * d.surfaces;
  const qaH_s = s.qaBase + s.qCell * d.epssCells + s.qInv * d.invariants;
  const testK_s = s.testBaseK + s.tScenario * d.scenarios;
  const reviewH_s = s.reviewBase + s.rSurf * d.surfaces + s.rInv * d.invariants;

  // LLM holistic most-likely (the t-shirt view), blended when present.
  const w = (sz: EffortSize) => calib.weight[sz];
  const designH = eff ? geomean(designH_s, w(eff.design) * calib.designHoursPerWeight) : designH_s;
  const buildK = eff ? geomean(buildK_s, w(eff.build) * calib.buildKTokPerWeight) : buildK_s;
  const qaH = eff ? geomean(qaH_s, w(eff.qa) * calib.qaHoursPerWeight) : qaH_s;
  const testK = eff ? geomean(testK_s, w(eff.qa) * calib.buildKTokPerWeight * 0.5) : testK_s;
  const reviewH = eff ? geomean(reviewH_s, w(eff.build) * 0.3) : reviewH_s;

  // Qualitative driver multiplier (hits implementation/test more than design).
  const mult = (eff?.drivers ?? []).reduce((acc, dr) => acc * (calib.driverMult[dr] ?? 1), 1);
  const designMult = Math.sqrt(mult);

  const hoursM = designH * designMult + qaH * mult + reviewH * mult;
  const tokensM = (buildK * mult + testK * mult) * 1000;
  const costM = Math.round((hoursM * calib.roleRateCents) + (tokensM / 1_000_000) * calib.tokenRateCentsPerM);

  const risk = eff?.risk ?? "medium";
  const confidence = eff?.confidence ?? 0.5;
  return {
    storyId: spec.story_id,
    title: spec.title,
    epic: spec.epic ?? null,
    hours: spread(hoursM, risk, confidence, calib),
    tokens: spread(tokensM, risk, confidence, calib),
    costCents: spread(costM, risk, confidence, calib),
    risk,
    confidence,
    drivers: d,
    qualitativeDrivers: eff?.drivers ?? [],
  };
}

// ── Monte-Carlo portfolio rollup ─────────────────────────────────────────────

/** Deterministic PRNG (mulberry32) so the simulation is reproducible + testable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sample a triangular(o,m,p) distribution given u∈[0,1). */
export function sampleTriangular(tp: ThreePoint, u: number): number {
  const { o, m, p } = tp;
  if (p <= o) return o;
  const fc = (m - o) / (p - o);
  return u < fc ? o + Math.sqrt(u * (p - o) * (m - o)) : p - Math.sqrt((1 - u) * (p - o) * (p - m));
}

export interface Percentiles { p50: number; p85: number; p95: number }

function percentiles(sorted: number[]): Percentiles {
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { p50: at(0.5), p85: at(0.85), p95: at(0.95) };
}

export interface PortfolioForecast {
  hours: Percentiles;
  tokens: Percentiles;
  costCents: Percentiles;
  /** the deterministic Σ of most-likely values (the v1 method) for comparison. */
  deterministic: { hours: number; tokens: number; costCents: number };
  iterations: number;
  stories: number;
}

/** Common-mode (systemic) risk factor applied to the WHOLE backlog per iteration —
 *  models correlated overruns (a slow team / hard codebase runs everything long).
 *  Without it, idiosyncratic story risk over-diversifies and the portfolio band is
 *  unrealistically tight. Right-skewed: systemic surprises are usually bad. */
const SYSTEMIC: ThreePoint = { o: 0.92, m: 1.0, p: 1.35 };

/** Monte-Carlo: per iteration draw a systemic factor, then sample each story's
 *  3-point per currency, sum, report percentiles. */
export function monteCarloPortfolio(estimates: StoryEstimate[], iterations = 10_000, seed = 0x5c00c): PortfolioForecast {
  const rand = mulberry32(seed);
  const hours: number[] = [], tokens: number[] = [], cost: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const sf = sampleTriangular(SYSTEMIC, rand()); // shared by all stories this iteration
    let h = 0, t = 0, c = 0;
    for (const e of estimates) {
      // one shared draw per story keeps the currencies correlated (a story that
      // runs long runs long in BOTH hours and tokens) — more realistic than independent.
      const u = rand();
      h += sampleTriangular(e.hours, u) * sf;
      t += sampleTriangular(e.tokens, u) * sf;
      c += sampleTriangular(e.costCents, u) * sf;
    }
    hours.push(h); tokens.push(t); cost.push(c);
  }
  hours.sort((a, b) => a - b); tokens.sort((a, b) => a - b); cost.sort((a, b) => a - b);
  return {
    hours: percentiles(hours),
    tokens: percentiles(tokens),
    costCents: percentiles(cost),
    deterministic: {
      hours: estimates.reduce((n, e) => n + e.hours.m, 0),
      tokens: estimates.reduce((n, e) => n + e.tokens.m, 0),
      costCents: estimates.reduce((n, e) => n + e.costCents.m, 0),
    },
    iterations,
    stories: estimates.length,
  };
}
