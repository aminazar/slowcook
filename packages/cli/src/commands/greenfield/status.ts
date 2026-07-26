/**
 * GUCDI — `greenfield status` core (pure). Computes where a greenfield project
 * is in the PRD → stories → brand → LCR → trace pipeline, and the next action.
 * It is also the **scope-completeness signal**: a scope is "complete" when every
 * addressable question is answered, the trace is green, the whole-app LCR is
 * built, and the brand is set — only then does the backend phase begin.
 *
 * The LCR is a WHOLE-APP mock (not per-story): one clickable app over a shared
 * SQLite data adaptor. So LCR progress is staged — data model → schema → data
 * adaptor → app shell → surfaces — and coverage is "declared surfaces reachable
 * in the app", not "stories with an @story marker".
 *
 * Pure + unit-tested; the IO (reading PRD/specs/brand/LCR) is in ./index.ts.
 * See docs/plans/vibe-whole-mock-lcr.md.
 */

export interface GreenfieldSpecFact {
  storyId: string;
  /** Has requirement provenance (prd_ref anchor or source_issue). */
  anchored: boolean;
  /** Count of unresolved *addressable* open questions (block scope-complete). */
  addressableQuestions: number;
}

/** Whole-app LCR build facts (from the plan + the mock filesystem). */
export interface GreenfieldLcr {
  /** Total UI surfaces (routes) declared across specs. 0 = no UI declared. */
  surfacesDeclared: number;
  /** Plan entities (the unified data model). */
  entities: number;
  /** Cross-story data-model conflicts (block schema-gen). */
  conflicts: number;
  /** The LCR Drizzle schema exists (`vibe schema`). */
  schemaPresent: boolean;
  /** The SQLite data adaptor exists (`vibe seed` → db.ts + seed + queries). */
  dataAdaptorPresent: boolean;
  /** The clickable app exists (`vibe app` → router/shell). */
  appPresent: boolean;
  /** Declared surfaces whose route resolves to a real route in the app router. */
  surfacesBuilt: number;
  /** Storyteller stage: `.brewing/journeys.yaml` exists (`vibe journeys`). */
  journeysCompiled: boolean;
  /** Walk artifacts present vs walks the journeys require (`vibe tell`). */
  journeysWalked: number;
  journeysTotal: number;
  /** `vibe check` report exists and had zero replay failures (null = not run). */
  checkerPassed: boolean | null;
  /** Open backprop claims (from the .brewing mirror). */
  backpropOpen: number;
}

export interface GreenfieldInput {
  prdInitiatives: number;
  specs: GreenfieldSpecFact[];
  brandPresent: boolean;
  traceViolations: number;
  lcr: GreenfieldLcr;
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
  const { prdInitiatives, specs, brandPresent, traceViolations, lcr } = input;
  const anchored = specs.filter((s) => s.anchored).length;
  const addressable = specs.reduce((n, s) => n + s.addressableQuestions, 0);

  const prdDone = prdInitiatives > 0;
  const storiesDone = specs.length > 0 && anchored === specs.length;
  const brandDone = brandPresent;
  // The LCR is done when the app exists, every declared surface is reachable,
  // and the storyteller stage has run its course: journeys compiled and walked,
  // the mock-checker green, and no backprop claims left open.
  const surfacesDone = lcr.surfacesDeclared > 0 && lcr.appPresent && lcr.surfacesBuilt === lcr.surfacesDeclared;
  const storytellerDone = lcr.journeysCompiled && lcr.journeysWalked >= lcr.journeysTotal && lcr.checkerPassed === true && lcr.backpropOpen === 0;
  const lcrDone = surfacesDone && storytellerDone;
  const traceDone = traceViolations === 0;
  const questionsDone = addressable === 0;

  const lcrDetail =
    lcr.surfacesDeclared === 0
      ? "no UI surfaces declared"
      : `${lcr.entities} entities · schema ${lcr.schemaPresent ? "✓" : "✗"} · adaptor ${lcr.dataAdaptorPresent ? "✓" : "✗"} · app ${lcr.appPresent ? "✓" : "✗"} · ${lcr.surfacesBuilt}/${lcr.surfacesDeclared} surfaces${lcr.journeysCompiled ? ` · walks ${lcr.journeysWalked}/${lcr.journeysTotal} · check ${lcr.checkerPassed === true ? "✓" : lcr.checkerPassed === false ? "✗" : "—"}` : ""}`;

  const stages: GreenfieldStage[] = [
    { name: "PRD", done: prdDone, detail: `${prdInitiatives} initiative(s)` },
    { name: "Stories (menu)", done: storiesDone, detail: `${specs.length} stories, ${anchored} anchored` },
    { name: "Brand", done: brandDone, detail: brandPresent ? "design system present" : "no design system" },
    { name: "LCR (whole-app)", done: lcrDone, detail: lcrDetail },
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
    // The whole-app LCR ladder: data model → schema → adaptor → app → surfaces.
    if (lcr.surfacesDeclared === 0) nextAction = "Stories declare no UI surfaces — re-run `slowcook menu` so it emits persona + surfaces.";
    else if (lcr.conflicts > 0) nextAction = `Resolve ${lcr.conflicts} data-model conflict(s) across specs (see \`slowcook vibe plan\`).`;
    else if (!lcr.schemaPresent) nextAction = "Run `slowcook vibe schema` to generate the LCR data adaptor's Drizzle schema.";
    else if (!lcr.dataAdaptorPresent) nextAction = "Run `slowcook vibe seed` to build the SQLite data adaptor (seed + queries).";
    else if (!lcr.appPresent) nextAction = "Run `slowcook vibe app` to scaffold the clickable LCR (router + persona shell + pages).";
    else if (!lcr.journeysCompiled) nextAction = "Run `slowcook vibe journeys` to compile the storyteller's journeys artifact.";
    else if (lcr.journeysWalked < lcr.journeysTotal) nextAction = `${lcr.journeysWalked}/${lcr.journeysTotal} walks told — run \`slowcook vibe tell\` (the storyteller builds one affordance at a time as it walks).`;
    else if (lcr.checkerPassed === null) nextAction = "All journeys walked — run `slowcook vibe check` (top-20% replays ×3 worlds + ux-optimising).";
    else if (lcr.checkerPassed === false) nextAction = "The mock-checker found breakage — read .brewing/journeys/check-report.json, apply/resolve, re-run `slowcook vibe check`.";
    else if (lcr.backpropOpen > 0) nextAction = `${lcr.backpropOpen} open backprop claim(s) — resolve them upstream (prd/stories/concept/wire), then re-run the affected walks.`;
    else nextAction = "Storyteller stage complete — run `slowcook run-mock` for the human review loop.";
  } else if (!traceDone) nextAction = "Resolve `trace check` violations (orphans / dangling refs).";
  else if (!questionsDone) nextAction = `Resolve ${addressable} addressable open question(s) before the scope is complete.`;
  else nextAction = "Scope complete ✓ — ready for backend: refine → recipe → brew → chef (data-source swap from the LCR's SQLite+ORM).";

  return { stages, scopeComplete, nextAction };
}
