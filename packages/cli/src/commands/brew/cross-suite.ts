/**
 * Cross-suite story contract (2026-08-23, the story-016 missing-migration
 * post-mortem).
 *
 * The recorded manifest historically listed only the primary (vitest) tier,
 * so story-scoped tests living in OTHER suites — pgTAP under
 * supabase/tests/database/, acceptance specs — were invisible to brew's
 * red-set: a schema story went "SUCCESS, all green" while its migration
 * did not exist (the db suite was 14/14 red the whole time, filtered out
 * as "not in the manifest").
 *
 * The fix folds story-matched tests from every declared suite into the
 * story's contract at brew start. The loop then treats a red pgTAP file
 * exactly like any red vitest test: target it, let the agent write the
 * migration, re-run, checkpoint on the flip.
 */

import type { TestEntry } from "@slowcook-ai/core";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match a test FILE path (or tap-prove test id, which is a file path) to a
 * story. Conservative shape: `story-<id>` delimited by path/word boundaries,
 * tolerating zero-padding differences ("16" matches "story-016").
 */
export function storyFileMatcher(storyId: string): (fileOrId: string) => boolean {
  const bare = storyId.replace(/^story-/, "").replace(/^0+/, "") || "0";
  const re = new RegExp(
    `(^|[/_.-])story-0*${escapeRegExp(bare)}([/_.-]|$)`
  );
  return (fileOrId) => re.test(fileOrId);
}

/**
 * Fold story-matched discovered tests that the manifest missed into the
 * contract. Pure — callers supply the discovery output.
 *
 * Returns only the ADDED entries (callers append + log). Suites whose
 * discovery output is file-level (tap-prove: id === file) fold as one
 * entry per file; that is exactly the granularity their runner reports.
 */
export function foldCrossSuiteTests(
  manifestTests: ReadonlyArray<TestEntry>,
  discovered: ReadonlyArray<TestEntry>,
  storyId: string
): TestEntry[] {
  const known = new Set(manifestTests.map((t) => t.id));
  const matches = storyFileMatcher(storyId);
  const added: TestEntry[] = [];
  const seen = new Set<string>();
  for (const t of discovered) {
    if (known.has(t.id) || seen.has(t.id)) continue;
    if (!matches(t.file || t.id)) continue;
    seen.add(t.id);
    added.push({ id: t.id, file: t.file || t.id });
  }
  return added;
}
