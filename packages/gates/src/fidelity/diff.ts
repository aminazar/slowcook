import {
  COLOR_PROPS,
  type ElementSnapshot,
  type SnapshotContext,
  type StyleSnapshot,
} from "./snapshot.js";

/**
 * Pure fidelity diff (design #8). Compares a reference snapshot (the
 * `references.visual` render — the target) against a candidate snapshot
 * (brew output) and emits a flat list of `FidelityViolation`s: hard,
 * per-element, per-property fix-signals brew can act on directly
 * ("`.hero-cta`: padding-top 12px → 16px"), rather than a soft "looks off".
 *
 * Pure + browser-free → fully unit-tested here. The Playwright capture
 * that produces the snapshots lives in ./snapshot.ts.
 */

export type FidelityAxis = "computed-style" | "color" | "box" | "missing";

export interface FidelityViolation {
  /** Reference selector of the offending element. */
  selector: string;
  axis: FidelityAxis;
  /** CSS property or box dimension that diverged (e.g. "padding-top", "width"). */
  property: string;
  /** Reference (target) value. */
  expected: string;
  /** Candidate (brew output) value. */
  actual: string;
  /** Agent/human-facing one-line fix instruction. */
  evidence: string;
  /** Capture context the violation was found in. */
  context: SnapshotContext;
}

export interface DiffOptions {
  /**
   * Box-dimension tolerance in CSS px; deltas ≤ this are ignored
   * (sub-pixel rounding, scrollbar jitter). Default 1.
   */
  boxTolerancePx?: number;
  /**
   * Box dimensions to compare. Default ["width", "height"] — position
   * (x/y) is noisy and usually a downstream effect of a size/spacing diff.
   */
  boxDims?: ReadonlyArray<"x" | "y" | "width" | "height">;
}

/**
 * Diff two snapshots. Elements are matched by selector; a reference
 * element with no candidate match yields a `missing` violation (brew did
 * not render it). Selectors present only in the candidate are ignored —
 * the reference is the contract, and extra prod chrome is allowed.
 */
export function diffSnapshots(
  reference: StyleSnapshot,
  candidate: StyleSnapshot,
  options: DiffOptions = {}
): FidelityViolation[] {
  const tolerance = options.boxTolerancePx ?? 1;
  const boxDims = options.boxDims ?? (["width", "height"] as const);
  const context = reference.context;

  const candidateBySelector = new Map<string, ElementSnapshot>();
  for (const el of candidate.elements) {
    // first occurrence wins — document order, matches reference walk
    if (!candidateBySelector.has(el.selector)) {
      candidateBySelector.set(el.selector, el);
    }
  }

  const violations: FidelityViolation[] = [];

  for (const ref of reference.elements) {
    const cand = candidateBySelector.get(ref.selector);

    if (!cand) {
      violations.push({
        selector: ref.selector,
        axis: "missing",
        property: "element",
        expected: "present",
        actual: "absent",
        evidence: `${ref.selector}: present in reference, absent in candidate render`,
        context,
      });
      continue;
    }

    // computed-style + color axes
    for (const [prop, expected] of Object.entries(ref.styles)) {
      const actual = cand.styles[prop];
      if (actual === undefined || actual === expected) continue;
      const axis: FidelityAxis = COLOR_PROPS.has(prop) ? "color" : "computed-style";
      violations.push({
        selector: ref.selector,
        axis,
        property: prop,
        expected,
        actual,
        evidence: `${ref.selector}: ${prop} ${expected} → ${actual}`,
        context,
      });
    }

    // box axis
    for (const dim of boxDims) {
      const e = ref.box[dim];
      const a = cand.box[dim];
      if (Math.abs(e - a) <= tolerance) continue;
      violations.push({
        selector: ref.selector,
        axis: "box",
        property: dim,
        expected: `${e}px`,
        actual: `${a}px`,
        evidence: `${ref.selector}: ${dim} ${e}px → ${a}px (Δ${a - e}px)`,
        context,
      });
    }
  }

  return violations;
}

/**
 * Convenience: total + per-axis counts for gate thresholds + reporting.
 */
export function summariseFidelity(violations: FidelityViolation[]): {
  total: number;
  byAxis: Record<FidelityAxis, number>;
} {
  const byAxis: Record<FidelityAxis, number> = {
    "computed-style": 0,
    color: 0,
    box: 0,
    missing: 0,
  };
  for (const v of violations) byAxis[v.axis]++;
  return { total: violations.length, byAxis };
}
