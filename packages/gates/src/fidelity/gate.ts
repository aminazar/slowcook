import type { Page } from "@playwright/test";
import {
  diffSnapshots,
  summariseFidelity,
  type DiffOptions,
  type FidelityAxis,
  type FidelityViolation,
} from "./diff.js";
import {
  captureSnapshot,
  type SnapshotContext,
  type StyleSnapshot,
} from "./snapshot.js";

/**
 * Fidelity gate (design #8) — the "fidelity eye". Grades one or more
 * (reference, candidate) snapshot pairs (e.g. the viewport×scheme matrix)
 * into a single pass/fail verdict, carrying the flat `FidelityViolation`
 * fix-signals through so a failing gate hands brew exactly what to fix.
 *
 * The grading (`gradeFidelity`) is pure + browser-free → fully unit-tested
 * here. The Playwright capture that produces the snapshots is a thin
 * wrapper (`runFidelityGate`) that defers to `captureSnapshot` + this pure
 * core. Same split as the diff/snapshot pair it sits on top of.
 */

export interface FidelityGateOptions {
  /** Max kept violations that still passes. Default 0 — any violation fails. */
  maxViolations?: number;
  /**
   * If set, only violations on these axes count toward the returned
   * violations + the pass/fail decision. Unset → all axes count.
   */
  failOnAxes?: FidelityAxis[];
  /** Forwarded to `diffSnapshots` (boxTolerancePx, boxDims). */
  diff?: DiffOptions;
}

export interface FidelityGateResult {
  passed: boolean;
  /** All kept violations across all pairs (after axis filtering). */
  violations: FidelityViolation[];
  summary: ReturnType<typeof summariseFidelity>;
  /** Per-pair breakdown, one entry per input pair. */
  byContext: {
    context: SnapshotContext;
    violations: FidelityViolation[];
    summary: ReturnType<typeof summariseFidelity>;
  }[];
}

/**
 * Grade `(reference, candidate)` snapshot pairs into a single verdict.
 *
 * Each pair is diffed independently; if `failOnAxes` is set, only
 * violations on those axes are kept (for both the returned lists and the
 * pass/fail decision). The gate passes when the total kept violation count
 * across all pairs is within `maxViolations` (default 0). `byContext`
 * groups the kept violations by each pair's `reference.context`.
 *
 * Pure + browser-free → the load-bearing, fully unit-tested function.
 */
export function gradeFidelity(
  pairs: { reference: StyleSnapshot; candidate: StyleSnapshot }[],
  opts: FidelityGateOptions = {}
): FidelityGateResult {
  const maxViolations = opts.maxViolations ?? 0;
  const axisFilter = opts.failOnAxes ? new Set(opts.failOnAxes) : undefined;

  const violations: FidelityViolation[] = [];
  const byContext: FidelityGateResult["byContext"] = [];

  for (const pair of pairs) {
    const raw = diffSnapshots(pair.reference, pair.candidate, opts.diff);
    const kept = axisFilter ? raw.filter((v) => axisFilter.has(v.axis)) : raw;
    violations.push(...kept);
    byContext.push({
      context: pair.reference.context,
      violations: kept,
      summary: summariseFidelity(kept),
    });
  }

  return {
    passed: violations.length <= maxViolations,
    violations,
    summary: summariseFidelity(violations),
    byContext,
  };
}

/**
 * Thin Playwright wrapper: capture both pages at their current state under
 * one `context`, then grade the resulting pair. Caller sets the viewport +
 * scheme (and any event step) on both pages before calling and passes the
 * matching `context`.
 *
 * Not unit-tested (needs a real browser); the load-bearing logic lives in
 * the pure `gradeFidelity`.
 */
export async function runFidelityGate(
  referencePage: Page,
  candidatePage: Page,
  context: SnapshotContext,
  opts: FidelityGateOptions = {}
): Promise<FidelityGateResult> {
  const reference = await captureSnapshot(referencePage, context);
  const candidate = await captureSnapshot(candidatePage, context);
  return gradeFidelity([{ reference, candidate }], opts);
}
