/**
 * GUCDI — pure assembler. Turns the `menu` agent's structured story drafts into
 * full `Spec` objects (sequential ids, PRD back-anchor, data contract, open
 * questions), and flags any draft whose prd_anchor isn't a real PRD initiative
 * (a provenance gap `trace check` would later catch). The LLM dispatch +
 * `writeSpec` live in ./index.ts; this part is pure + unit-tested.
 */
import type { Spec } from "@slowcook-ai/core";
import type { MenuStoryDraft } from "@slowcook-ai/llm-anthropic";

export interface AssembleOptions {
  /** PRD path (relative to repo root) recorded as `prd_ref.file`. */
  prdFile: string;
  /** First numeric story id; subsequent stories increment. */
  startId: number;
  /** ISO timestamp for `created_at`. */
  now: string;
  /** cli version → `refined_by`. */
  cliVersion: string;
  /** Known PRD anchors; drafts citing an unknown one are reported as gaps. */
  validAnchors?: string[];
}

export interface AssembleResult {
  specs: Spec[];
  /** Drafts whose `prd_anchor` isn't a known PRD initiative (provenance gap). */
  unanchored: { title: string; prd_anchor: string }[];
}

function pad(n: number): string {
  return String(n).padStart(3, "0");
}

export function assembleStories(drafts: MenuStoryDraft[], opts: AssembleOptions): AssembleResult {
  const valid = opts.validAnchors ? new Set(opts.validAnchors) : null;
  const unanchored: { title: string; prd_anchor: string }[] = [];

  const specs = drafts.map((d, i): Spec => {
    if (valid && !valid.has(d.prd_anchor)) {
      unanchored.push({ title: d.title, prd_anchor: d.prd_anchor });
    }
    const spec: Spec = {
      story_id: pad(opts.startId + i),
      title: d.title,
      status: "active",
      created_at: opts.now,
      supersedes: [],
      superseded_by: null,
      estimate: d.estimate,
      refined_by: `slowcook-menu@${opts.cliVersion}`,
      actors: d.actors,
      preconditions: [],
      invariants: d.invariants,
      acceptance_scenarios: d.acceptance_scenarios,
      non_goals: d.non_goals,
      prd_ref: { file: opts.prdFile, anchor: d.prd_anchor },
      data_contract: d.data_contract,
      open_questions: d.open_questions,
    };
    if (d.ui_behavior && Object.keys(d.ui_behavior).length > 0) spec.ui_behavior = d.ui_behavior;
    if (d.fidelity_modes && d.fidelity_modes.length > 0) spec.fidelity = { modes: d.fidelity_modes };
    if (d.persona) spec.persona = d.persona;
    if (d.surfaces && d.surfaces.length > 0) spec.surfaces = d.surfaces;
    return spec;
  });

  return { specs, unanchored };
}
