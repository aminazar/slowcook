import type { Spec } from "@slowcook-ai/core";

/**
 * 0.11.16+ — bounded-attention spec slicing.
 *
 * Brew's per-iter prompt today embeds the entire spec body. For a story
 * with 12 invariants and 8 acceptance scenarios, that's ~2-4KB of
 * context the agent must consider when working on a single target test.
 * Most of it is irrelevant to the iteration's specific scope.
 *
 * This slicer derives a focused projection of the spec for a given
 * target test by keyword-matching identifiers extracted from the
 * test's title chain. Conservative: when the heuristic produces too
 * narrow a slice, falls back to the full spec rather than starve the
 * agent of context.
 *
 * Future (0.12.0+): testgen will tag each emitted test with its
 * `invariant_id`, and we'll resolve via that explicit mapping instead
 * of string matching. This 0.11.16 implementation is the heuristic
 * fallback that ships first.
 */

export interface SpecSlice {
  invariants: string[];
  acceptance_scenarios: string[];
  non_goals: string[];
  /** True when the slicer fell back to the full spec (heuristic too weak). */
  fellBack: boolean;
  /** For iter-log telemetry. */
  ratio: {
    invariants: { kept: number; total: number };
    scenarios: { kept: number; total: number };
  };
}

/**
 * Extract identifiers from a target test id like
 * `tests/integration/story-007-ui.test.tsx > BookmarksPage > clicking Save calls /api/bookmarks`.
 *
 * Returns a lowercased, deduped set of identifier-shaped tokens
 * (function names, route paths, common nouns). Filters stop-words.
 *
 * The set is what we'll grep invariants and scenarios against.
 */
