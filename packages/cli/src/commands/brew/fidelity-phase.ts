/**
 * design #8 — the post-green fidelity phase. After brew's behavioural/structural
 * tests pass, render the brewed app vs the mock across the spec-declared modes
 * and either (a) gate: drift → escalate to the #9 designer/QA gate, or (b) drive:
 * feed the hard per-element violations back to the brew agent over a hot-reload
 * candidate, bounded, until convergence or escalation.
 *
 * The eye measurement + the brew-fix application are INJECTED — the orchestration
 * (matrix from spec, loop, escalation mapping) is pure-flow + unit-tested; the
 * Playwright render (../eye/run.ts) and the live brew-agent fix supply the seams.
 */
import type { FidelityViolation } from "@slowcook-ai/gates";
import { runFidelityLoop } from "./fidelity-loop.js";
import { loadFidelityModes } from "../eye/spec-modes.js";
import { matrixFromModes, DEFAULT_MATRIX, type EyeContext } from "../eye/plan.js";

/**
 * Render violations into a concise, mock-faithful fix instruction for the brew
 * agent. Grouped by viewport/scheme; scoped to presentation-only edits. Pure.
 */
export function formatViolationsForBrew(violations: FidelityViolation[]): string {
  if (violations.length === 0) return "No fidelity violations.";
  const byCtx = new Map<string, FidelityViolation[]>();
  for (const v of violations) {
    const k = `${v.context.viewport}/${v.context.scheme}`;
    const arr = byCtx.get(k) ?? [];
    arr.push(v);
    byCtx.set(k, arr);
  }
  const lines = [
    "Visual fidelity drift vs the approved mock. Edit ONLY the presentation of the",
    "affected @slowcook-port-from components to restore the mock's rendering — do not",
    "change behaviour, data-wiring, or markup structure, only the diverged styling:",
    "",
  ];
  for (const [ctx, vs] of byCtx) {
    lines.push(`## ${ctx}`);
    for (const v of vs) {
      lines.push(`- \`${v.selector}\`: ${v.property} should be ${v.expected} (currently ${v.actual}) [${v.axis}]`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export interface FidelityPhaseDeps {
  /** Story id — used to resolve the spec's fidelity.modes. */
  story?: string;
  /** Repo root for the spec lookup. */
  cwd: string;
  /** Render + grade the matrix → violations (real: a runEyeMatrix wrapper). */
  measure: (matrix: EyeContext[]) => Promise<FidelityViolation[]>;
  /**
   * Apply fixes via the brew agent against a hot-reload candidate, then the
   * caller's HMR re-renders. OMIT for gate-only mode (drift → escalate, no fix).
   */
  applyFix?: (violations: FidelityViolation[], iteration: number) => Promise<void>;
  maxIters?: number;
  log?: (msg: string) => void;
}

export interface FidelityPhaseResult {
  converged: boolean;
  escalated: boolean;
  iterations: number;
  remaining: FidelityViolation[];
  reason: string;
  /** The #9 gate action: pass advances; blocked-on-designer halts for review. */
  gateAction: "pass" | "blocked-on-designer";
  matrixCells: number;
}

const keyOf = (v: FidelityViolation): string =>
  `${v.context.viewport}/${v.context.scheme}|${v.selector}|${v.property}`;

/**
 * Run the fidelity phase. Matrix comes from the spec's fidelity.modes (the
 * contract) or the full default. Gate-only when `applyFix` is omitted.
 */
export async function runFidelityPhase(deps: FidelityPhaseDeps): Promise<FidelityPhaseResult> {
  const modes = deps.story ? loadFidelityModes(deps.cwd, deps.story) : null;
  const matrix = modes && modes.length ? matrixFromModes(modes) : DEFAULT_MATRIX;
  deps.log?.(`fidelity phase: ${matrix.length} cell(s)${deps.applyFix ? " (driving)" : " (gate-only)"}`);
  const measure = (): Promise<FidelityViolation[]> => deps.measure(matrix);

  // Gate-only: one measurement; drift escalates to the designer/QA gate.
  if (!deps.applyFix) {
    const violations = await measure();
    const converged = violations.length === 0;
    return {
      converged,
      escalated: !converged,
      iterations: 1,
      remaining: violations,
      reason: converged ? "converged" : "drift (gate-only — escalating)",
      gateAction: converged ? "pass" : "blocked-on-designer",
      matrixCells: matrix.length,
    };
  }

  // Eye-driven correction loop (bounded; escalates on stall/exhaustion).
  const loop = await runFidelityLoop<FidelityViolation>({
    measure,
    applyFix: deps.applyFix,
    keyOf,
    maxIters: deps.maxIters,
    onIteration: deps.log ? (i) => deps.log!(`  iter ${i.iteration}: ${i.count} violation(s)`) : undefined,
  });

  return {
    converged: loop.converged,
    escalated: loop.escalated,
    iterations: loop.iterations,
    remaining: loop.remaining,
    reason: loop.reason,
    gateAction: loop.converged ? "pass" : "blocked-on-designer",
    matrixCells: matrix.length,
  };
}
