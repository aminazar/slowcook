/**
 * Walk compilation — the storyteller's pure core (P3). No I/O, no LLM:
 * journeys → scheduled walks → executable QaPlans, implementing the five
 * laws deterministically:
 *
 *  1 TIMELY       — a story clock advances per step; the walker publishes it
 *                   to the page (window.__slowcook.clock) so every adaptor
 *                   mutation is stamped with believable, chronological time.
 *  2 DICE         — when more than 3 walks pend, the next is picked by a
 *                   SEEDED die (mulberry32); the seed rides in the artifact
 *                   so replays reproduce the exact traversal.
 *  3 EMPTY FIRST  — start_world resolution is validated elsewhere; plans
 *                   carry their world in the entry URL (?world=).
 *  4 BUILD→USE    — the plan asserts the affordance EXISTS before acting on
 *                   it: a missing affordance fails the replay, which is the
 *                   builder's cue to build exactly one affordance and re-run.
 *  5 ACCEPTANCE   — every non-goto step compiles its acceptance expects into
 *                   asserts; a mere-change floor (snapshot inequality)
 *                   backstops steps whose expects are still thin.
 */
import type { QaPlan, QaStep } from "../../lib/browser/qa-replay.js";
import { listWalks, walkId, walkSteps, type Journey, type JourneysFile, type WalkRef } from "./journeys-schema.js";

/* ────────────────────────────── scheduling (law 2) */

/** mulberry32 — tiny deterministic PRNG (the budget engine's convention). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ScheduledWalk extends WalkRef {
  journey: Journey;
}

/** All walks of all journeys, in the order the storyteller will tell them.
 *  Journeys keep document order (the artifact already encodes empty-first
 *  ordering); WITHIN the pending set, once more than 3 walks pend the next
 *  pick is a seeded die roll. */
export function scheduleWalks(file: JourneysFile, diceSeed: number): ScheduledWalk[] {
  const pending: ScheduledWalk[] = file.journeys.flatMap((j) =>
    listWalks(j).map((w) => ({ ...w, journey: j })),
  );
  const rand = mulberry32(diceSeed);
  const out: ScheduledWalk[] = [];
  while (pending.length > 0) {
    const i = pending.length > 3 ? Math.floor(rand() * pending.length) : 0;
    out.push(pending.splice(i, 1)[0]!);
  }
  return out;
}

/* ────────────────────────────── the story clock (law 1) */

/** Deterministic, advancing, believable: steps land minutes-to-hours apart,
 *  jittered by the seeded PRNG; each walk starts a day after the previous
 *  walk's end so the product's history reads chronologically. */
export function storyClock(startIso: string, rand: () => number): () => string {
  let t = Date.parse(startIso);
  return () => {
    t += Math.round((5 + rand() * 170) * 60_000); // 5min – ~3h per step
    return new Date(t).toISOString();
  };
}

/* ────────────────────────────── plan compilation (laws 1/4/5) */

export interface AffordanceUse {
  step: string;
  id: string;
  route: string;
  destructive: boolean;
}

export interface CompiledWalk {
  walkId: string;
  journeyId: string;
  branchId: string | null;
  world: string;
  redRouteRank: number;
  diceSeed: number;
  clock: { start: string; end: string };
  affordances: AffordanceUse[];
  plan: QaPlan;
}

const AFF = (id: string) => `[data-affordance="${id}"]`;
const CONFIRM = `[data-confirm-step]`;

