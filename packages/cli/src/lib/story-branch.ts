/**
 * THE one parser for slowcook agent branch names (ledger G15/G24/G24b/G24c:
 * the same suffix bug bit four scattered regexes — a naming convention is
 * an interface, and an interface gets ONE implementation).
 *
 * Branch shape:  slowcook/<kind>/story-<id>[suffix]
 * Known suffixes: -amend-<ts> (spec amendments), -fix-<n> (tests fixes),
 * -<13-digit ts> (brew runs).
 */

export type StoryBranchKind = "spec" | "tests" | "brew";

const RE = /slowcook\/(spec|tests|brew)\/story-(.+?)(?:-amend-\d+|-fix-\d+|-\d{13})?$/;

export function parseStoryBranch(
  branch: string
): { kind: StoryBranchKind; storyId: string } | null {
  const m = branch.match(RE);
  if (!m) return null;
  return { kind: m[1] as StoryBranchKind, storyId: m[2]! };
}