export function extractIdentifiersFromTargetTest(targetTestId: string): Set<string> {
  // Drop the file prefix (everything up through the first " > ")
  const sepIdx = targetTestId.indexOf(" > ");
  const titleChain = sepIdx >= 0 ? targetTestId.slice(sepIdx + 3) : targetTestId;

  // Tokenize: split on whitespace + common separators, keep only word-shaped
  // identifiers (incl camelCase, kebab-case, paths starting with /).
  const stop = new Set([
    // English stop-words
    "the", "a", "an", "and", "or", "but", "for", "with", "to", "of", "in",
    "on", "at", "by", "from", "into", "as", "is", "are", "was", "were",
    "be", "been", "being", "have", "has", "had", "do", "does", "did", "not",
    "no", "yes", "given", "when", "then", "should", "must", "may", "can",
    "will", "would", "could", "this", "that", "those", "it", "its", "if",
    "test", "tests", "testing", "renders", "render", "calls", "returns",
    "shows", "show", "case", "case:", "story", "ui", "after", "before",
    // Generic web/HTTP terms — these are too pervasive in spec text;
    // every endpoint mentions them, so they don't narrow scope.
    "api", "get", "post", "put", "delete", "patch", "options", "head",
    "request", "response", "responses", "header", "headers", "body",
    "param", "params", "parameter", "parameters", "query", "json",
    "http", "https", "url", "uri", "endpoint", "route", "router",
    "code", "status",
    // Generic dev terms
    "file", "files", "function", "method", "class", "import", "export",
    "value", "values", "type", "types", "true", "false", "null",
    "valid", "invalid", "row", "rows", "data", "list", "items", "item",
    // Vitest-specific terms — show up in test names but not in specs
    "given", "when", "then", "and", "expect", "describe",
  ]);

  const ids = new Set<string>();

  // Path segments: /api/foo/bar, /u/[handle]
  const pathRe = /\/[a-z][a-z0-9_/.\\[\]-]*/gi;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(titleChain)) !== null) {
    ids.add(m[0].toLowerCase());
  }

  // camelCase + PascalCase + kebab-case + snake_case identifiers
  // (≥ 3 chars to avoid noise like "if", "do")
  const wordRe = /[A-Za-z_][A-Za-z0-9_-]{2,}/g;
  while ((m = wordRe.exec(titleChain)) !== null) {
    const tok = m[0].toLowerCase();
    if (!stop.has(tok)) ids.add(tok);
  }

  // Backticked code spans inside test titles often name the load-bearing
  // identifier — grab them explicitly so they survive even if matched by
  // the wordRe above.
  const tickRe = /`([^`]+)`/g;
  while ((m = tickRe.exec(titleChain)) !== null) {
    if (m[1]) ids.add(m[1].toLowerCase());
  }

  return ids;
}

/**
 * Score a spec entry (invariant or scenario) against the identifier
 * set. Score is the count of matched identifiers; >0 means relevant.
 */
function scoreEntry(entry: string, identifiers: Set<string>): number {
  const lower = entry.toLowerCase();
  let score = 0;
  for (const id of identifiers) {
    if (lower.includes(id)) score += 1;
  }
  return score;
}

/**
 * Produce a focused slice of the spec for the given target test.
 *
 * Algorithm (0.11.17+ — top-K ranked):
 *
 *   1. Score each invariant + scenario by token overlap with identifiers
 *      extracted from the target test name.
 *   2. Sort by score descending.
 *   3. Keep top `keepInvariants` invariants and top `keepScenarios`
 *      scenarios (each defaulting to a small fixed number, NOT
 *      "everything with score > 0"). On focused stories where every
 *      invariant shares common terms, score>0 is almost always true,
 *      and slicing fails to narrow — top-K forces aggressive narrowing.
 *   4. Drop entries with score=0 even if they'd fit in the top-K
 *      (no relevance ≠ low relevance — exclude entirely).
 *   5. When fewer than `minKept` invariants have score > 0 AND there
 *      are more invariants total than we kept, return the FULL spec
 *      as a safety fallback (the agent doesn't have enough relevant
 *      context to work from).
 *
 * Validated 2026-04-25 on rewo's story-007 manifest: prior `score > 0`
 * algorithm produced ~97% retention (effectively no slicing) and 50%
 * fallback rate. Top-K with K=5 reduces retention to ~45% on the
 * same data while keeping the most-relevant invariants surfaced.
 */
export function sliceSpecForTarget(
  spec: Spec,
  targetTestId: string,
  options?: {
    /** Minimum kept invariants before falling back to full spec. */
    minKept?: number;
    /** How many top-scored invariants to keep. Default 5. */
    keepInvariants?: number;
    /** How many top-scored scenarios to keep. Default 4. */
    keepScenarios?: number;
  }
): SpecSlice {
  const minKept = options?.minKept ?? 2;
  const keepInvariants = options?.keepInvariants ?? 5;
  const keepScenarios = options?.keepScenarios ?? 4;
  const identifiers = extractIdentifiersFromTargetTest(targetTestId);

  const invariants = spec.invariants ?? [];
  const scenarios = spec.acceptance_scenarios ?? [];
  const nonGoals = spec.non_goals ?? [];

  // Score each entry, then sort descending. Take the top-K with score>0.
  const scoredInv = invariants
    .map((entry, idx) => ({ entry, score: scoreEntry(entry, identifiers), idx }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.idx - b.idx); // stable: original order on tie
  const scoredScn = scenarios
    .map((entry, idx) => ({ entry, score: scoreEntry(entry, identifiers), idx }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.idx - b.idx);

  let keptInv = scoredInv.slice(0, keepInvariants).map((s) => s.entry);
  let keptScn = scoredScn.slice(0, keepScenarios).map((s) => s.entry);

  // Fallback: if too few invariants matched AND there's room to
  // expand, return the full spec rather than starve the agent of
  // context. Triggers on completely unrelated test names (no
  // identifier overlap with any invariant).
  let fellBack = false;
  if (keptInv.length < minKept && keptInv.length < invariants.length) {
    keptInv = invariants;
    keptScn = scenarios;
    fellBack = true;
  }

  return {
    invariants: keptInv,
    acceptance_scenarios: keptScn,
    non_goals: nonGoals, // always kept whole
    fellBack,
    ratio: {
      invariants: { kept: keptInv.length, total: invariants.length },
      scenarios: { kept: keptScn.length, total: scenarios.length },
    },
  };
}

/**
 * Render a slice as YAML-shaped prose for the brew prompt's "spec" block.
 * Mirrors the keys of a real spec but only emits non-empty arrays.
 */
export function renderSpecSlice(slice: SpecSlice, fullSpec: Spec): string {
  // Preserve the load-bearing top-level fields (story_id, title, etc.)
  // so brew sees the same spec identity it would with the full body.
  const lines: string[] = [];
  lines.push(`story_id: "${fullSpec.story_id}"`);
  lines.push(`title: ${JSON.stringify(fullSpec.title)}`);
  if (slice.invariants.length > 0) {
    lines.push("invariants:");
    for (const inv of slice.invariants) {
      lines.push(`  - ${JSON.stringify(inv)}`);
    }
  }
  if (slice.acceptance_scenarios.length > 0) {
    lines.push("acceptance_scenarios:");
    for (const s of slice.acceptance_scenarios) {
      lines.push(`  - ${JSON.stringify(s)}`);
    }
  }
  if (slice.non_goals.length > 0) {
    lines.push("non_goals:");
    for (const ng of slice.non_goals) {
      lines.push(`  - ${JSON.stringify(ng)}`);
    }
  }
  return lines.join("\n");
}
