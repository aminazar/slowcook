/**
 * The journeys artifact — `.brewing/journeys.yaml` (storyteller stage, P1).
 *
 * A journey is a persona's walk through the product, compiled into
 * machine-executable steps. `vibe journeys` writes it (deterministic compile
 * from a concept.yaml when present, LLM synthesis from specs otherwise);
 * `vibe tell` walks it; `vibe check` replays it.
 *
 * Machine-executability rests on DOM conventions, never CSS selectors:
 *   - `affordance: <id>` → the builder must render `data-affordance="<id>"`
 *   - price only inside `data-price`; destructive/spend steps carry a
 *     confirm affordance (`data-confirm-step`) the walker exercises.
 *
 * The five laws (Amin, 2026-07-26) bind the walkers, not this schema, but
 * two leave marks here: `start_world` naming a WALK-PRODUCED snapshot
 * (empty-first — there are no hand-written seeds), and `expect` carrying
 * the acceptance-derived state assertions (the state checker asserts the
 * acceptance, not mere change).
 */
import { z } from "zod";

export const JourneyExpectSchema = z.object({
  /** `query` runs against window.__slowcook.data / snapshot(); `dom` against the page. */
  kind: z.enum(["query", "dom"]),
  /** A JS expression evaluated in the page; must resolve truthy. */
  expr: z.string().min(1),
  /** World-sensitive asserts are skipped when the walk replays in a foreign
   *  (checker-generated) world; structural asserts always run. */
  world_sensitive: z.boolean().optional(),
});

export type JourneyExpect = z.infer<typeof JourneyExpectSchema>;

const stepBase = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  /** The human sentence — the storyteller's narration for this step. */
  text: z.string().min(1),
  /** Route the step happens on (the affordance's screen). */
  route: z.string().startsWith("/"),
  /** goto = navigation only; click/fill/submit act on `affordance`. */
  action: z.enum(["goto", "click", "fill", "submit"]),
  /** Required for click/fill/submit — the data-affordance id. */
  affordance: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  /** Text typed for fill/submit actions. */
  input: z.string().optional(),
  /** Destructive/spend steps get a compiled confirm-step interaction. */
  destructive: z.boolean().optional(),
  /** IMAGINATION invoked when this step crosses a boundary the mock cannot
   *  cross for real (repo contents, agent reasoning, payments, deploys,
   *  monitoring, other humans): the named module that appends the imagined
   *  consequence through the adaptor. Affordances are what the user does;
   *  imaginations are how the world answers. */
  imagine: z.string().optional(),
  /** Acceptance-derived assertions (law 5): the state must change AS SPECIFIED. */
  expect: z.array(JourneyExpectSchema).default([]),
});

export type JourneyStep = z.infer<typeof stepBase> & { branches?: JourneyBranch[] };
export interface JourneyBranch {
  id: string;
  /** The Given that distinguishes this branch — becomes the EPSS state. */
  given: string;
  steps: JourneyStep[];
}

const JourneyStepSchema: z.ZodType<JourneyStep> = stepBase.extend({
  branches: z.lazy(() =>
    z.array(z.object({
      id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
      given: z.string().min(1),
      steps: z.array(JourneyStepSchema).min(1),
    })),
  ).optional(),
}) as z.ZodType<JourneyStep>;

export const JourneySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  epic: z.string().min(1),
  persona: z.string().min(1),
  title: z.string().min(1),
  /** World the walk starts from. "empty" is the only world that always
   *  exists; every other world is a snapshot a previous walk left behind. */
  start_world: z.string().default("empty"),
  /** 1 = most critical red route. Drives checker scoring. */
  red_route_rank: z.number().int().min(1).max(4),
  source: z.object({
    kind: z.enum(["concept", "synthesized", "authored"]),
    ref: z.string().optional(),
  }),
  steps: z.array(JourneyStepSchema).min(1),
});

export type Journey = z.infer<typeof JourneySchema>;

export const JourneysFileSchema = z.object({
  schema_version: z.literal(1),
  journeys: z.array(JourneySchema).min(1),
});

export type JourneysFile = z.infer<typeof JourneysFileSchema>;

/* ────────────────────────────── walk identity */

/** A WALK is one traversal: the journey's main path, or a branch path
 *  sharing the prefix up to (and including) the branching step. */
export interface WalkRef {
  journeyId: string;
  /** null = the main path; else the branch id. */
  branchId: string | null;
  walkId: string; // `${journeyId}--main` | `${journeyId}--${branchId}`
}

export function walkId(journeyId: string, branchId: string | null): string {
  return `${journeyId}--${branchId ?? "main"}`;
}

/** Enumerate every walk a journey requires (main + one per branch, at any
 *  depth). Order is stable (document order); scheduling — including the
 *  seeded-dice pick when >3 pend (law 2) — is the walker's concern. */
export function listWalks(j: Journey): WalkRef[] {
  const out: WalkRef[] = [{ journeyId: j.id, branchId: null, walkId: walkId(j.id, null) }];
  const visit = (steps: JourneyStep[]) => {
    for (const s of steps) {
      for (const b of s.branches ?? []) {
        out.push({ journeyId: j.id, branchId: b.id, walkId: walkId(j.id, b.id) });
        visit(b.steps);
      }
    }
  };
  visit(j.steps);
  return out;
}

/** The step sequence a given walk executes: the path from the journey's
 *  start through every ancestor prefix up to the branch point (inclusive),
 *  then the branch's own steps. Branch-in-branch nests. Pure recursion —
 *  each candidate path carries its own prefix. */
export function walkSteps(j: Journey, branchId: string | null): JourneyStep[] {
  if (!branchId) return j.steps;
  const find = (steps: JourneyStep[], prefix: JourneyStep[]): JourneyStep[] | null => {
    let acc = prefix;
    for (const s of steps) {
      // A branch is a SIBLING of its owning step — the road forks INSTEAD of
      // it, so the shared prefix is the steps BEFORE the fork, never the
      // forking step itself (a guide-me walk must not procure first).
      for (const b of s.branches ?? []) {
        if (b.id === branchId) return [...acc, ...b.steps];
        const nested = find(b.steps, acc);
        if (nested) return nested;
      }
      acc = [...acc, s];
    }
    return null;
  };
  const found = find(j.steps, []);
  if (!found) throw new Error(`walkSteps: branch "${branchId}" not found in journey "${j.id}"`);
  return found;
}
