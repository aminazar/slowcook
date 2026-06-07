/**
 * design #8 — reusable eye runner. Renders a reference (mock) URL + a candidate
 * (brewed) URL across a capture matrix in headless Chromium, screenshots each
 * cell, and grades candidate-vs-reference with the gates fidelity engine.
 * Shared by the `slowcook eye` command (./index.ts) and the eye-driven brew
 * fidelity phase (../brew/fidelity-phase.ts) so both measure identically.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import {
  captureSnapshot,
  gradeFidelity,
  type FidelityGateOptions,
  type FidelityGateResult,
  type StyleSnapshot,
} from "@slowcook-ai/gates";
import type { EyeContext } from "./plan.js";

export interface RunEyeOptions {
  referenceUrl: string;
  candidateUrl: string;
  matrix: EyeContext[];
  /** Directory for screenshots. Files named `<label>-<viewport>-<scheme>.png`. */
  outDir: string;
  gate?: FidelityGateOptions;
  /** Screenshot filename prefix (e.g. `eye-pr-123`); default none. */
  shotPrefix?: string;
}

export interface RunEyeResult {
  result: FidelityGateResult;
  screenshots: string[];
}

/** Render + grade the full matrix. Launches one browser, a fresh context per cell. */
export async function runEyeMatrix(opts: RunEyeOptions): Promise<RunEyeResult> {
  mkdirSync(opts.outDir, { recursive: true });
  const prefix = opts.shotPrefix ? `${opts.shotPrefix}-` : "";
  const browser = await chromium.launch();
  const screenshots: string[] = [];

  const captureUrl = async (url: string, label: string, ctx: EyeContext): Promise<StyleSnapshot> => {
    const c = await browser.newContext({
      colorScheme: ctx.scheme,
      viewport: { width: ctx.width, height: ctx.height },
      deviceScaleFactor: 2,
    });
    const page = await c.newPage();
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(400); // let lazy / client styles settle
    const shot = join(opts.outDir, `${prefix}${label}-${ctx.viewport}-${ctx.scheme}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    screenshots.push(shot);
    const snap = await captureSnapshot(page, { viewport: ctx.viewport, scheme: ctx.scheme });
    await c.close();
    return snap;
  };

  const pairs: { reference: StyleSnapshot; candidate: StyleSnapshot }[] = [];
  try {
    for (const ctx of opts.matrix) {
      const reference = await captureUrl(opts.referenceUrl, "reference", ctx);
      const candidate = await captureUrl(opts.candidateUrl, "candidate", ctx);
      pairs.push({ reference, candidate });
    }
  } finally {
    await browser.close();
  }

  return { result: gradeFidelity(pairs, opts.gate), screenshots };
}
