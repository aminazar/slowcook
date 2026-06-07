/**
 * design #8 — `slowcook eye`. Renders a reference (mock) URL and a candidate
 * (brewed) URL across the (viewport × scheme) matrix in headless Chromium,
 * captures a fidelity snapshot of each, grades candidate-vs-reference with the
 * gates fidelity engine, writes screenshots + a JSON report, and exits 1 when
 * the gate fails. This is the runnable eye behind the brew-loop + the #9
 * designer/QA gate; it consumes `references.visual` as the reference URL.
 *
 *   slowcook eye --reference http://localhost:33010 --candidate http://localhost:3001 \
 *     [--out .brewing/eye] [--viewport mobile|desktop] [--scheme light|dark] \
 *     [--max-violations N] [--fail-on color,box,computed-style,missing]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { captureSnapshot, gradeFidelity, type StyleSnapshot } from "@slowcook-ai/gates";
import { parseEyeArgs, type EyeContext } from "./plan.js";

export async function eye(args: string[], _version: string): Promise<void> {
  if (args[0] === "--help" || args[0] === "-h") {
    console.log("usage: slowcook eye --reference <url> --candidate <url> [--out dir] [--viewport m] [--scheme s] [--max-violations N] [--fail-on a,b]");
    return;
  }

  let opts;
  try {
    opts = parseEyeArgs(args);
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(64);
  }

  mkdirSync(opts.outDir, { recursive: true });
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
    const shot = join(opts.outDir, `${label}-${ctx.viewport}-${ctx.scheme}.png`);
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

  const result = gradeFidelity(pairs, opts.gate);
  writeFileSync(join(opts.outDir, "eye-report.json"), JSON.stringify({ ...result, screenshots }, null, 2));

  console.log(`\nslowcook eye — ${result.passed ? "PASS ✓" : "FAIL ✗"} (${result.violations.length} violation(s) across ${pairs.length} render(s))`);
  for (const ctx of result.byContext) {
    if (ctx.violations.length === 0) continue;
    console.log(`  [${ctx.context.viewport}/${ctx.context.scheme}] ${ctx.violations.length}: ${JSON.stringify(ctx.summary.byAxis)}`);
    for (const v of ctx.violations.slice(0, 5)) console.log(`     ${v.axis}: ${v.evidence}`);
  }
  console.log(`  screenshots + report → ${opts.outDir}/`);

  if (!result.passed) process.exit(1);
}
