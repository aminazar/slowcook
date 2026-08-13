/**
 * 0.19.0-α.34 (sc#67) — canonical cost storage.
 *
 * Today each agent emits an HTML cost marker into its own PR comment.
 * Aggregating a story's total cost means walking every comment across
 * issue + spec PR + mockup PR + tests PR + brew PR. Fragile and slow.
 *
 * This module provides:
 *   - `appendCostEntry(repoRoot, storyId, entry)` — append-only sidecar
 *     `specs/story-<id>.cost.jsonl`, one JSON line per LLM call.
 *   - `readCostTotal(repoRoot, storyId)` — sum + entries, for the fuel-
 *     gauge command (sc#66) and any reflection tooling.
 *   - `applyCostToSpec(repoRoot, storyId)` — recomputes spec.cost.total_usd
 *     and spec.cost.last_updated from the sidecar; callers stage + commit.
 *
 * The HTML cost markers + visible cost footer stay for now — they're
 * how the PR-reader sees cost at a glance. Sidecar is for aggregation.
 * Migration of all agents to call appendCostEntry is incremental: refine
 * is wired in α.34; vibe / brew / chef are follow-ups.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";

export interface CostEntry {
  agent: string;
  /** `null` = the model was not in the pricing table when this was written.
   *  NOT zero — an unpriced call is unknown spend, not free spend (dovizir
   *  handover §2). `slowcook cost reprice` settles these from the tokens
   *  below, which is precisely why the token counts are recorded. */
  usd: number | null;
  model?: string;
  round?: string;
  /** ISO-8601. Caller supplies — keeps the module testable. */
  at: string;
  /** Where the cost was incurred (PR comment URL, run URL, etc.) */
  source_url?: string;
  /** Optional token breakdown for forensic audits. */
  tokens_in?: number;
  tokens_out?: number;
  cache_read?: number;
  cache_create?: number;
}

const SPECS_DIR = "specs";

/** Sidecar path for a story's cost log. */
export function costSidecarPath(repoRoot: string, storyId: string): string {
  return join(repoRoot, SPECS_DIR, `story-${storyId}.cost.jsonl`);
}

/** Spec yaml path (mirrors spec-yaml.ts; duplicated to avoid cycle). */
function specYamlPath(repoRoot: string, storyId: string): string {
  return join(repoRoot, SPECS_DIR, `story-${storyId}.yaml`);
}

/**
 * Append one cost entry to the sidecar. Creates the file (and any
 * missing parent dirs) if it doesn't exist. Does NOT touch the spec
 * yaml — call `applyCostToSpec` separately so the caller controls
 * when the spec changes (one write at end-of-round vs N writes per
 * LLM call).
 */
export function appendCostEntry(
  repoRoot: string,
  storyId: string,
  entry: CostEntry
): void {
  const p = costSidecarPath(repoRoot, storyId);
  mkdirSync(dirname(p), { recursive: true });
  // Trailing newline → safe append on partial-write recovery.
  appendFileSync(p, JSON.stringify(entry) + "\n", "utf8");
}

/**
 * Read + sum all entries in a story's sidecar. Tolerant of:
 *   - missing sidecar (returns zero/empty).
 *   - blank lines.
 *   - malformed lines (logged via the optional callback; total uses parseable ones).
 *
 * `usd: null` (an unpriced model) is VALID, not malformed — it sums as 0 but
 * is counted separately so a caller can say "≥ $X, N calls unpriced" instead
 * of presenting a short total as if it were complete.
 */
export function readCostTotal(
  repoRoot: string,
  storyId: string,
  onMalformed?: (lineNo: number, raw: string) => void
): { totalUsd: number; entries: CostEntry[]; unpricedCount: number } {
  const p = costSidecarPath(repoRoot, storyId);
  if (!existsSync(p)) return { totalUsd: 0, entries: [], unpricedCount: 0 };
  const lines = readFileSync(p, "utf8").split("\n");
  const entries: CostEntry[] = [];
  let total = 0;
  let unpriced = 0;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    try {
      const parsed = JSON.parse(line) as CostEntry;
      const usdOk = typeof parsed.usd === "number" || parsed.usd === null;
      if (!usdOk || typeof parsed.agent !== "string") {
        onMalformed?.(i + 1, raw);
        return;
      }
      entries.push(parsed);
      if (parsed.usd === null) unpriced += 1;
      else total += parsed.usd;
    } catch {
      onMalformed?.(i + 1, raw);
    }
  });
  return { totalUsd: total, entries, unpricedCount: unpriced };
}

