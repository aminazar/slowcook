/**
 * ONE PLACE THE MODELS ARE DECIDED (dovizir handover §5).
 *
 * Symptom: `--refine-model claude-opus-5` was passed, and the multifurcation
 * round still ran on `claude-sonnet-4-5` — its own private default. brew sat on
 * `claude-sonnet-4-6`. Fifteen stage defaults were scattered across five model
 * ids (two of them pinned to a dated `claude-sonnet-4-5-20250929`), so "pin the
 * model" was whack-a-mole and the operator only learned the truth from a cost
 * footer after the money was spent.
 *
 * Precedence, highest first:
 *   1. the stage's own flag        (--refine-model, --model, …)
 *   2. SLOWCOOK_MODEL              (one env var, applies to every stage)
 *   3. the stage default below
 *
 * Stages keep their TIER choice — a cheap stage stays cheap — but the ids are
 * refreshed together here instead of drifting apart file by file.
 */

export type Stage =
  | "refine" | "relationship" | "menu" | "testgen" | "vibe" | "plate"
  | "brew" | "chef" | "sift" | "recipe" | "investigate" | "brand"
  | "reconcile" | "extract";

/** Current model per stage. Tier is deliberate; the id is kept current. */
export const STAGE_DEFAULTS: Record<Stage, string> = {
  // Heavy reasoning — spec authorship, UI generation, investigation.
  refine: "claude-opus-4-8",
  testgen: "claude-opus-4-8",
  vibe: "claude-opus-4-8",
  plate: "claude-opus-4-8",
  investigate: "claude-opus-4-8",
  brand: "claude-opus-4-8",
  reconcile: "claude-opus-4-8",
  extract: "claude-opus-4-8",
  // Cheaper, narrower work — relationship analysis, decomposition, repairs.
  relationship: "claude-sonnet-5",
  menu: "claude-sonnet-5",
  brew: "claude-sonnet-5",
  chef: "claude-sonnet-5",
  sift: "claude-sonnet-5",
  recipe: "claude-sonnet-5",
};

export const MODEL_ENV = "SLOWCOOK_MODEL";

/**
 * Resolve one stage's model. `flag` is whatever the stage's own CLI option
 * produced (undefined when the operator didn't pass it).
 */
export function resolveModel(
  stage: Stage,
  flag?: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const f = flag?.trim();
  if (f) return f;
  const e = env[MODEL_ENV]?.trim();
  if (e) return e;
  return STAGE_DEFAULTS[stage];
}

/** Where a stage's model came from — used to make the startup table honest. */
export function modelSource(
  stage: Stage,
  flag?: string,
  env: NodeJS.ProcessEnv = process.env
): "flag" | "env" | "default" {
  if (flag?.trim()) return "flag";
  if (env[MODEL_ENV]?.trim()) return "env";
  return "default";
}

/**
 * The resolved model-per-stage table, printed at startup.
 *
 * This exists because of HOW the drift was found: via a cost footer, after the
 * run. What model each stage will use is knowable before the first token is
 * spent, so it belongs in the first log lines.
 */
export function renderModelTable(
  stages: { stage: Stage; flag?: string }[],
  env: NodeJS.ProcessEnv = process.env
): string {
  const rows = stages.map(({ stage, flag }) => ({
    stage,
    model: resolveModel(stage, flag, env),
    from: modelSource(stage, flag, env),
  }));
  const w = Math.max(...rows.map((r) => r.stage.length), 5);
  const lines = rows.map(
    (r) => `  ${r.stage.padEnd(w)}  ${r.model}${r.from === "default" ? "" : `   (${r.from})`}`
  );
  return [`models:`, ...lines].join("\n");
}
