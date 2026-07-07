/**
 * Turn ctx search results into a compact "prior context" brief — designed to be
 * PREPENDED to an agent's prompt so it starts a task already knowing what past
 * sessions decided, tried, and hit. Token-frugal on purpose (the whole point of
 * recall is to avoid re-including fat transcripts).
 */
import type { CtxResult } from "./ctx.js";

const day = (iso?: string): string => (iso ? iso.slice(0, 10) : "");

/** de-duplicate to the best snippet per session, newest/highest-rank first. */
export function topPerSession(results: CtxResult[], max: number): CtxResult[] {
  const bySession = new Map<string, CtxResult>();
  for (const r of results) {
    const prev = bySession.get(r.sessionId);
    if (!prev || (r.rank ?? 0) > (prev.rank ?? 0)) bySession.set(r.sessionId, r);
  }
  return [...bySession.values()]
    .sort((a, b) => (b.sessionImportance ?? 0) - (a.sessionImportance ?? 0) || (b.timestamp ?? "").localeCompare(a.timestamp ?? ""))
    .slice(0, max);
}

/** the markdown brief. Empty-safe: returns a one-liner when nothing is recalled. */
export function recallBrief(results: CtxResult[], opts: { label: string; max?: number } = { label: "this task" }): string {
  const top = topPerSession(results, opts.max ?? 6);
  if (top.length === 0) return `## Prior context\n_No relevant prior agent sessions found for ${opts.label}._`;
  const lines = top.map((r, i) => {
    const when = day(r.timestamp);
    const head = [r.title?.trim(), r.provider && `(${r.provider})`].filter(Boolean).join(" ");
    const snip = r.snippet.length > 240 ? r.snippet.slice(0, 240) + "…" : r.snippet;
    return `${i + 1}. ${when ? `[${when}] ` : ""}${head || r.label}\n   ${snip}\n   → inspect: ctx show session ${r.sessionId}`;
  });
  return [
    `## Prior context (recalled from ${top.length} past agent session${top.length === 1 ? "" : "s"} via ctx)`,
    `Earlier work relevant to ${opts.label} — decisions, attempts, outcomes. Build on these; don't re-investigate what's already settled.`,
    "",
    ...lines,
  ].join("\n");
}
