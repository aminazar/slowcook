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
  usd: number;
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
 */
export function readCostTotal(
  repoRoot: string,
  storyId: string,
  onMalformed?: (lineNo: number, raw: string) => void
): { totalUsd: number; entries: CostEntry[] } {
  const p = costSidecarPath(repoRoot, storyId);
  if (!existsSync(p)) return { totalUsd: 0, entries: [] };
  const lines = readFileSync(p, "utf8").split("\n");
  const entries: CostEntry[] = [];
  let total = 0;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    try {
      const parsed = JSON.parse(line) as CostEntry;
      if (typeof parsed.usd !== "number" || typeof parsed.agent !== "string") {
        onMalformed?.(i + 1, raw);
        return;
      }
      entries.push(parsed);
      total += parsed.usd;
    } catch {
      onMalformed?.(i + 1, raw);
    }
  });
  return { totalUsd: total, entries };
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
  const { totalUsd } = readCostTotal(repoRoot, storyId);
  const raw = readFileSync(specPath, "utf8");
  const parsed = (YAML.parse(raw) ?? {}) as Record<string, unknown> & {
    cost?: { total_usd?: number; last_updated?: string };
  };
  const existing = parsed.cost ?? {};
  // Round to 4 dp so we don't churn the spec on sub-tenth-of-a-cent diffs.
  const rounded = Math.round(totalUsd * 10000) / 10000;
  if (
    existing.total_usd === rounded &&
    typeof existing.last_updated === "string"
  ) {
    return { changed: false, totalUsd: rounded };
  }
  parsed.cost = { total_usd: rounded, last_updated: nowIso };
  writeFileSync(specPath, YAML.stringify(parsed, { lineWidth: 0 }), "utf8");
  return { changed: true, totalUsd: rounded };
}
