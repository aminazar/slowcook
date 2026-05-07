/**
 * 0.19.0-α.11 (#84) — stale-stub detector.
 *
 * Empirical finding from rewo reuse-scan 2026-05-07: 6 @slowcook-stub
 * files survived from incomplete story-016/018 brews. They're not
 * refactor candidates (reuse-scan misclassified them at 100% similar
 * because they're literally the same template body); they're
 * INCOMPLETE WORK markers that should escalate to PM after a grace
 * period.
 *
 * This module: walk src/, find @slowcook-stub markers, age each via
 * `git log --diff-filter=A` (first-add date), report stale ones
 * + (optionally) escalate to PM via gh comment on the source issue.
 *
 * Pure helpers below; cli wiring in recon's --stub-scan flag.
 */

export interface StubFile {
  /** Repo-relative path. */
  path: string;
  /** Story id extracted from the stub marker (e.g., "016", "018"). */
  storyId: string | null;
  /** ISO timestamp of the file's first-add commit. Null if git log
   *  couldn't resolve (file isn't tracked, repo isn't a git repo,
   *  etc.). */
  firstAddedAt: string | null;
  /** Age in days, computed against `now`. Null when firstAddedAt
   *  is null. */
  ageDays: number | null;
  /** Classification: fresh < gracePeriod, stale ≥ gracePeriod. */
  classification: "fresh" | "stale" | "unknown";
}

/**
 * Detect a `@slowcook-stub` marker in file content + extract the
 * story id when one is named alongside it. Pure: no IO.
 *
 * Patterns recognized:
 *   `// @slowcook-stub story-016`     — explicit story id
 *   `// @slowcook-stub`               — bare; storyId = null
 *   `/* @slowcook-stub story-018 *\/` — block comment form
 */
export function detectStubMarker(content: string): { isStub: boolean; storyId: string | null } {
  const head = content.slice(0, 500);
  if (!head.includes("@slowcook-stub")) return { isStub: false, storyId: null };
  const m = head.match(/@slowcook-stub\s+story-(\d+)/);
  return { isStub: true, storyId: m ? m[1]! : null };
}

/**
 * Compute days between two ISO timestamps. Pure: no clock IO. Returns
 * a non-negative number rounded to 1 decimal.
 */
export function daysBetween(earlierIso: string, laterIso: string): number {
  const a = new Date(earlierIso).getTime();
  const b = new Date(laterIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  const ms = Math.max(0, b - a);
  return Math.round((ms / (1000 * 60 * 60 * 24)) * 10) / 10;
}

/**
 * Classify a stub by age against a grace period. Pure.
 *   ageDays === null      → "unknown"
 *   ageDays < graceDays   → "fresh"
 *   ageDays >= graceDays  → "stale"
 */
export function classifyStubAge(
  ageDays: number | null,
  graceDays: number,
): "fresh" | "stale" | "unknown" {
  if (ageDays === null) return "unknown";
  if (ageDays < graceDays) return "fresh";
  return "stale";
}

/**
 * Synthesize a PM-actionable comment body for an overdue stub.
 * Pure: no IO. Caller posts via gh.
 */
export function buildStaleStubComment(stub: StubFile, graceDays: number): string {
  const lines: string[] = [];
  lines.push(`### slowcook · stub still incomplete after ${graceDays} days`);
  lines.push("");
  lines.push(`A \`@slowcook-stub\` marker still exists at \`${stub.path}\`${stub.firstAddedAt ? ` (added ${stub.ageDays} day(s) ago — ${stub.firstAddedAt.slice(0, 10)})` : ""}.`);
  lines.push("");
  lines.push("This means a brew never converged on this file — it's a placeholder that throws at runtime / returns a 501 stub response. The story it belongs to is incomplete.");
  lines.push("");
  lines.push("**PM action**: choose one:");
  lines.push("");
  lines.push("1. **Re-dispatch brew** for the story. The stub will be replaced.");
  lines.push("2. **Hand-write the implementation** if brew can't converge after multiple attempts.");
  lines.push("3. **Withdraw the story** if the feature is no longer wanted — close the issue + delete the stub file.");
  lines.push("");
  lines.push(`<sub>Posted by \`slowcook recon --stub-scan\`. Re-running this scan will re-post if the stub is still here in another ${graceDays} days.</sub>`);
  return lines.join("\n");
}
