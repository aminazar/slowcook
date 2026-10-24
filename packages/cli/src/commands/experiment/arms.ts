/**
 * `slowcook experiment` — the arms (2026-10-24, measure-first ruling).
 *
 * An arm is a named way of turning a story into code. Three ship as
 * defaults; a consumer may add or override arms in
 * `.brewing/experiments/arms.json` (same shape, keyed by name).
 *
 *   plain     Plain Claude Code given the ISSUE TEXT ONLY — no spec, no
 *             tests, no manifest (ruling 3). The story's artifacts are hidden
 *             from its tree before it starts and restored afterwards for the
 *             hidden oracle.
 *   pipeline  `slowcook brew` as it ships today, stage defaults, claude-cli
 *             backend (list price).
 *   swarm     the same brew with a cheap model doing the implementation and a
 *             capable one navigating — the haiku-brew / fable-refine shape.
 *
 * Models are env-driven so an arm changes nothing in code: brew reads
 * SLOWCOOK_MODEL_BREW etc. through `resolveModel`. Brew arms set
 * SLOWCOOK_BREW_LOCAL=1: they re-implement SHIPPED stories, so no branch
 * push, no draft PR, no halt comment on the (closed) source issue.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ArmKind = "plain" | "brew";

export interface ArmConfig {
  name: string;
  kind: ArmKind;
  /** Environment set for the spawned stage (names AND values). */
  env: Record<string, string>;
  /** Extra flags appended to the stage's argv (brew arms). */
  flags: string[];
  /** Model the plain arm hands to `claude --model`. */
  model?: string;
  notes: string;
}

export const DEFAULT_ARMS: Record<string, ArmConfig> = {
  plain: {
    name: "plain",
    kind: "plain",
    env: {},
    flags: [],
    model: "claude-sonnet-5-5",
    notes: "Plain Claude Code, issue text only, native tools, no slowcook artifacts.",
  },
  pipeline: {
    name: "pipeline",
    kind: "brew",
    // The brew model is PINNED (Amin, 2026-10-24): a box env that pins brew
    // elsewhere (rewo pins haiku-4-5) must not silently redefine the arm.
    env: { SLOWCOOK_LLM: "claude-cli", SLOWCOOK_BREW_LOCAL: "1", SLOWCOOK_MODEL_BREW: "claude-sonnet-5-5" },
    flags: [],
    notes: "slowcook brew with its capable model pinned (sonnet-5-5), claude-cli backend, list price; no push/PR/issue comment (local).",
  },
  swarm: {
    name: "swarm",
    kind: "brew",
    env: {
      SLOWCOOK_LLM: "claude-cli",
      SLOWCOOK_MODEL_BREW: "claude-haiku-5-5",
      SLOWCOOK_BREW_LOCAL: "1",
    },
    flags: ["--with-navigator", "--navigator-model", "claude-fable-5-1"],
    notes: "Cheap brew (haiku) with a capable navigator (fable); haiku halts are re-dispatched by hand this round.",
  },
};

/** The arms file a consumer may add. Pure over its parsed content. */
export function mergeArms(
  defaults: Record<string, ArmConfig>,
  overrides: unknown
): Record<string, ArmConfig> {
  const out: Record<string, ArmConfig> = { ...defaults };
  if (!overrides || typeof overrides !== "object") return out;
  for (const [name, raw] of Object.entries(overrides as Record<string, Partial<ArmConfig>>)) {
    const base = out[name];
    const kind = raw.kind ?? base?.kind;
    if (kind !== "plain" && kind !== "brew") {
      throw new Error(`arms.json: arm "${name}" needs kind "plain" | "brew"`);
    }
    out[name] = {
      name,
      kind,
      env: { ...(base?.env ?? {}), ...(raw.env ?? {}) },
      flags: raw.flags ?? base?.flags ?? [],
      ...(raw.model ?? base?.model ? { model: raw.model ?? base?.model } : {}),
      notes: raw.notes ?? base?.notes ?? "",
    };
  }
  return out;
}

export function loadArms(repoRoot: string): Record<string, ArmConfig> {
  const p = join(repoRoot, ".brewing", "experiments", "arms.json");
  if (!existsSync(p)) return { ...DEFAULT_ARMS };
  return mergeArms(DEFAULT_ARMS, JSON.parse(readFileSync(p, "utf8")));
}

export function resolveArm(arms: Record<string, ArmConfig>, name: string): ArmConfig {
  const arm = arms[name];
  if (!arm) throw new Error(`unknown arm "${name}" — known: ${Object.keys(arms).sort().join(", ")}`);
  return arm;
}

/** `exp/story/arm/seed` — the id every ledger row, halt and summary carries. */
export function runIdFor(exp: string, story: string, arm: string, seed: number): string {
  return `${exp}/${story}/${arm}/${seed}`;
}
