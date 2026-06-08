/**
 * design #8 — reusable eye runner. Renders a reference (mock) URL + a candidate
 * (brewed) URL across a capture matrix in headless Chromium, screenshots each
 * cell, and grades candidate-vs-reference with the gates fidelity engine.
 * Shared by the `slowcook eye` command (./index.ts) and the eye-driven brew
 * fidelity phase (../brew/fidelity-phase.ts) so both measure identically.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
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
  /** Directory for screenshots. Files named `<label>-<viewport>-<scheme>[-<locale>].png`. */
  outDir: string;
  gate?: FidelityGateOptions;
  /** Screenshot filename prefix (e.g. `eye-pr-123`); default none. */
  shotPrefix?: string;
  /**
   * design §4 — shared-fixture scenario, appended as `?scenario=<name>` to BOTH
   * sides so the mock's mock-data layer + the candidate's dev-only data adaptor
   * render the SAME data → only real UI drift, no data noise.
   */
  scenario?: string;
}

/**
 * Pure: build the per-cell URL by merging the §6 locale (`lang=`) and §4
 * scenario (`scenario=`) query params into `url`, preserving any params already
 * present (e.g. `?__preview=1`). Applied identically to reference + candidate so
 * both render the same locale/fixture. Returns `url` unchanged when neither
 * applies and the URL has no params to normalise.
 */
export function withEyeParams(url: string, ctx: EyeContext, scenario?: string): string {
  if (!ctx.locale && !scenario) return url;
  try {
    const u = new URL(url);
    if (ctx.locale) u.searchParams.set("lang", ctx.locale);
    if (scenario) u.searchParams.set("scenario", scenario);
    return u.toString();
  } catch {
    // Relative/opaque URL — fall back to naive append (keeps existing query).
    const sep = url.includes("?") ? "&" : "?";
    const extra = [
      ctx.locale ? `lang=${encodeURIComponent(ctx.locale)}` : "",
      scenario ? `scenario=${encodeURIComponent(scenario)}` : "",
    ].filter(Boolean).join("&");
    return extra ? `${url}${sep}${extra}` : url;
  }
}

/** Pure: screenshot/label suffix for a cell — locale appended only when present. */
export function cellLabel(ctx: EyeContext): string {
  return `${ctx.viewport}-${ctx.scheme}${ctx.locale ? `-${ctx.locale}` : ""}`;
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
    await page.goto(withEyeParams(url, ctx, opts.scenario), { waitUntil: "networkidle" });
    await page.waitForTimeout(400); // let lazy / client styles settle
    const shot = join(opts.outDir, `${prefix}${label}-${cellLabel(ctx)}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    screenshots.push(shot);
    const snap = await captureSnapshot(page, { viewport: ctx.viewport, scheme: ctx.scheme, locale: ctx.locale });
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

/** Pure: one-line pass summary for the watch loop (`violations: N → M (Δ)`). */
export function formatPassLine(pass: number, prevTotal: number | null, result: FidelityGateResult): string {
  const c = result.violations.length;
  const delta = prevTotal === null ? "" : ` (Δ${c - prevTotal >= 0 ? "+" : ""}${c - prevTotal})`;
  return `pass ${pass}: ${c} violation(s)${delta} ${result.passed ? "PASS" : "FAIL"} ${JSON.stringify(result.summary.byAxis)}`;
}

export interface WatchEyeOptions extends RunEyeOptions {
  intervalMs: number;
  untilConverged: boolean;
  maxPasses: number;
  /** Injectable for tests/logging; defaults to console.log. */
  log?: (msg: string) => void;
}

export interface WatchEyeResult {
  result: FidelityGateResult;
  passes: number;
  converged: boolean;
}

/**
 * sc#189 — warm-browser HMR re-eye loop. Captures the reference (static mock)
 * ONCE per cell, keeps a warm candidate page per cell, and re-captures ONLY the
 * candidate each pass (a `reload()` picks up HMR edits with no rebuild). Prints
 * the per-axis violation delta each pass; with `untilConverged`, exits as soon
 * as the gate passes. Bounded by `maxPasses`. The warm browser + reference-once
 * capture is the win over re-running one-shot `eye` per iteration.
 */
export async function runEyeWatch(opts: WatchEyeOptions): Promise<WatchEyeResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  mkdirSync(opts.outDir, { recursive: true });
  const browser = await chromium.launch();

  const cells: { ctx: EyeContext; reference: StyleSnapshot; page: Page; close: () => Promise<void> }[] = [];
  try {
    const newCell = async (url: string, ctx: EyeContext) => {
      const c = await browser.newContext({
        colorScheme: ctx.scheme,
        viewport: { width: ctx.width, height: ctx.height },
        deviceScaleFactor: 2,
      });
      const p = await c.newPage();
      await p.goto(withEyeParams(url, ctx, opts.scenario), { waitUntil: "networkidle" });
      await p.waitForTimeout(400);
      return { c, p };
    };
    for (const ctx of opts.matrix) {
      const ref = await newCell(opts.referenceUrl, ctx);
      const reference = await captureSnapshot(ref.p, { viewport: ctx.viewport, scheme: ctx.scheme, locale: ctx.locale });
      await ref.c.close(); // reference is static — capture once, release it
      const cand = await newCell(opts.candidateUrl, ctx);
      cells.push({ ctx, reference, page: cand.p, close: () => cand.c.close() });
    }

    let prevTotal: number | null = null;
    let result!: FidelityGateResult;
    let converged = false;
    let pass = 1;
    for (; pass <= opts.maxPasses; pass++) {
      const pairs: { reference: StyleSnapshot; candidate: StyleSnapshot }[] = [];
      for (const cell of cells) {
        await cell.page.reload({ waitUntil: "networkidle" });
        await cell.page.waitForTimeout(300);
        const candidate = await captureSnapshot(cell.page, { viewport: cell.ctx.viewport, scheme: cell.ctx.scheme, locale: cell.ctx.locale });
        pairs.push({ reference: cell.reference, candidate });
      }
      result = gradeFidelity(pairs, opts.gate);
      log(formatPassLine(pass, prevTotal, result));
      prevTotal = result.violations.length;
      if (opts.untilConverged && result.passed) {
        converged = true;
        log("converged ✓");
        break;
      }
      if (pass < opts.maxPasses) await new Promise((r) => setTimeout(r, opts.intervalMs));
    }
    return { result, passes: Math.min(pass, opts.maxPasses), converged };
  } finally {
    for (const cell of cells) await cell.close().catch(() => {});
    await browser.close();
  }
}
