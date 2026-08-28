// Red-by-design baseline (#542) — the honest record of which tests are
// SUPPOSED to be failing right now.
//
// A consumer whose CI judges the failure-set diff (rather than demanding
// absolute green — slowcook#523) keeps that list in a file declared as
// `red_baseline` in .brewing/stack.json. The list only stays honest if
// the stage that CREATES red-by-design tests extends it in the same PR:
// on rewo, testgen merged 10 such tests and the next PR — and every PR
// after — failed the gate until a human baselined them by hand.
//
// Deliberately dumb: read, union, sort, write. No test running here; the
// ids come from the manifest testgen just built.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Union of `existing` and `additions`, sorted, duplicate-free. */
export function mergeBaseline(existing: string[], additions: string[]): string[] {
  return [...new Set([...existing, ...additions])].sort();
}

/** Entries whose test is no longer red — a brewed story shrinks the list. */
export function pruneBaseline(existing: string[], nowGreen: string[]): string[] {
  const green = new Set(nowGreen);
  return existing.filter((e) => !green.has(e));
}

export interface ExtendResult {
  /** false when the consumer declares no baseline — a no-op, not an error. */
  declared: boolean;
  path?: string;
  added?: number;
  total?: number;
}

/** Append test ids to the consumer's declared baseline. Returns what
 *  happened so callers can report it instead of guessing. */
export function extendRedBaseline(
  repoRoot: string,
  baselinePath: string | undefined,
  testIds: string[]
): ExtendResult {
  if (!baselinePath) return { declared: false };
  const abs = join(repoRoot, baselinePath);
  let existing: string[] = [];
  if (existsSync(abs)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(abs, "utf8"));
      if (Array.isArray(parsed)) existing = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      // A corrupt baseline must not be silently replaced — that would
      // erase the record of what is honestly red.
      throw new Error(
        `red baseline at ${baselinePath} is not a JSON array of test ids — fix it before generating tests.`
      );
    }
  }
  const merged = mergeBaseline(existing, testIds);
  writeFileSync(abs, JSON.stringify(merged, null, 2) + "\n", "utf8");
  return {
    declared: true,
    path: baselinePath,
    added: merged.length - existing.length,
    total: merged.length,
  };
}
