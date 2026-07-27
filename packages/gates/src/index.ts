export { checkContrast } from "./contrast.js";
export { checkButtonDoctrine, classifyButtonLabel } from "./button-doctrine.js";
export type { ButtonFacts } from "./button-doctrine.js";
export { checkVoice, classifyVoice, DEFAULT_BANNED } from "./voice.js";
export type { VoiceOptions, VoiceFacts } from "./voice.js";
export { checkBrandPresence, classifyBrand } from "./brand-presence.js";
export { checkMockUx, judgeMockUx, MOCK_UX_PROBE, type MockUxFacts } from "./mock-ux.js";
export type { BrandFacts } from "./brand-presence.js";
export { checkTapTargets } from "./tap-targets.js";
export { checkNoOverflow } from "./overflow.js";
export type { GateViolation } from "./types.js";

// Fidelity eye (design #8) — visual + behavioural mock-vs-prod diff.
export { captureSnapshot, FIDELITY_STYLE_PROPS, COLOR_PROPS } from "./fidelity/snapshot.js";
export type { StyleSnapshot, ElementSnapshot, SnapshotContext } from "./fidelity/snapshot.js";
export { diffSnapshots, summariseFidelity } from "./fidelity/diff.js";
export type { FidelityViolation, FidelityAxis, DiffOptions } from "./fidelity/diff.js";
export { gradeFidelity, runFidelityGate } from "./fidelity/gate.js";
export type { FidelityGateOptions, FidelityGateResult } from "./fidelity/gate.js";

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

/**
 * The storyteller's per-page composite (vibe tell / vibe check hooks):
 * doctrine + voice + brand, all driver-agnostic (string-evaluate seam).
 * runGate1 (contrast/tap/overflow) stays Playwright-typed and separate.
 */
export async function runTellGates(
  page: { evaluate<T>(expression: string): Promise<T> },
  opts?: { voice?: import("./voice.js").VoiceOptions },
): Promise<GateViolation[]> {
  const { checkButtonDoctrine } = await import("./button-doctrine.js");
  const { checkVoice } = await import("./voice.js");
  const { checkBrandPresence } = await import("./brand-presence.js");
  const { checkMockUx } = await import("./mock-ux.js");
  const [buttons, voice, brand, ux] = await Promise.all([
    checkButtonDoctrine(page),
    checkVoice(page, opts?.voice),
    checkBrandPresence(page),
    checkMockUx(page),
  ]);
  return [...buttons, ...voice, ...brand, ...ux];
}