/**
 * Recompute `usd` for every entry from its STORED TOKEN COUNTS × a current
 * pricing function. This is why tokens are recorded on every entry: a gap in
 * the pricing table stops being permanent data loss and becomes a re-run.
 *
 * Pure over the entries; the price function is injected so this module keeps
 * no provider dependency and the whole thing unit-tests without fixtures.
 * Returns the rewritten entries plus what changed, so callers can render a
 * dry-run diff before writing anything.
 */
export function repriceEntries(
  entries: CostEntry[],
  priceFor: (model: string, usage: {
    inputTokens: number; outputTokens: number;
    cacheReadTokens: number; cacheCreateTokens: number;
  }) => number | null
): { entries: CostEntry[]; changed: { at: string; model: string; from: number | null; to: number | null }[] } {
  const changed: { at: string; model: string; from: number | null; to: number | null }[] = [];
  const out = entries.map((e) => {
    // No model or no token record ⇒ nothing to recompute from; leave as-is.
    if (!e.model || (e.tokens_in === undefined && e.tokens_out === undefined)) return e;
    const usd = priceFor(e.model, {
      inputTokens: e.tokens_in ?? 0,
      outputTokens: e.tokens_out ?? 0,
      cacheReadTokens: e.cache_read ?? 0,
      cacheCreateTokens: e.cache_create ?? 0,
    });
    if (usd === e.usd) return e;
    changed.push({ at: e.at, model: e.model, from: e.usd, to: usd });
    return { ...e, usd };
  });
  return { entries: out, changed };
}

/** Overwrite a story's sidecar with the given entries (used by `cost reprice`). */
export function writeCostEntries(repoRoot: string, storyId: string, entries: CostEntry[]): void {
  const p = costSidecarPath(repoRoot, storyId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""), "utf8");
}

/**
 * Recompute spec.cost.total_usd + spec.cost.last_updated from the
 * sidecar and write it back. Returns true if the spec was actually
 * modified (caller stages + commits). Safe to call when the spec
 * doesn't exist yet — returns false.
 *
 * Uses a low-fidelity YAML round-trip (parse + stringify) so it
 * preserves keys but doesn't preserve comments or key ordering. That's
 * acceptable for refine-emitted specs which don't carry hand-authored
 * comments. If we later want comment-preserving updates, switch to
 * yaml's Document API.
 */
export function applyCostToSpec(
  repoRoot: string,
  storyId: string,
  nowIso: string = new Date().toISOString()
): { changed: boolean; totalUsd: number } {
  const specPath = specYamlPath(repoRoot, storyId);
  if (!existsSync(specPath)) return { changed: false, totalUsd: 0 };
  const { totalUsd, unpricedCount } = readCostTotal(repoRoot, storyId);
  const raw = readFileSync(specPath, "utf8");
  const parsed = (YAML.parse(raw) ?? {}) as Record<string, unknown> & {
    cost?: { total_usd?: number; last_updated?: string; unpriced_calls?: number };
  };
  const existing = parsed.cost ?? {};
  // Round to 4 dp so we don't churn the spec on sub-tenth-of-a-cent diffs.
  const rounded = Math.round(totalUsd * 10000) / 10000;
  if (
    existing.total_usd === rounded &&
    (existing.unpriced_calls ?? 0) === unpricedCount &&
    typeof existing.last_updated === "string"
  ) {
    return { changed: false, totalUsd: rounded };
  }
  // A total with unpriced calls behind it is a FLOOR, not a total — say so in
  // the spec rather than letting a short number read as complete.
  parsed.cost = {
    total_usd: rounded,
    last_updated: nowIso,
    ...(unpricedCount > 0 ? { unpriced_calls: unpricedCount } : {}),
  };
  writeFileSync(specPath, YAML.stringify(parsed, { lineWidth: 0 }), "utf8");
  return { changed: true, totalUsd: rounded };
}
