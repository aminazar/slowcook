/**
 * design #8 — tests for the bounded fidelity-correction loop controller.
 *
 * Uses fake measure()/applyFix() driven by scripted violation-count
 * sequences. Violations are modelled as `{ key: string }` so `keyOf` has
 * something real to return.
 */

import { describe, it, expect, vi } from "vitest";

import { runFidelityLoop, type FidelityLoopDeps } from "./fidelity-loop.js";

interface V {
  key: string;
}

/** Build `n` distinct fake violations for a given iteration. */
function violations(n: number, salt = ""): V[] {
  return Array.from({ length: n }, (_, i) => ({ key: `${salt}sel-${i}:color` }));
}

/**
 * Make a `measure` that returns scripted counts, one per call. Each entry can
 * be a number (count → distinct violations) or an explicit V[] for key tests.
 */
function scriptedMeasure(script: Array<number | V[]>) {
  let call = 0;
  return vi.fn(async () => {
    const step = script[call];
    call += 1;
    if (step === undefined) {
      throw new Error(`measure() called more times than scripted (${call})`);
    }
    return typeof step === "number" ? violations(step) : step;
  });
}

const keyOf = (v: V) => v.key;

function deps(over: Partial<FidelityLoopDeps<V>>): FidelityLoopDeps<V> {
  return {
    measure: scriptedMeasure([0]),
    applyFix: vi.fn(async () => {}),
    keyOf,
    ...over,
  };
}

