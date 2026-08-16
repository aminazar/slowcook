/**
 * PEEL, DON'T DEADLOCK (the ARM-B post-mortem, 2026-08-16).
 *
 * A monolithic acceptance suite — every test behind one deploy / beforeAll —
 * is not a wall to refuse at; it is a MASK. The tests behind it are usually
 * independent (each asserts a different exported name or invariant); the
 * shared prefix only HIDES their gradient. Scoring all N against an
 * un-deployed world yields "N failed" and teaches the agent nothing.
 *
 * So brew peels: when the run reports that most/all manifest tests share one
 * failure ROOT, that root becomes a transient RATCHET TARGET ("the deploy
 * must succeed") ahead of the masked tests. Green it, and the tests unmask
 * into the gradient that was always there. Recurse if a prefix still masks
 * the remainder. Only a single irreducible assertion is a size-1 ratchet
 * (one-shot with a budget) — never a deadlock, never a halt.
 *
 * Amin's ruling: "we want it to be a ratchet, not a deadlock." The synthetic
 * rung is NEVER the gate — it only unmasks; the real tests are still what
 * greens the story.
 *
 * Pure module: it reads the run result brew already has; nothing here runs a
 * process or a model, so every rule unit-tests.
 */

/** Minimal shape of one test result the detector needs (stack-agnostic). */
export interface FailedTest {
  id: string;
  status: "passed" | "failed" | "skipped" | "errored";
  /** The runner's message. Shared-root detection keys off its signature. */
  failure_message?: string;
}

export interface PeelResult {
  /** True when most failing tests share one root — a masked monolith. */
  masked: boolean;
  /** The shared failure signature (empty when not masked). */
  sharedRoot: string;
  /** How many of the failing tests share it. */
  sharedCount: number;
  /** The synthetic ratchet target id, when masked. */
  syntheticTarget?: string;
  /** Human line for the run log. */
  reason: string;
}

/** Normalize a failure message to its ROOT — the stable part that repeats
 *  across every masked test. Strips per-test noise (fuzz seeds, addresses,
 *  gas, run counts) so identical setup/deploy reverts collapse to one key. */
export function failureRoot(msg: string | undefined): string {
  if (!msg) return "";
  return msg
    .split("\n")[0]!                              // first line carries the cause
    .replace(/0x[0-9a-fA-F]+/g, "0x…")            // addresses / selectors
    .replace(/\b\d{3,}\b/g, "N")                  // gas, counts, seeds
    .replace(/\[\d+ runs?[^\]]*\]/g, "")          // forge fuzz annotation
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/**
 * Detect a masked monolith and, if found, the synthetic rung to climb first.
 *
 * `threshold` is the share of FAILING manifest tests that must collapse to
 * one root to call it masked (default 0.8 — the ARM-B run was 9/9 = 1.0).
 * A suite with a real gradient scatters across many roots and stays below it.
 */
export function detectMaskedMonolith(
  results: FailedTest[],
  opts: { threshold?: number; minTests?: number } = {}
): PeelResult {
  const threshold = opts.threshold ?? 0.8;
  const minTests = opts.minTests ?? 3;
  const failing = results.filter((t) => t.status === "failed" || t.status === "errored");
  if (failing.length < minTests) {
    return { masked: false, sharedRoot: "", sharedCount: 0, reason: "too few failing tests to be a masked monolith" };
  }
  const byRoot = new Map<string, number>();
  for (const t of failing) {
    const root = failureRoot(t.failure_message);
    if (!root) continue;
    byRoot.set(root, (byRoot.get(root) ?? 0) + 1);
  }
  let top = ""; let topN = 0;
  for (const [root, n] of byRoot) if (n > topN) { top = root; topN = n; }

  if (topN / failing.length < threshold || !top) {
    return {
      masked: false, sharedRoot: top, sharedCount: topN,
      reason: `gradient present — ${byRoot.size} distinct failure root(s) across ${failing.length} failing tests`,
    };
  }
  return {
    masked: true,
    sharedRoot: top,
    sharedCount: topN,
    syntheticTarget: `«ratchet» resolve the shared failure blocking ${topN} tests: ${top}`,
    reason: `masked monolith: ${topN}/${failing.length} failing tests share one root — peeling it as the next rung, not halting`,
  };
}

/**
 * The prompt the agent gets when working a synthetic peel rung. It must make
 * clear this is a DIAGNOSTIC rung, not a requirement to satisfy by faking.
 */
export function peelTargetPrompt(peel: PeelResult): string {
  return (
    `### Ratchet rung (not a requirement — a diagnostic step)\n` +
    `${peel.sharedCount} tests are all failing for the SAME underlying reason, so scoring them ` +
    `individually tells you nothing yet. Fix that one shared cause first:\n\n` +
    `> ${peel.sharedRoot}\n\n` +
    `This is almost always a setup/deployment/wiring problem, not the test logic. Once the shared ` +
    `cause is resolved, those ${peel.sharedCount} tests will report independently and you can climb ` +
    `them one at a time. Do NOT weaken or stub the shared component to make it "pass" — that only ` +
    `moves the failure downstream.`
  );
}

/**
 * Did a turn dissolve the mask? Resolved when the suite is no longer masked,
 * or the shared root CHANGED (the old wall fell; a new, different one may
 * stand behind it — that is progress, recurse onto it), or the count shrank
 * meaningfully (the mask is fragmenting into a gradient).
 */
export function peelResolved(prev: PeelResult, next: PeelResult): boolean {
  if (!prev.masked) return false;
  if (!next.masked) return true;
  if (next.sharedRoot !== prev.sharedRoot) return true;
  return next.sharedCount <= Math.max(1, Math.floor(prev.sharedCount / 2));
}
