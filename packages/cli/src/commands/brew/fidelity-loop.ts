/**
 * design #8 — eye-driven brew convergence loop.
 *
 * Bounded fidelity-correction controller: the "brain" that drives a front-end
 * brew toward a mock by repeatedly measuring fidelity violations (the eye) and
 * applying fixes (the brew agent), relying on a hot-reload stack to re-render
 * between iterations so each pass is cheap.
 *
 * Generic + dependency-free. Parameterised over a violation type `V` so it
 * never couples to the eye's concrete types (no import from
 * @slowcook-ai/gates or any sibling package).
 *
 * MUST be bounded and detect non-progress. slowcook's brew agent has a
 * documented "analysis-paralysis" failure mode (see
 * `project_brew_agent_improvements`) where it loops without converging — so
 * the controller escalates rather than spinning:
 *   - converged: zero violations measured.
 *   - stalled:   violation COUNT failed to strictly decrease for `stallLimit`
 *                consecutive iterations (default 2). The stalling applyFix is
 *                NOT re-run — we bail before burning another fix.
 *   - exhausted: `maxIters` (default 5) measure() calls made while violations
 *                remain.
 *
 * Progress is measured by strictly-decreasing violation COUNT. `keyOf` is
 * required in deps (and is the stable per-violation identity used by callers
 * for logging/diffing `remaining`) but the convergence decision itself is
 * count-based and documented as such for simplicity.
 */

export interface FidelityLoopDeps<V> {
  /** Render + measure current fidelity violations (the eye). */
  measure: () => Promise<V[]>;
  /** Apply fixes for the given violations (the brew agent), then the caller's HMR re-renders. */
  applyFix: (violations: V[], iteration: number) => Promise<void>;
  /** Stable key per violation, used to detect progress/stall (e.g. `${selector}:${property}`). */
  keyOf: (v: V) => string;
  /** Max iterations before escalating (default 5). */
  maxIters?: number;
  /** Consecutive non-improving iterations before escalating early (default 2). */
  stallLimit?: number;
  /** Optional progress callback for logging. */
  onIteration?: (info: { iteration: number; count: number; converged: boolean }) => void;
}

export interface FidelityLoopResult<V> {
  converged: boolean;     // reached zero violations
  escalated: boolean;     // gave up (stall or exhausted) — true iff !converged
  iterations: number;     // how many measure() calls were made
  remaining: V[];         // violations left at exit
  history: number[];      // violation count per iteration (in order)
  reason: 'converged' | 'stalled' | 'exhausted';
}

/**
 * Drive a bounded measure → fix → re-measure loop until the front-end matches
 * the mock (zero violations) or the controller escalates.
 *
 * Escalation semantics (return without calling applyFix again on bail):
 *   - First iteration always proceeds to applyFix if violations exist (there is
 *     no "previous" count to stall against).
 *   - After each measure: if `iterations >= maxIters` and violations remain →
 *     `exhausted`.
 *   - Stall: if this iteration's count did NOT strictly decrease vs the prior
 *     count (>= previous), increment the stall counter; otherwise reset it to
 *     0. When the stall counter reaches `stallLimit` → `stalled` (applyFix is
 *     NOT invoked for this iteration).
 *   - `escalated === !converged`.
 */
export async function runFidelityLoop<V>(
  deps: FidelityLoopDeps<V>,
): Promise<FidelityLoopResult<V>> {
  const maxIters = deps.maxIters ?? 5;
  const stallLimit = deps.stallLimit ?? 2;

  const history: number[] = [];
  let iterations = 0;
  let stallCount = 0;
  let prevCount: number | null = null;
  let remaining: V[] = [];

  // Loop guard: maxIters caps measure() calls, so this can never run forever.
  for (;;) {
    remaining = await deps.measure();
    iterations += 1;
    const count = remaining.length;
    history.push(count);

    const converged = count === 0;
    deps.onIteration?.({ iteration: iterations, count, converged });

    if (converged) {
      return {
        converged: true,
        escalated: false,
        iterations,
        remaining,
        history,
        reason: 'converged',
      };
    }

    // Out of budget: violations remain and we've used our measure() quota.
    if (iterations >= maxIters) {
      return {
        converged: false,
        escalated: true,
        iterations,
        remaining,
        history,
        reason: 'exhausted',
      };
    }

    // Progress check (count-based). Skipped on the first iteration since there
    // is no previous count to compare against.
    if (prevCount !== null) {
      if (count >= prevCount) {
        stallCount += 1;
      } else {
        stallCount = 0;
      }

      if (stallCount >= stallLimit) {
        // Bail BEFORE applying another fix — the agent is spinning.
        return {
          converged: false,
          escalated: true,
          iterations,
          remaining,
          history,
          reason: 'stalled',
        };
      }
    }

    prevCount = count;

    // Hand the current violations to the brew agent; the caller's HMR stack
    // re-renders before the next measure().
    await deps.applyFix(remaining, iterations);
  }
}