describe("runFidelityLoop", () => {
  it("converges immediately when the first measure is clean", async () => {
    const applyFix = vi.fn(async () => {});
    const res = await runFidelityLoop(
      deps({ measure: scriptedMeasure([0]), applyFix }),
    );

    expect(res.converged).toBe(true);
    expect(res.escalated).toBe(false);
    expect(res.reason).toBe("converged");
    expect(res.iterations).toBe(1);
    expect(res.history).toEqual([0]);
    expect(res.remaining).toEqual([]);
    expect(applyFix).not.toHaveBeenCalled();
  });

  it("converges over three iterations and calls applyFix twice", async () => {
    const applyFix = vi.fn(async () => {});
    const res = await runFidelityLoop(
      deps({ measure: scriptedMeasure([3, 1, 0]), applyFix }),
    );

    expect(res.converged).toBe(true);
    expect(res.escalated).toBe(false);
    expect(res.reason).toBe("converged");
    expect(res.iterations).toBe(3);
    expect(res.history).toEqual([3, 1, 0]);
    expect(res.remaining).toEqual([]);
    // applyFix called after measure #1 (3) and #2 (1), not after the clean #3.
    expect(applyFix).toHaveBeenCalledTimes(2);
    expect(applyFix.mock.calls[0][1]).toBe(1); // iteration arg
    expect(applyFix.mock.calls[1][1]).toBe(2);
  });

  it("escalates as 'stalled' when the count never decreases", async () => {
    const applyFix = vi.fn(async () => {});
    // [2,2,2]: iter1 applies (no prev), iter2 count>=prev → stall=1 applies,
    // iter3 count>=prev → stall=2 == stallLimit → bail, no applyFix.
    const res = await runFidelityLoop(
      deps({ measure: scriptedMeasure([2, 2, 2]), applyFix }),
    );

    expect(res.converged).toBe(false);
    expect(res.escalated).toBe(true);
    expect(res.reason).toBe("stalled");
    expect(res.iterations).toBe(3);
    expect(res.history).toEqual([2, 2, 2]);
    expect(res.remaining).toHaveLength(2);
    // applyFix runs after iter1 and iter2 only — NOT after the stall is detected.
    expect(applyFix).toHaveBeenCalledTimes(2);
  });

  it("escalates as 'stalled' on a plateau that follows progress", async () => {
    const applyFix = vi.fn(async () => {});
    // [4,3,3,3]: iter2 decreases (stall reset), iter3 plateau stall=1,
    // iter4 plateau stall=2 → stalled. applyFix after 1,2,3 = 3 times.
    const res = await runFidelityLoop(
      deps({ measure: scriptedMeasure([4, 3, 3, 3]), applyFix }),
    );

    expect(res.reason).toBe("stalled");
    expect(res.escalated).toBe(true);
    expect(res.iterations).toBe(4);
    expect(res.history).toEqual([4, 3, 3, 3]);
    expect(applyFix).toHaveBeenCalledTimes(3);
  });

  it("escalates as 'exhausted' when it keeps improving but hits maxIters", async () => {
    const applyFix = vi.fn(async () => {});
    // Strictly decreasing, never empty within 5 measures → never stalls,
    // but iteration 5 still has violations → exhausted.
    const res = await runFidelityLoop(
      deps({ measure: scriptedMeasure([5, 4, 3, 2, 1]), applyFix }),
    );

    expect(res.converged).toBe(false);
    expect(res.escalated).toBe(true);
    expect(res.reason).toBe("exhausted");
    expect(res.iterations).toBe(5);
    expect(res.history).toEqual([5, 4, 3, 2, 1]);
    expect(res.remaining).toHaveLength(1);
    // applyFix after iters 1..4; iter5 bails on budget before fixing.
    expect(applyFix).toHaveBeenCalledTimes(4);
  });

  it("honors a custom maxIters", async () => {
    const applyFix = vi.fn(async () => {});
    // maxIters=3, strictly decreasing → exhausted at iteration 3.
    const res = await runFidelityLoop(
      deps({ measure: scriptedMeasure([3, 2, 1]), applyFix, maxIters: 3 }),
    );

    expect(res.reason).toBe("exhausted");
    expect(res.iterations).toBe(3);
    expect(res.history).toEqual([3, 2, 1]);
    expect(applyFix).toHaveBeenCalledTimes(2);
  });

  it("honors a custom stallLimit (1 = bail on first non-improvement)", async () => {
    const applyFix = vi.fn(async () => {});
    // stallLimit=1: iter1 applies, iter2 count>=prev → stall=1 == limit → bail.
    const res = await runFidelityLoop(
      deps({ measure: scriptedMeasure([2, 2]), applyFix, stallLimit: 1 }),
    );

    expect(res.reason).toBe("stalled");
    expect(res.iterations).toBe(2);
    expect(res.history).toEqual([2, 2]);
    expect(applyFix).toHaveBeenCalledTimes(1);
  });

  it("treats a count INCREASE as non-progress (stall)", async () => {
    const applyFix = vi.fn(async () => {});
    // [2,3,4]: iter2 count>prev stall=1, iter3 count>prev stall=2 → stalled.
    const res = await runFidelityLoop(
      deps({ measure: scriptedMeasure([2, 3, 4]), applyFix }),
    );

    expect(res.reason).toBe("stalled");
    expect(res.history).toEqual([2, 3, 4]);
    expect(applyFix).toHaveBeenCalledTimes(2);
  });

  it("uses keyOf-bearing violations in `remaining` (different keys, same count still stalls)", async () => {
    const applyFix = vi.fn(async () => {});
    // Same count (2) every step but DIFFERENT key sets each time. Progress is
    // count-based, so this still stalls — and `remaining` carries the last
    // measured violations whose keys keyOf can read.
    const measure = scriptedMeasure([
      violations(2, "a-"),
      violations(2, "b-"),
      violations(2, "c-"),
    ]);
    const res = await runFidelityLoop(deps({ measure, applyFix }));

    expect(res.reason).toBe("stalled");
    expect(res.remaining.map(keyOf)).toEqual(["c-sel-0:color", "c-sel-1:color"]);
  });

  it("invokes onIteration once per measure with correct flags", async () => {
    const onIteration = vi.fn();
    await runFidelityLoop(
      deps({ measure: scriptedMeasure([2, 1, 0]), onIteration }),
    );

    expect(onIteration).toHaveBeenCalledTimes(3);
    expect(onIteration.mock.calls[0][0]).toEqual({
      iteration: 1,
      count: 2,
      converged: false,
    });
    expect(onIteration.mock.calls[2][0]).toEqual({
      iteration: 3,
      count: 0,
      converged: true,
    });
  });

  it("escalated is always the negation of converged", async () => {
    const conv = await runFidelityLoop(deps({ measure: scriptedMeasure([1, 0]) }));
    const esc = await runFidelityLoop(deps({ measure: scriptedMeasure([1, 1, 1]) }));

    expect(conv.escalated).toBe(!conv.converged);
    expect(esc.escalated).toBe(!esc.converged);
  });
});
