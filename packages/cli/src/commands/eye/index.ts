/**
 * design #8 — `slowcook eye`. Renders a reference (mock) URL and a candidate
 * (brewed) URL across the (viewport × scheme) matrix in headless Chromium,
 * grades candidate-vs-reference with the gates fidelity engine, writes
 * screenshots + a JSON report, and exits 1 when the gate fails. This is the
 * runnable eye behind the brew-loop + the #9 designer/QA gate; it consumes
 * `references.visual` as the reference URL and the spec's fidelity.modes for
 * the matrix.
 *
 *   slowcook eye --reference http://localhost:33010 --candidate http://localhost:3001 \
 *     [--story 020] [--cwd .] [--out .brewing/eye] [--viewport mobile|desktop] \
 *     [--scheme light|dark] [--max-violations N] [--fail-on color,box,computed-style,missing]
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEyeArgs, matrixFromModes, narrowMatrix } from "./plan.js";
import { loadFidelityModes } from "./spec-modes.js";
import { runEyeMatrix, runEyeWatch } from "./run.js";

export async function eye(args: string[], _version: string): Promise<void> {
  if (args[0] === "--help" || args[0] === "-h") {
    console.log("usage: slowcook eye --reference <url> --candidate <url> [--story <id>] [--cwd <dir>] [--out dir] [--viewport m] [--scheme s] [--max-violations N] [--fail-on a,b] [--watch [--interval ms] [--until-converged] [--max-passes N]]");
    return;
  }

  let opts;
  try {
    opts = parseEyeArgs(args);
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(64);
  }

  // Spec-declared modes (the contract) override the default matrix; explicit
  // --viewport/--scheme flags still narrow on top.
  if (opts.story) {
    const modes = loadFidelityModes(opts.cwd, opts.story);
    if (modes && modes.length) {
      opts.matrix = narrowMatrix(matrixFromModes(modes), { viewport: opts.viewport, scheme: opts.scheme });
      console.log(`eye: matrix from story-${opts.story} fidelity.modes [${modes.join(", ")}] → ${opts.matrix.length} cell(s)`);
    } else {
      console.log(`eye: story-${opts.story} declares no fidelity.modes; using ${opts.matrix.length}-cell default matrix`);
    }
  }

  // sc#189 — warm-browser HMR re-eye loop for fast visual convergence.
  if (opts.watch) {
    console.log(`eye --watch: ${opts.matrix.length} cell(s) · interval ${opts.intervalMs}ms · max ${opts.maxPasses} passes${opts.untilConverged ? " · until-converged" : ""}`);
    const { result, passes, converged } = await runEyeWatch({
      referenceUrl: opts.referenceUrl,
      candidateUrl: opts.candidateUrl,
      matrix: opts.matrix,
      outDir: opts.outDir,
      gate: opts.gate,
      intervalMs: opts.intervalMs,
      untilConverged: opts.untilConverged,
      maxPasses: opts.maxPasses,
    });
    writeFileSync(join(opts.outDir, "eye-report.json"), JSON.stringify({ ...result, passes, converged }, null, 2));
    console.log(`\nslowcook eye --watch — ${result.passed ? "PASS ✓" : "FAIL ✗"} after ${passes} pass(es)`);
    if (opts.untilConverged && !result.passed) process.exit(1);
    return;
  }

  const { result, screenshots } = await runEyeMatrix({
    referenceUrl: opts.referenceUrl,
    candidateUrl: opts.candidateUrl,
    matrix: opts.matrix,
    outDir: opts.outDir,
    gate: opts.gate,
  });
  writeFileSync(join(opts.outDir, "eye-report.json"), JSON.stringify({ ...result, screenshots }, null, 2));

  console.log(`\nslowcook eye — ${result.passed ? "PASS ✓" : "FAIL ✗"} (${result.violations.length} violation(s) across ${opts.matrix.length} render(s))`);
  for (const ctx of result.byContext) {
    if (ctx.violations.length === 0) continue;
    console.log(`  [${ctx.context.viewport}/${ctx.context.scheme}] ${ctx.violations.length}: ${JSON.stringify(ctx.summary.byAxis)}`);
    for (const v of ctx.violations.slice(0, 5)) console.log(`     ${v.axis}: ${v.evidence}`);
  }
  console.log(`  screenshots + report → ${opts.outDir}/`);

  if (!result.passed) process.exit(1);
}
