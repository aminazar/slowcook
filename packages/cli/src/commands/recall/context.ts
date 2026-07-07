/**
 * `recallContext` — the loop-memory seam. One best-effort call that agent
 * commands prepend to their user prompt so a task starts already knowing what
 * prior sessions decided/tried. Returns "" (not a placeholder) when ctx is
 * absent or nothing is recalled, so callers can inject conditionally without
 * polluting the prompt or paying tokens for a "nothing found" note.
 */
import { ctxAvailable, ctxSearch, type CtxRunner } from "./ctx.js";
import { recallBrief } from "./brief.js";

export interface RecallContextOpts {
  query?: string;
  file?: string;
  limit?: number;
  since?: string;
  label?: string; // human label for the brief header
}

/** best-effort recall brief for prompt injection; "" when nothing useful. */
export function recallContext(opts: RecallContextOpts, run?: CtxRunner): string {
  if (!ctxAvailable(run)) return "";
  const results = ctxSearch({ query: opts.query, file: opts.file, limit: opts.limit ?? 5, since: opts.since }, run);
  if (results.length === 0) return "";
  return recallBrief(results, { label: opts.label ?? opts.query ?? opts.file ?? "this task", max: opts.limit });
}
