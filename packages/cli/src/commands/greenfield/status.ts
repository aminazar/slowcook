/**
 * GUCDI — `greenfield status` core (pure). Computes where a greenfield project
 * is in the PRD → stories → brand → LCR → trace pipeline, and the next action.
 * It is also the **scope-completeness signal**: a scope is "complete" when every
 * addressable question is answered, the trace is green, every story is in the
 * LCR, and the brand is set — only then does the backend phase begin.
 *
 * Pure + unit-tested; the IO (reading PRD/specs/brand/LCR) is in ./index.ts.
 * See docs/plans/gucdi-greenfield.md.
 */

export interface GreenfieldSpecFact {
  storyId: string;
  /** Has requirement provenance (prd_ref anchor or source_issue). */
  anchored: boolean;
  /** Count of unresolved *addressable* open questions (block scope-complete). */
  addressableQuestions: number;
  /** A mock LCR component references this story (it's been vibed). */
  hasLcr: boolean;
}

export interface GreenfieldInput {
  prdInitiatives: number;
  specs: GreenfieldSpecFact[];
  brandPresent: boolean;
  traceViolations: number;
}

export interface GreenfieldStage {
  name: string;
  done: boolean;
  detail: string;
}

export interface GreenfieldStatus {
  stages: GreenfieldStage[];
  scopeComplete: boolean;
  /** The single next action to advance the pipeline (or the backend handoff). */
  nextAction: string;
}

export function computeGreenfieldStatus(input: GreenfieldInput): GreenfieldStatus {
  const { prdInitiatives, specs, brandPresent, traceViolations } = input;
  const anchored = specs.filter((s) => s.anchored).length;
  const vibed = specs.filter((s) => s.hasLcr).length;
  const addressable = specs.reduce((n, s) => n + s.addressableQuestions, 0);

  const prdDone = prdInitiatives > 0;
  const storiesDone = specs.length > 0 && anchored === specs.length;
  const brandDone = brandPresent;
  const lcrDone = specs.length > 0 && vibed === specs.length;
  const traceDone = traceViolations === 0;
  const questionsDone = addressable === 0;

  const stages: GreenfieldStage[] = [
    { name: "PRD", done: prdDone, detail: `${prdInitiatives} initiative(s)` },
    { name: "Stories (menu)", done: storiesDone, detail: `${specs.length} stories, ${anchored} anchored` },
    { name: "Brand", done: brandDone, detail: brandPresent ? "design system present" : "no design system" },
    { name: "LCR (vibe×eye)", done: lcrDone, detail: `${vibed}/${specs.length} stories vibed` },
    { name: "Trace", done: traceDone, detail: traceViolations === 0 ? "provenance complete" : `${traceViolations} violation(s)` },
    { name: "Open questions", done: questionsDone, detail: `${addressable} addressable unresolved` },
  ];

  const scopeComplete = prdDone && storiesDone && brandDone && lcrDone && traceDone && questionsDone;

  let nextAction: string;
  if (!prdDone) nextAction = "Write the PRD (default docs/PRD.md), then run `slowcook menu`.";
  else if (specs.length === 0) nextAction = "Run `slowcook menu` to decompose the PRD into stories.";
  else if (!storiesDone) nextAction = `Fix provenance gaps: ${specs.length - anchored} story(ies) lack a PRD anchor / source_issue (see \`trace check\`).`;
  else if (!brandDone) nextAction = "Run `slowcook brand` to turn the brand brief into the design system.";
  else if (!lcrDone) {
    const next = specs.find((s) => !s.hasLcr);
    nextAction = `Vibe story-${next!.storyId} into the mock, then \`slowcook eye --story ${next!.storyId}\` to converge it.`;
  } else if (!traceDone) nextAction = "Resolve `trace check` violations (orphans / dangling refs).";
  else if (!questionsDone) nextAction = `Resolve ${addressable} addressable open question(s) before the scope is complete.`;
  else nextAction = "Scope complete ✓ — ready for backend: refine → recipe → brew → chef (data-source swap from the LCR's SQLite+ORM).";

  return { stages, scopeComplete, nextAction };
}