export function compileWalkPlan(
  journey: Journey,
  branchId: string | null,
  opts: { baseUrl: string; world?: string; shotsDir?: string; clockStart: string; diceSeed: number },
): CompiledWalk {
  const steps = walkSteps(journey, branchId);
  const world = opts.world ?? journey.start_world;
  const rand = mulberry32(opts.diceSeed ^ 0x5eed);
  const tick = storyClock(opts.clockStart, rand);
  const id = walkId(journey.id, branchId);

  const qa: QaStep[] = [];
  const affordances: AffordanceUse[] = [];
  let firstGoto = true;
  let lastRoute = "";
  let clockNow = opts.clockStart;

  const setClock = () => {
    clockNow = tick();
    qa.push({ action: "assert", expr: `(window.__slowcook && (window.__slowcook.clock = ${JSON.stringify(clockNow)})), true` });
  };
  const gotoRoute = (route: string) => {
    const url = firstGoto ? `${route}${route.includes("?") ? "&" : "?"}world=${encodeURIComponent(world)}` : route;
    firstGoto = false;
    qa.push({ action: "goto", url });
    lastRoute = route;
  };

  for (const s of steps) {
    setClock(); // law 1: time advances before the step happens
    // Parametric routes (/order/:id) cannot be teleported to — navigation
    // into them must come from a clicked affordance; the walker only records
    // that the story now stands there.
    if (s.route !== lastRoute) {
      if (s.route.includes(":")) lastRoute = s.route;
      else gotoRoute(s.route);
    }
    if (s.action !== "goto") {
      const aff = s.affordance!;
      affordances.push({ step: s.id, id: aff, route: s.route, destructive: !!s.destructive });
      // law 4: the affordance must EXIST (build cue when it doesn't)
      qa.push({ action: "assert", expr: `!!document.querySelector(${JSON.stringify(AFF(aff))})` });
      // mere-change floor stash (law 5's backstop)
      qa.push({ action: "assert", expr: "(window.__sc_pre = window.__slowcook.snapshot()), true" });
      // imagination floor (pre): count the imagined events already appended
      if (s.imagine) qa.push({ action: "assert", expr: `(window.__sc_im = (window.__slowcook.imagined ? window.__slowcook.imagined(${JSON.stringify(s.imagine)}) : 0)), true` });
      if (s.action === "fill" || s.action === "submit") {
        qa.push({ action: "fill", selector: AFF(aff), value: s.input ?? "" });
        if (s.action === "submit") qa.push({ action: "click", selector: `${AFF(aff)} [type="submit"], [data-affordance="${aff}-submit"]` });
      } else {
        qa.push({ action: "click", selector: AFF(aff) });
      }
      if (s.destructive) {
        // the doctrine's behavioral half: a confirm step must appear, and
        // the walk exercises it.
        qa.push({ action: "assert", expr: `!!document.querySelector(${JSON.stringify(CONFIRM)})` });
        qa.push({ action: "click", selector: CONFIRM });
      }
      qa.push({ action: "wait", ms: 120 });
      // law 5: acceptance-derived asserts — the SPECIFIED change
      for (const e of s.expect) qa.push({ action: "assert", expr: e.expr });
      // imagination floor (post): the world must have ANSWERED — the named
      // imagination appended at least one event through the adaptor.
      if (s.imagine) qa.push({ action: "assert", expr: `(window.__slowcook.imagined ? window.__slowcook.imagined(${JSON.stringify(s.imagine)}) : -1) > window.__sc_im` });
      if (s.action !== "fill") {
        // floor: SOMETHING must have changed in the adaptor for state-
        // changing actions (fill alone may legitimately not commit).
        qa.push({ action: "assert", expr: `window.__slowcook.snapshot() !== window.__sc_pre` });
      }
    } else {
      for (const e of s.expect) qa.push({ action: "assert", expr: e.expr });
    }
    if (opts.shotsDir) qa.push({ action: "screenshot", path: `${opts.shotsDir}/${id}--${s.id}.png` });
  }

  return {
    walkId: id,
    journeyId: journey.id,
    branchId,
    world,
    redRouteRank: journey.red_route_rank,
    diceSeed: opts.diceSeed,
    clock: { start: opts.clockStart, end: clockNow },
    affordances,
    plan: { name: id, baseUrl: opts.baseUrl, steps: qa },
  };
}

/* ────────────────────────────── checker scoring (P5 consumes) */

export interface AffordanceScore {
  id: string;
  route: string;
  coverage: number;
  bestRank: number;
  score: number;
  /** shortest walk (by step count) that exercises this affordance. */
  shortestWalk: string;
}

export function scoreAffordances(walks: CompiledWalk[]): AffordanceScore[] {
  const MAX_RANK = 4;
  const byId = new Map<string, { routes: Set<string>; walks: CompiledWalk[]; bestRank: number }>();
  for (const w of walks) {
    for (const a of w.affordances) {
      const cur = byId.get(a.id) ?? { routes: new Set<string>(), walks: [], bestRank: MAX_RANK };
      cur.routes.add(a.route);
      cur.walks.push(w);
      cur.bestRank = Math.min(cur.bestRank, w.redRouteRank);
      byId.set(a.id, cur);
    }
  }
  return [...byId.entries()]
    .map(([id, v]) => ({
      id,
      route: [...v.routes][0]!,
      coverage: new Set(v.walks.map((w) => w.walkId)).size,
      bestRank: v.bestRank,
      score: new Set(v.walks.map((w) => w.walkId)).size * (MAX_RANK + 1 - v.bestRank),
      shortestWalk: v.walks.slice().sort((a, b) => a.plan.steps.length - b.plan.steps.length)[0]!.walkId,
    }))
    .sort((a, b) => b.score - a.score);
}

/** The checker's selection: top ceil(20%) by score. */
export function selectTopAffordances(scores: AffordanceScore[]): AffordanceScore[] {
  return scores.slice(0, Math.max(1, Math.ceil(scores.length * 0.2)));
}
