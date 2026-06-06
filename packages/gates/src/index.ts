export { checkContrast } from "./contrast.js";
export { checkTapTargets } from "./tap-targets.js";
export { checkNoOverflow } from "./overflow.js";
export type { GateViolation } from "./types.js";

// Fidelity eye (design #8) — visual + behavioural mock-vs-prod diff.
export { captureSnapshot, FIDELITY_STYLE_PROPS, COLOR_PROPS } from "./fidelity/snapshot.js";
export type { StyleSnapshot, ElementSnapshot, SnapshotContext } from "./fidelity/snapshot.js";
export { diffSnapshots, summariseFidelity } from "./fidelity/diff.js";
export type { FidelityViolation, FidelityAxis, DiffOptions } from "./fidelity/diff.js";

import type { Page } from "@playwright/test";
import { checkContrast } from "./contrast.js";
import { checkTapTargets } from "./tap-targets.js";
import { checkNoOverflow } from "./overflow.js";
import type { GateViolation } from "./types.js";

/**
 * Run every Gate 1 check against a page and return a flat violation
 * list. Caller asserts `toEqual([])`. Kept intentionally simple — no
 * scoring, no allow-lists; a violation is a violation. Consumers who
 * need per-story exceptions run the individual checks + filter in
 * their own test.
 */
export async function runGate1(page: Page): Promise<GateViolation[]> {
  const [contrast, tapTargets, overflow] = await Promise.all([
    checkContrast(page),
    checkTapTargets(page),
    checkNoOverflow(page),
  ]);
  return [...contrast, ...tapTargets, ...overflow];
}
