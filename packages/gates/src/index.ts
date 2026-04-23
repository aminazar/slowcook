export { checkContrast } from "./contrast.js";
export { checkTapTargets } from "./tap-targets.js";
export { checkNoOverflow } from "./overflow.js";
export type { GateViolation } from "./types.js";

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
