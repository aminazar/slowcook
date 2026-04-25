import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  copyFileSync,
} from "node:fs";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";
import { execSync } from "node:child_process";
import YAML from "yaml";
import Anthropic from "@anthropic-ai/sdk";
import type { ForgeAdapter, Spec } from "@slowcook-ai/core";
import {
  runTests,
  type RunResult,
  type TestResult,
  validateStackConfig,
  type StackConfig,
  runLint,
  formatLintIssues,
  type LintResult,
} from "@slowcook-ai/stack-ts";
import { recordBrewProvenance } from "./provenance.js";
import { sliceSpecForTarget, renderSpecSlice } from "./spec-slice.js";
import { readSpec } from "../refine/spec-yaml.js";
import {
  BREW_SYSTEM,
  BREW_TOOLS,
  turnPrompt,
  turnPromptParts,
} from "./prompts.js";
import {
  writeHaltReport,
  haltReportToMarkdown,
  defaultSuggestedActions,
  type HaltReason,
  type HaltReport,
  type IterationDiff,
} from "./halt.js";
import { generateMap } from "../map/scan.js";
import { writeFreshMap } from "../map/index.js";
import { CODE_MAP_JSON_PATH, CODE_MAP_MD_PATH } from "../map/render.js";

/** ------------------------- Context + options ------------------------- */

export interface BrewContext {
  repoRoot: string;
  storyId: string;
  spec: Spec;
  stackConfig: StackConfig;
  forge: ForgeAdapter;
  anthropic: Anthropic;
  model: string;
  budgetUsd: number;
  maxIterations: number;
  wallClockMs: number;
  now: () => Date;
  /** Branch to push checkpoints onto. */
  branchName: string;
  /** Paths writable by this brew session, as declared in the spec (or inferred). */
  allowedPaths: string[];
  /** Paths frozen under .brewing/frozen-paths.json (relative to cwd). */
  frozenPaths: FrozenPaths;
  /** Where to write halt reports. */
  haltDir: string;
  /**
   * Optional path for the rolling iteration log. One line per loop state
   * change (baseline, per-iter outcome, halt) so an operator can tail the
   * file during a long brew without waiting for the CI log to flush.
   */
  runLogPath?: string;
  /** slowcook CLI version; threaded into the code map's `slowcook_version` field. */
  cliVersion: string;
}

export interface FrozenPaths {
  directories: string[];
  files: string[];
  partial: Record<string, { frozen_key_paths?: string[] }>;
}

/** ------------------------- Result ------------------------- */

export type BrewOutcome =
  | { kind: "success"; iterations: number; checkpoints: number; spendUsd: number }
  | { kind: "halted"; report: HaltReport };

/** ------------------------- Ratchet state ------------------------- */

interface IterationLog {
  iteration: number;
  target_test_id: string;
  outcome:
    | "checkpoint"
    | "reverted-regression"
    | "reverted-no-progress"
    | "rejected-overflow"
    | "rejected-frozen-path"
    | "test-runner-broken";
  note: string;
  files_touched: string[];
  lines_added: number;
  lines_removed: number;
  spend_delta_usd: number;
  rationale: string;
  broken_tests?: string[];
}

const DIFF_LINE_CAP = 200;
const DIFF_FILE_CAP = 5;
const STAGNATION_CAP = 15;

/**
 * 0.11.15+ — opt the tools block into Anthropic's prompt cache by
 * attaching cache_control to the LAST tool definition. The API caches
 * everything up through the tagged tool, including the system prompt
 * and tools themselves. Returns a fresh array; doesn't mutate input.
 *
 * Done as a helper because BREW_TOOLS is a const exported from
 * prompts.ts and we don't want to bake the cache directive into the
 * shared definition (other agents that consume the same tool list
 * may not benefit from caching).
 */
function addCacheControlToLastTool(tools: readonly unknown[]): unknown[] {
  if (tools.length === 0) return [];
  const last = tools[tools.length - 1] as Record<string, unknown>;
  const tagged = { ...last, cache_control: { type: "ephemeral" } };
  return [...tools.slice(0, -1), tagged];
}

const PRICING_PER_M_TOKENS: Record<string, { input: number; output: number }> = {
  "claude-opus-4-7": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 0.8, output: 4 },
};

export async function runBrew(ctx: BrewContext): Promise<BrewOutcome> {
  const startMs = ctx.now().getTime();
  // Initialise the rolling run log before anything else. The first line
  // records the parameters the brew started with, so tailing the file
  // gives an operator the full picture without touching CI logs.
  if (ctx.runLogPath) {
    try {
      mkdirSync(dirname(ctx.runLogPath), { recursive: true });
      writeFileSync(
        ctx.runLogPath,
        `# slowcook brew · story-${ctx.storyId} · branch ${ctx.branchName}\n` +
          `# budget $${ctx.budgetUsd.toFixed(2)} · max ${ctx.maxIterations} iter · model ${ctx.model}\n`,
        "utf8"
      );
    } catch {
      /* ignore — best effort */
    }
  }
  appendRunLog(ctx, "START");

  // Regenerate the code map before baseline so iteration 1's prompt can
  // point the agent at .brewing/code-map.json. Cheap (ts-morph scan of src/).
  regenerateCodeMap(ctx, "start");

  const manifestPath = join(ctx.repoRoot, ".brewing/manifests", `story-${ctx.storyId}.json`);
  if (!existsSync(manifestPath)) {
    return haltFor(ctx, {
      reason: "TEST_RUNNER_BROKEN",
      iterations: 0,
      checkpoints: 0,
      greenCount: 0,
      totalCount: 0,
      spendUsd: 0,
      summary: `No manifest found at \`.brewing/manifests/story-${ctx.storyId}.json\`. Run testgen first.`,
    });
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    tests: Array<{ id: string; file: string }>;
  };
  const expectedTestIds = new Set(manifest.tests.map((t) => t.id));

  // 0.11.16+ — derive per-iter test scope from manifest. Per-iter
  // runs only the story's tests (cheap heuristic); the
  // brew-completion full-suite gate catches transitive regressions
  // in other stories before we open the PR.
  const storyTestFiles = deriveStoryTestFiles(manifest.tests);

  // Baseline: run scoped to the story's tests so the iter loop's
  // greenSet/redSet starts from the same scope it will track. Without
  // this, iter 1's "diff vs baseline" would compare scoped iter
  // results to a full-suite baseline — many tests "go red" in iter 1
  // just by no longer being scope-included.
  console.log("→ baseline test run (story-scoped)…");
  const baseline = runTestSuite(ctx, storyTestFiles);
  appendRunLog(
    ctx,
    `SCOPED_TESTS  story_files=${storyTestFiles.length}`
  );
  if (!baseline.ran) {
    return haltFor(ctx, {
      reason: "TEST_RUNNER_BROKEN",
      iterations: 0,
      checkpoints: 0,
      greenCount: 0,
      totalCount: expectedTestIds.size,
      spendUsd: 0,
      summary: `Test runner failed to produce usable output on the baseline run. Error: ${baseline.error ?? "(unknown)"}. Fix the runner before brewing.`,
    });
  }

  // Fix 1 (0.7.14): keep a lookup of failure messages per test id so
  // each iteration's turn prompt can include the target test's failure
  // output. Seeds from baseline; refreshes after each test run below.
  let failureMessagesByTestId: Map<string, string> = buildFailureMap(baseline.tests);
  let greenSet = new Set(
    baseline.tests.filter((t) => t.status === "passed").map((t) => t.id)
  );
  let redSet = new Set(
    baseline.tests.filter((t) => t.status !== "passed").map((t) => t.id)
  );
  const discoveredIds = new Set<string>([...greenSet, ...redSet]);

  console.log(`→ baseline: ${greenSet.size} green, ${redSet.size} red / ${baseline.tests.length} total`);
  appendRunLog(
    ctx,
    `BASELINE  green=${greenSet.size} red=${redSet.size} total=${baseline.tests.length} story_expected=${expectedTestIds.size}`
  );

  // Sanity check BEFORE declaring success: are the story's expected tests
  // actually being discovered? It's possible for `redSet.size === 0` to
  // mean "everything vitest found passed" while the story's tests are
  // completely absent (vitest include pattern doesn't cover them, etc.).
  const undiscoveredStoryTests = [...expectedTestIds].filter(
    (id) => !discoveredIds.has(id)
  );
  if (undiscoveredStoryTests.length > 0) {
    return haltFor(ctx, {
      reason: "MANIFEST_DRIFT",
      iterations: 0,
      checkpoints: 0,
      greenCount: greenSet.size,
      totalCount: expectedTestIds.size,
      spendUsd: 0,
      summary:
        `Story manifest lists ${expectedTestIds.size} test(s) but vitest discovered only ${discoveredIds.size} test(s) in this run — ${undiscoveredStoryTests.length} of the story's tests are invisible to the runner. ` +
        `First missing: \`${undiscoveredStoryTests[0]}\`. ` +
        `Most common cause: \`vitest.config.ts\`'s \`include\` pattern doesn't cover the test files' path (e.g., only \`src/**/*.test.ts\` but tests live under \`tests/integration/\`). ` +
        `Fix the include pattern and re-run.`,
    });
  }

  if (redSet.size === 0) {
    return {
      kind: "success",
      iterations: 0,
      checkpoints: 0,
      spendUsd: 0,
    };
  }

  // Story-scoped target pool: only consider red tests from this story's manifest
  const storyRedSet = () =>
    new Set([...redSet].filter((t) => expectedTestIds.has(t)));

  let spendUsd = 0;
  let stagnation = 0;
  /** How many consecutive iterations produced zero file edits. Resets on
   * any iteration with files_touched > 0 (regardless of outcome). The
   * agent going silent for 2+ turns signals analysis paralysis — more
   * iterations won't recover, so halt early and save budget. */
  let consecutiveNoEdits = 0;
  /**
   * 0.11.13+ — formatted lint/typecheck issues from the most recent
   * checkpoint's edits. Empty until first checkpoint produces issues;
   * folded into next iter's prompt so the agent can fix them in the
   * same loop as test reds. Reset to "" each successful checkpoint
   * if lint runs clean; lingers if errors persist.
   */
  let lintIssuesForNextIter = "";
  /**
   * 0.11.13+ — running tally of regression-revert iters across this
   * brew run. Used by provenance write at completion so future brews
   * see how risky a file's surface was.
   */
  let totalRegressions = 0;
  const iterationLogs: IterationLog[] = [];
  const priorAttempts: Array<{
    iteration: number;
    outcome: "reverted-regression" | "reverted-no-progress" | "rejected-overflow";
    note: string;
    files_touched: string[];
  }> = [];

  let currentTarget: string | null = pickTarget(storyRedSet(), null);
  if (!currentTarget) {
    return haltFor(ctx, {
      reason: "TESTS_NEVER_GREEN",
      iterations: 0,
      checkpoints: 0,
      greenCount: greenSet.size,
      totalCount: expectedTestIds.size,
      spendUsd,
      summary: `No red tests for story-${ctx.storyId} found in baseline. Either the story's tests are passing already (nothing to brew), or the manifest doesn't match what vitest discovers. Check the story's manifest vs actual test file.`,
    });
  }

  // Track the last iteration number outside the loop so the API_ERROR catch
  // below knows how far we got. Any unexpected throw from an external call
  // (Anthropic SDK, forge, etc.) surfaces as a clean halt report rather than
  // an uncaught exception that crashes the CLI and leaves no artifact.
  let lastIteration = 0;
  try {
  for (let iteration = 1; iteration <= ctx.maxIterations; iteration++) {
    lastIteration = iteration;
    console.log(`\n=== iteration ${iteration}/${ctx.maxIterations} — target: ${currentTarget} ===`);
    appendRunLog(
      ctx,
      `ITER ${iteration}/${ctx.maxIterations} START  target=${currentTarget}  spend=$${spendUsd.toFixed(2)}/${ctx.budgetUsd.toFixed(2)}`
    );

    // Budget + time checks before spending
    if (spendUsd >= ctx.budgetUsd) {
      return haltFor(ctx, {
        reason: "BUDGET_EXHAUSTED",
        iterations: iteration - 1,
        checkpoints: iterationLogs.filter((l) => l.outcome === "checkpoint").length,
        greenCount: greenSet.size,
        totalCount: expectedTestIds.size,
        spendUsd,
        iterationLogs,
        summary: `Spent $${spendUsd.toFixed(2)} of $${ctx.budgetUsd.toFixed(2)} budget across ${iteration - 1} iterations. ${iterationLogs.filter((l) => l.outcome === "checkpoint").length} checkpoints advanced the green set. ${generateDiagnosis(iterationLogs, greenSet, expectedTestIds)}`,
      });
    }
    if (ctx.now().getTime() - startMs > ctx.wallClockMs) {
      return haltFor(ctx, {
        reason: "WALL_CLOCK",
        iterations: iteration - 1,
        checkpoints: iterationLogs.filter((l) => l.outcome === "checkpoint").length,
        greenCount: greenSet.size,
        totalCount: expectedTestIds.size,
        spendUsd,
        iterationLogs,
        summary: `Wall-clock budget exceeded after ${iteration - 1} iterations.`,
      });
    }
    if (stagnation >= STAGNATION_CAP) {
      return haltFor(ctx, {
        reason: "STAGNATION_CAP",
        iterations: iteration - 1,
        checkpoints: iterationLogs.filter((l) => l.outcome === "checkpoint").length,
        greenCount: greenSet.size,
        totalCount: expectedTestIds.size,
        spendUsd,
        iterationLogs,
        summary: `${STAGNATION_CAP} consecutive iterations made no progress. ${generateDiagnosis(iterationLogs, greenSet, expectedTestIds)}`,
      });
    }

    // Snapshot before turn (for revert)
    const snapshot = snapshotAllowedPaths(ctx);

    // Run one agent turn. Fix 1 (0.7.14): include the target test's
    // failure message + a few peripheral ones so the agent sees ground
    // truth instead of having to reason abstractly.
    const targetFailureMessage = failureMessagesByTestId.get(currentTarget);
    const otherStoryFailures = [...redSet]
      .filter((t) => t !== currentTarget && expectedTestIds.has(t))
      .slice(0, 5)
      .map((id) => ({
        test_id: id,
        message: failureMessagesByTestId.get(id) ?? "(no failure message captured)",
      }));

    const turnResult = await runTurn(ctx, {
      iteration,
      target: currentTarget,
      targetFailureMessage,
      otherFailureMessages: otherStoryFailures,
      greenList: [...greenSet],
      redList: [...redSet],
      priorAttempts,
      spendUsd,
      lintIssues: lintIssuesForNextIter,
    });
    spendUsd += turnResult.spendDelta;

    if (turnResult.filesTouched.length === 0 && !turnResult.overflowJustification) {
      // Agent did nothing. Log and continue.
      iterationLogs.push({
        iteration,
        target_test_id: currentTarget,
        outcome: "reverted-no-progress",
        note: "agent made no edits this turn",
        files_touched: [],
        lines_added: 0,
        lines_removed: 0,
        spend_delta_usd: turnResult.spendDelta,
        rationale: turnResult.rationale,
      });
      priorAttempts.push({
        iteration,
        outcome: "reverted-no-progress",
        note: "agent made no edits",
        files_touched: [],
      });
      stagnation += 1;
      consecutiveNoEdits += 1;

      // Log the no-edits event so CI stdout shows the stall live.
      // Without this, the dominant-pattern stall (agent reasoning but
      // never calling a tool) looks identical in logs to a fast
      // successful turn — only the spend-delta on the NEXT iter's
      // START line reveals tokens were burned.
      appendRunLog(
        ctx,
        `ITER ${iteration} NO-EDITS  (agent made no tool calls this turn)  spend_delta=$${turnResult.spendDelta.toFixed(2)}  consecutive_no_edits=${consecutiveNoEdits}  stagnation=${stagnation}/${STAGNATION_CAP}`
      );

      // Fix 3 (0.7.14): voluntary-halt escape hatch. If the agent's
      // rationale ends with "Considering halting voluntarily" the model
      // has self-reported that it can't make progress — halt immediately
      // with a diagnostic reason rather than burning more budget.
      const selfReportStuck = /considering\s+halting\s+voluntarily/i.test(
        turnResult.rationale
      );
      if (selfReportStuck) {
        appendRunLog(
          ctx,
          `ITER ${iteration} AGENT_SELF_REPORTED_STUCK — halting early (rationale contains 'Considering halting voluntarily')`
        );
        return haltFor(ctx, {
          reason: "AGENT_SELF_REPORTED_STUCK",
          iterations: iteration,
          checkpoints: iterationLogs.filter((l) => l.outcome === "checkpoint").length,
          greenCount: greenSet.size,
          totalCount: expectedTestIds.size,
          spendUsd,
          iterationLogs,
          summary: `Agent voluntarily halted on iter ${iteration} — rationale contained 'Considering halting voluntarily'. Target: ${currentTarget}. Full rationale in last_agent_rationale describes the specific mismatch it couldn't resolve.`,
        });
      }

      // Fix 4 (0.7.14): two consecutive zero-edit iterations → halt.
      // Model spent context tokens reasoning but never emitted a tool
      // call. Further iterations won't spontaneously produce useful
      // output; surface the stall instead of paying for it.
      if (consecutiveNoEdits >= 2) {
        appendRunLog(
          ctx,
          `ITER ${iteration} AGENT_STALLED_NO_EDITS — halting after ${consecutiveNoEdits} consecutive zero-edit iterations`
        );
        return haltFor(ctx, {
          reason: "AGENT_STALLED_NO_EDITS",
          iterations: iteration,
          checkpoints: iterationLogs.filter((l) => l.outcome === "checkpoint").length,
          greenCount: greenSet.size,
          totalCount: expectedTestIds.size,
          spendUsd,
          iterationLogs,
          summary: `Agent went silent for ${consecutiveNoEdits} consecutive iterations (no tool-use edits despite burning context tokens) on target: ${currentTarget}. Not a productive pattern — halting early to preserve budget.`,
        });
      }
      continue;
    }

    // Reset the no-edits counter whenever the agent emitted anything,
    // even if later stages revert for other reasons (frozen-path, overflow,
    // regression, no-progress). The counter tracks "did the agent actually
    // produce tool calls," not "did the iteration succeed."
    consecutiveNoEdits = 0;

    // Constraint checks on the applied diff
    const diff = computeDiff(snapshot);
    const frozenHit = diff.changedPaths.find((p) =>
      isFrozenPath(p, ctx.frozenPaths)
    );
    if (frozenHit) {
      revertToSnapshot(ctx, snapshot);
      iterationLogs.push({
        iteration,
        target_test_id: currentTarget,
        outcome: "rejected-frozen-path",
        note: `agent wrote to frozen path: ${frozenHit}`,
        files_touched: diff.changedPaths,
        lines_added: diff.linesAdded,
        lines_removed: diff.linesRemoved,
        spend_delta_usd: turnResult.spendDelta,
        rationale: turnResult.rationale,
      });
      priorAttempts.push({
        iteration,
        outcome: "reverted-no-progress",
        note: `rejected: wrote to frozen path ${frozenHit}`,
        files_touched: diff.changedPaths,
      });
      stagnation += 1;
      appendRunLog(
        ctx,
        `ITER ${iteration} REJECT frozen-path  ${frozenHit}  (also touched ${diff.changedPaths.length - 1} other file(s))  spend_delta=$${turnResult.spendDelta.toFixed(2)}`
      );
      continue;
    }

    const scopeHit = diff.changedPaths.find(
      (p) =>
        !isAllowedPath(p, ctx.allowedPaths) &&
        // always allow reading — but write outside allowed_paths is rejected
        true
    );
    if (scopeHit && ctx.allowedPaths.length > 0) {
      revertToSnapshot(ctx, snapshot);
      iterationLogs.push({
        iteration,
        target_test_id: currentTarget,
        outcome: "rejected-frozen-path",
        note: `agent wrote outside allowed_paths: ${scopeHit}`,
        files_touched: diff.changedPaths,
        lines_added: diff.linesAdded,
        lines_removed: diff.linesRemoved,
        spend_delta_usd: turnResult.spendDelta,
        rationale: turnResult.rationale,
      });
      priorAttempts.push({
        iteration,
        outcome: "reverted-no-progress",
        note: `rejected: scope violation (${scopeHit})`,
        files_touched: diff.changedPaths,
      });
      stagnation += 1;
      appendRunLog(
        ctx,
        `ITER ${iteration} REJECT scope-violation  ${scopeHit}  (outside allowed_paths)  spend_delta=$${turnResult.spendDelta.toFixed(2)}`
      );
      continue;
    }

    const overflowed =
      diff.linesTotal > DIFF_LINE_CAP || diff.changedPaths.length > DIFF_FILE_CAP;
    if (overflowed && !turnResult.overflowJustification) {
      revertToSnapshot(ctx, snapshot);
      iterationLogs.push({
        iteration,
        target_test_id: currentTarget,
        outcome: "rejected-overflow",
        note: `diff (${diff.linesTotal} lines, ${diff.changedPaths.length} files) exceeded soft cap without justification`,
        files_touched: diff.changedPaths,
        lines_added: diff.linesAdded,
        lines_removed: diff.linesRemoved,
        spend_delta_usd: turnResult.spendDelta,
        rationale: turnResult.rationale,
      });
      priorAttempts.push({
        iteration,
        outcome: "rejected-overflow",
        note: `diff exceeded graduality cap without justify_diff_overflow call`,
        files_touched: diff.changedPaths,
      });
      stagnation += 1;
      appendRunLog(
        ctx,
        `ITER ${iteration} REJECT overflow  ${diff.linesTotal} lines × ${diff.changedPaths.length} files (caps: ${DIFF_LINE_CAP}×${DIFF_FILE_CAP})  — agent didn't call justify_diff_overflow  spend_delta=$${turnResult.spendDelta.toFixed(2)}`
      );
      continue;
    }

    // Run tests to see the outcome of this turn — scoped to the
    // story's manifest files (0.11.16+) for fast feedback. Full
    // suite runs at brew completion as the correctness gate.
    const result = runTestSuite(ctx, storyTestFiles);
    if (!result.ran) {
      revertToSnapshot(ctx, snapshot);
      iterationLogs.push({
        iteration,
        target_test_id: currentTarget,
        outcome: "test-runner-broken",
        note: `test runner failed: ${result.error ?? "(unknown)"}`,
        files_touched: diff.changedPaths,
        lines_added: diff.linesAdded,
        lines_removed: diff.linesRemoved,
        spend_delta_usd: turnResult.spendDelta,
        rationale: turnResult.rationale,
      });
      return haltFor(ctx, {
        reason: "TEST_RUNNER_BROKEN",
        iterations: iteration,
        checkpoints: iterationLogs.filter((l) => l.outcome === "checkpoint").length,
        greenCount: greenSet.size,
        totalCount: expectedTestIds.size,
        spendUsd,
        iterationLogs,
        summary: `Test runner broke mid-brew after iteration ${iteration}. Error: ${result.error ?? "(unknown)"}.`,
      });
    }

    // 0.7.14 Fix 1: refresh failure-message map from the latest run so
    // the next iteration's turn prompt has up-to-date `Received:` payloads.
    // (Survives revert-to-snapshot — the MAP is memoised, not the test
    // runtime state.)
    failureMessagesByTestId = buildFailureMap(result.tests);

    const newGreen = new Set(
      result.tests.filter((t) => t.status === "passed").map((t) => t.id)
    );
    const newRed = new Set(
      result.tests.filter((t) => t.status !== "passed").map((t) => t.id)
    );
    const regressions = [...greenSet].filter((t) => !newGreen.has(t));
    const gains = [...newGreen].filter((t) => !greenSet.has(t));

    if (regressions.length > 0) {
      // Regression — revert
      totalRegressions += 1;
      revertToSnapshot(ctx, snapshot);
      iterationLogs.push({
        iteration,
        target_test_id: currentTarget,
        outcome: "reverted-regression",
        note: `broke ${regressions.length} previously-green test(s): ${regressions.slice(0, 3).join(", ")}${regressions.length > 3 ? ` (+${regressions.length - 3} more)` : ""}`,
        files_touched: diff.changedPaths,
        lines_added: diff.linesAdded,
        lines_removed: diff.linesRemoved,
        spend_delta_usd: turnResult.spendDelta,
        rationale: turnResult.rationale,
        broken_tests: regressions,
      });
      priorAttempts.push({
        iteration,
        outcome: "reverted-regression",
        note: `broke ${regressions.length} green test(s)`,
        files_touched: diff.changedPaths,
      });
      stagnation += 1;
      appendRunLog(
        ctx,
        `ITER ${iteration} REVERT regression  files=[${diff.changedPaths.slice(0, 3).join(",")}${diff.changedPaths.length > 3 ? "+" + (diff.changedPaths.length - 3) : ""}] +${diff.linesAdded}/-${diff.linesRemoved}  broke=${regressions.length} [${regressions.slice(0, 3).join(" | ")}${regressions.length > 3 ? " | +" + (regressions.length - 3) : ""}]  spend_delta=$${turnResult.spendDelta.toFixed(2)}`
      );
      continue;
    }

    if (gains.length === 0) {
      // No progress — revert
      revertToSnapshot(ctx, snapshot);
      iterationLogs.push({
        iteration,
        target_test_id: currentTarget,
        outcome: "reverted-no-progress",
        note: "no test changed from red to green",
        files_touched: diff.changedPaths,
        lines_added: diff.linesAdded,
        lines_removed: diff.linesRemoved,
        spend_delta_usd: turnResult.spendDelta,
        rationale: turnResult.rationale,
      });
      priorAttempts.push({
        iteration,
        outcome: "reverted-no-progress",
        note: "no test went from red to green",
        files_touched: diff.changedPaths,
      });
      stagnation += 1;
      appendRunLog(
        ctx,
        `ITER ${iteration} REVERT no-progress  files=[${diff.changedPaths.slice(0, 3).join(",")}${diff.changedPaths.length > 3 ? "+" + (diff.changedPaths.length - 3) : ""}] +${diff.linesAdded}/-${diff.linesRemoved}  spend_delta=$${turnResult.spendDelta.toFixed(2)}`
      );
      continue;
    }

    // Progress! checkpoint
    commitCheckpoint(ctx, {
      iteration,
      target: currentTarget,
      gains,
      filesTouched: diff.changedPaths,
    });
    greenSet = newGreen;
    redSet = newRed;
    stagnation = 0;
    iterationLogs.push({
      iteration,
      target_test_id: currentTarget,
      outcome: "checkpoint",
      note: `+${gains.length} green`,
      files_touched: diff.changedPaths,
      lines_added: diff.linesAdded,
      lines_removed: diff.linesRemoved,
      spend_delta_usd: turnResult.spendDelta,
      rationale: turnResult.rationale,
    });
    priorAttempts.length = 0;
    appendRunLog(
      ctx,
      `ITER ${iteration} CHECKPOINT  +${gains.length} green  total_green=${newGreen.size}/${baseline.tests.length}  files=${diff.changedPaths.length} +${diff.linesAdded}/-${diff.linesRemoved}  spend_delta=$${turnResult.spendDelta.toFixed(2)}`
    );
    // Checkpoint altered src/ — refresh the map so the next turn's agent
    // sees current handler/component/type layout.
    regenerateCodeMap(ctx, `after iter ${iteration}`);

    // 0.11.13+ — run lint + typecheck after each successful checkpoint.
    // Issues fold into the next iteration's prompt as additional reds
    // for the agent to clean up. Skipped when stack.json doesn't define
    // any lint commands (the runner returns ran:false).
    //
    // 0.11.14+ — filter the lint result to only issues anchored to
    // the files this iteration TOUCHED. Pre-existing lint debt in
    // unrelated files (especially build artifacts) used to swamp the
    // signal: brew couldn't distinguish "did my edit break anything"
    // from a constant ~30-error noise floor. With the filter, brew
    // only reacts to issues its OWN edits caused.
    let lintResult: LintResult = {
      ran: false,
      clean: true,
      issues: [],
      duration_ms: 0,
    };
    try {
      lintResult = runLint(ctx.stackConfig.lint, {
        cwd: ctx.repoRoot,
        filterToFiles: diff.changedPaths,
      });
    } catch (e) {
      // Don't take the brew down if a lint command misbehaves —
      // surface it in the run log and continue.
      appendRunLog(
        ctx,
        `ITER ${iteration} LINT_ERROR  ${(e as Error).message.slice(0, 200)}`
      );
    }
    if (lintResult.ran) {
      const errCount = lintResult.issues.filter((i) => i.severity === "error").length;
      const warnCount = lintResult.issues.filter((i) => i.severity === "warning").length;
      appendRunLog(
        ctx,
        `ITER ${iteration} LINT  errors=${errCount} warnings=${warnCount} duration=${lintResult.duration_ms}ms`
      );
      lintIssuesForNextIter = formatLintIssues(lintResult);
    } else {
      lintIssuesForNextIter = "";
    }

    // Pick next target from story scope, if any remain
    const next = pickTarget(storyRedSet(), currentTarget);
    currentTarget = next;
    if (!currentTarget) {
      break;
    }
  }
  } catch (e) {
    const err = e as Error & { status?: number; error?: { error?: { message?: string } } };
    const apiMsg =
      err.error?.error?.message ?? err.message ?? "(unknown API error)";
    const statusTag = err.status ? `HTTP ${err.status}: ` : "";
    return haltFor(ctx, {
      reason: "API_ERROR",
      iterations: lastIteration,
      checkpoints: iterationLogs.filter((l) => l.outcome === "checkpoint").length,
      greenCount: greenSet.size,
      totalCount: expectedTestIds.size,
      spendUsd,
      iterationLogs,
      summary:
        `Brew aborted during iteration ${lastIteration}/${ctx.maxIterations} by an external-call failure: ${statusTag}${apiMsg.slice(0, 400)}. ` +
        `This is not a slowcook bug in itself — the underlying service (LLM API, forge) rejected or timed out. Once the cause is resolved, re-trigger brew.`,
    });
  }

  // Loop exited
  const allStoryGreen =
    [...expectedTestIds].every((id) => greenSet.has(id));
  if (allStoryGreen) {
    // 0.11.16+ — full-suite correctness gate. Per-iter we ran scoped
    // tests for speed; before opening a PR we need to confirm we
    // didn't break anything OUTSIDE the story's manifest. Catches
    // transitive regressions where brew touched a shared helper
    // imported by tests in other stories.
    appendRunLog(ctx, `FINAL_GATE  running full suite to check for transitive regressions…`);
    const finalRun = runTestSuite(ctx); // no scope = full suite
    if (!finalRun.ran) {
      appendRunLog(
        ctx,
        `FINAL_GATE_RUNNER_BROKEN  ${finalRun.error ?? "(unknown)"} — proceeding without full-suite verdict`
      );
    } else {
      const finalRed = finalRun.tests.filter((t) => t.status !== "passed");
      const transitiveBreaks = finalRed.filter((t) => !expectedTestIds.has(t.id));
      if (transitiveBreaks.length > 0) {
        appendRunLog(
          ctx,
          `FINAL_GATE_REGRESSION  story_green_but_${transitiveBreaks.length}_other_tests_red  first=${transitiveBreaks[0]?.id?.slice(0, 100)}`
        );
        // Halt: brew can't ship a PR that breaks unrelated tests.
        // The operator can rerun with a wider scope or hand-fix.
        return haltFor(ctx, {
          reason: "TRANSITIVE_REGRESSION",
          iterations: iterationLogs.length,
          checkpoints: iterationLogs.filter((l) => l.outcome === "checkpoint").length,
          greenCount: greenSet.size,
          totalCount: expectedTestIds.size,
          spendUsd,
          iterationLogs,
          summary: `Story tests all green, but the full-suite gate found ${transitiveBreaks.length} regression(s) in tests OUTSIDE the story manifest. Brew touched code that other stories' tests cover. First broken: \`${transitiveBreaks[0]?.id?.slice(0, 200)}\`. Hand-investigate or expand the next brew's manifest scope.`,
        });
      }
      appendRunLog(ctx, `FINAL_GATE  pass  full_suite_green=${finalRun.tests.filter((t) => t.status === "passed").length}`);
    }
    await pushBranch(ctx);
    const checkpointsCount = iterationLogs.filter((l) => l.outcome === "checkpoint").length;
    await openBrewPullRequest(ctx, {
      kind: "success",
      iterationsRun: iterationLogs.length,
      checkpointsCommitted: checkpointsCount,
      greenCount: greenSet.size,
      totalCount: expectedTestIds.size,
      spendUsd,
      iterationLogs,
    });
    appendRunLog(
      ctx,
      `SUCCESS  iterations=${iterationLogs.length}  checkpoints=${checkpointsCount}  spend=$${spendUsd.toFixed(2)}`
    );

    // 0.11.13+ — write provenance entry. Aggregate files_touched across
    // all checkpoint iterations (excluding reverts). Wrapped in try/catch
    // so a provenance write failure doesn't fail an otherwise-successful
    // brew. No agent reads this file yet (reads ship in 0.12.0); we're
    // bootstrapping the index so it isn't empty when reads land.
    try {
      const filesTouched = Array.from(
        new Set(
          iterationLogs
            .filter((l) => l.outcome === "checkpoint")
            .flatMap((l) => l.files_touched)
        )
      );
      recordBrewProvenance(ctx.repoRoot, {
        story_id: `story-${ctx.storyId}`,
        pr_url: null, // populated in 0.12.0+ when openBrewPullRequest returns the PR
        completed_at: ctx.now().toISOString(),
        files_touched: filesTouched,
        regression_count: totalRegressions,
        halted: false,
      });
      appendRunLog(
        ctx,
        `PROVENANCE  files=${filesTouched.length} regressions=${totalRegressions}`
      );
    } catch (e) {
      appendRunLog(
        ctx,
        `PROVENANCE_ERROR  ${(e as Error).message.slice(0, 200)}`
      );
    }

    return {
      kind: "success",
      iterations: iterationLogs.length,
      checkpoints: checkpointsCount,
      spendUsd,
    };
  }

  return haltFor(ctx, {
    reason: "ITERATION_CAP",
    iterations: iterationLogs.length,
    checkpoints: iterationLogs.filter((l) => l.outcome === "checkpoint").length,
    greenCount: greenSet.size,
    totalCount: expectedTestIds.size,
    spendUsd,
    iterationLogs,
    summary: `Reached the ${ctx.maxIterations}-iteration cap with ${iterationLogs.filter((l) => l.outcome === "checkpoint").length} checkpoint(s). ${generateDiagnosis(iterationLogs, greenSet, expectedTestIds)}`,
  });
}

/** ------------------------- Turn execution ------------------------- */

interface TurnResult {
  filesTouched: string[];
  rationale: string;
  spendDelta: number;
  overflowJustification?: {
    reason_category: string;
    affected_scope: string[];
    narrative: string;
  };
}

async function runTurn(
  ctx: BrewContext,
  args: {
    iteration: number;
    target: string;
    /** 0.7.14 Fix 1: vitest failure message for the target test. */
    targetFailureMessage?: string;
    /** 0.7.14 Fix 1: failure messages for other red story tests (peripheral vision). */
    otherFailureMessages?: Array<{ test_id: string; message: string }>;
    greenList: string[];
    redList: string[];
    priorAttempts: Array<{
      iteration: number;
      outcome: "reverted-regression" | "reverted-no-progress" | "rejected-overflow";
      note: string;
      files_touched: string[];
    }>;
    spendUsd: number;
    /** 0.11.13+ — formatted lint/typecheck issues from the prior iter's edits. */
    lintIssues?: string;
  }
): Promise<TurnResult> {
  // 0.11.16+ — bounded-attention spec slicing. Replace the full spec
  // body with a focused projection of just the invariants + scenarios
  // relevant to the target test. Falls back to full spec when the
  // slicer can't confidently narrow it down (e.g., the test's title
  // doesn't share enough identifiers with any invariant).
  const slice = sliceSpecForTarget(ctx.spec, args.target);
  const specYaml = slice.fellBack
    ? YAML.stringify(ctx.spec)
    : renderSpecSlice(slice, ctx.spec);
  const targetFile = ctx.spec.story_id
    ? "(see manifest file for target test location)"
    : "(unknown)";
  const targetFilePath = findTargetTestFile(ctx, args.target) ?? targetFile;
  // Iter-log the slice ratio for telemetry — lets us measure
  // attention-bound effectiveness across runs.
  appendRunLog(
    ctx,
    `ITER ${args.iteration} SPEC_SLICE  inv=${slice.ratio.invariants.kept}/${slice.ratio.invariants.total} scn=${slice.ratio.scenarios.kept}/${slice.ratio.scenarios.total} fellBack=${slice.fellBack}`
  );

  // 0.11.15+ — split the prompt into a cacheable prefix (spec body +
  // allowed paths, constant across iters) and a dynamic body (per-iter
  // varies). Anthropic's prompt cache requires a contiguous prefix, so
  // we send the user message as a content array with cache_control on
  // the prefix block. ~30-50% input-token savings within the 5-minute
  // ephemeral cache TTL.
  const promptParts = turnPromptParts({
    iteration: args.iteration,
    max_iterations: ctx.maxIterations,
    target_test_id: args.target,
    target_test_file: targetFilePath,
    spec_yaml: specYaml,
    currently_green: args.greenList,
    currently_red: args.redList,
    allowed_paths: ctx.allowedPaths,
    budget_spent_usd: args.spendUsd,
    budget_cap_usd: ctx.budgetUsd,
    previous_attempts: args.priorAttempts.slice(-3),
    target_failure_message: args.targetFailureMessage,
    other_failure_messages: args.otherFailureMessages,
    lint_issues: args.lintIssues,
  });
  // Backwards-compat: turnPrompt() still works for any non-brew caller
  // that hasn't migrated; quiet the lint that flags the unused import.
  void turnPrompt;

  const filesTouched = new Set<string>();
  let rationale = "";
  /** 0.7.15: fallback rationale — the most recent text block from any
   * round. Previously rationale was only captured on text-only
   * completion; when the agent hit the 12-round tool-loop cap without
   * emitting a text-only response, rationale stayed empty and the halt
   * report was diagnostic-blind. Now we track the last text across all
   * rounds so the operator always has something to read. */
  let latestTextBlock = "";
  /** 0.7.15: per-turn tool-call trace for the iter log. Gives the
   * operator visibility into what the agent is DOING on a stuck turn —
   * not just "no edits." Previously only write_file calls were
   * observable via filesTouched; now every tool call is logged. */
  const toolCallTrace: string[] = [];
  let overflowJustification: TurnResult["overflowJustification"];
  let spendDelta = 0;

  // 0.11.15+ — user message is now a content array: [cacheable prefix,
  // dynamic body]. The prefix block carries cache_control: ephemeral
  // so subsequent iters within the same brew (5-min cache TTL) hit
  // cached input for the spec + allowed paths. The dynamic body block
  // is uncached because it varies per iter.
  // Tool-use loop: call the model, execute tool_use blocks, feed tool_results back, repeat
  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: promptParts.cachedPrefix,
          cache_control: { type: "ephemeral" },
        },
        { type: "text", text: promptParts.dynamicBody },
      ] as never,
    },
  ];

  // Safety cap: 12 tool rounds within a single turn (should be plenty; prevents runaway)
  for (let round = 0; round < 12; round++) {
    const response = await ctx.anthropic.messages.create({
      model: ctx.model,
      max_tokens: 4096,
      // cache_control is accepted at runtime but older SDK type defs don't
      // expose it on TextBlockParam; `as never` gets past the structural
      // mismatch the same way refine/llm.ts does.
      system: [
        {
          type: "text",
          text: BREW_SYSTEM,
          cache_control: { type: "ephemeral" },
        },
      ] as never,
      // 0.11.15+ — cache the tools block. Anthropic's prompt cache
      // for tools is opt-in via cache_control on the LAST tool def;
      // when set, the API caches everything up through the tools.
      // Tools are constant across iters → strong cache hit rate.
      tools: addCacheControlToLastTool(BREW_TOOLS) as Anthropic.Messages.Tool[],
      messages,
    });
    spendDelta += costUsdForResponse(response, ctx.model);

    // Capture the assistant turn + any text (for the latest-text fallback)
    messages.push({ role: "assistant", content: response.content });

    const textInThisRound = response.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (textInThisRound) {
      latestTextBlock = textInThisRound.slice(0, 2000);
    }

    const toolBlocks = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
    );
    if (toolBlocks.length === 0) {
      // Text-only ending → this is the real rationale
      rationale = textInThisRound.slice(0, 2000);
      break;
    }

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const tool of toolBlocks) {
      // 0.7.15: trace every tool call so "no-edits" iterations aren't
      // silent in the log — operator sees what the agent explored.
      const inputSummary = summarizeToolInput(tool);
      toolCallTrace.push(`${tool.name}${inputSummary}`);
      const result = handleToolUse(ctx, tool);
      if (tool.name === "write_file") {
        const input = tool.input as { path?: string };
        if (input.path) filesTouched.add(normalizeRepoPath(ctx, input.path));
      }
      if (tool.name === "justify_diff_overflow") {
        const input = tool.input as TurnResult["overflowJustification"];
        if (input) overflowJustification = input;
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: tool.id,
        content: result.content,
        is_error: result.is_error,
      });
    }
    messages.push({ role: "user", content: toolResults });

    if (response.stop_reason !== "tool_use") break;
  }

  // If we hit the tool-round cap without a text-only completion, fall
  // back to the latest text we saw. Better than an empty rationale —
  // the operator at least knows what the agent was thinking before it
  // got stuck in exploration.
  if (!rationale && latestTextBlock) {
    rationale = `[no text-only completion within ${12} tool rounds; last text from exploration:]\n\n${latestTextBlock}`;
  }

  // Log the tool-call trace so the iter log shows exploration patterns.
  // Trimmed + head-only to avoid flooding the log on long turns.
  if (toolCallTrace.length > 0) {
    const trimmed =
      toolCallTrace.length > 20
        ? [...toolCallTrace.slice(0, 20), `… (+${toolCallTrace.length - 20} more)`]
        : toolCallTrace;
    appendRunLog(
      ctx,
      `ITER ${args.iteration} TOOLS  ${trimmed.length}/${toolCallTrace.length} calls: ${trimmed.join(", ")}`
    );
  }

  return {
    filesTouched: [...filesTouched],
    rationale,
    spendDelta,
    ...(overflowJustification ? { overflowJustification } : {}),
  };
}

/** ------------------------- Tool handlers ------------------------- */

interface ToolResult {
  content: string;
  is_error: boolean;
}

function handleToolUse(
  ctx: BrewContext,
  tool: Anthropic.Messages.ToolUseBlock
): ToolResult {
  const input = tool.input as Record<string, unknown>;
  try {
    switch (tool.name) {
      case "read_file": {
        const p = String(input["path"] ?? "");
        const full = resolveRepoPath(ctx, p);
        if (!existsSync(full)) return { content: `File not found: ${p}`, is_error: true };
        if (!statSync(full).isFile()) return { content: `Not a file: ${p}`, is_error: true };
        const txt = readFileSync(full, "utf8");
        return { content: txt.length > 20000 ? txt.slice(0, 20000) + "\n…(truncated)" : txt, is_error: false };
      }
      case "outline_file": {
        const p = String(input["path"] ?? "");
        const full = resolveRepoPath(ctx, p);
        if (!existsSync(full)) return { content: `File not found: ${p}`, is_error: true };
        if (!statSync(full).isFile()) return { content: `Not a file: ${p}`, is_error: true };
        const txt = readFileSync(full, "utf8");
        return { content: outlineFile(p, txt), is_error: false };
      }
      case "find_handler": {
        const method = String(input["method"] ?? "").toUpperCase();
        const path = String(input["path"] ?? "");
        const result = findHandler(ctx.repoRoot, method, path);
        return { content: JSON.stringify(result, null, 2), is_error: false };
      }
      case "list_directory": {
        const p = String(input["path"] ?? "");
        const full = resolveRepoPath(ctx, p);
        if (!existsSync(full)) return { content: `Not found: ${p}`, is_error: true };
        if (!statSync(full).isDirectory()) return { content: `Not a directory: ${p}`, is_error: true };
        const entries = readdirSync(full, { withFileTypes: true })
          .map((e) => `${e.name}${e.isDirectory() ? "/" : ""}`)
          .sort()
          .join("\n");
        return { content: entries, is_error: false };
      }
      case "write_file": {
        const p = String(input["path"] ?? "");
        const contents = String(input["contents"] ?? "");
        const full = resolveRepoPath(ctx, p);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, contents, "utf8");
        return { content: `Wrote ${contents.split("\n").length} lines to ${p}`, is_error: false };
      }
      case "justify_diff_overflow": {
        return { content: "justification recorded", is_error: false };
      }
      default:
        return { content: `Unknown tool: ${tool.name}`, is_error: true };
    }
  } catch (e) {
    return { content: `Tool error: ${(e as Error).message}`, is_error: true };
  }
}

/** ------------------------- Brewing-agent focus helpers ------------------------- */

/**
 * Resolve an API route spec entry like `{ method: "POST", path: "/api/rewos" }`
 * to the concrete handler file the brewing agent should edit. Saves the
 * exploratory iteration where the agent greps around to find a route file.
 *
 * Today this supports Next.js App Router only (detected by `src/app/` in
 * the repo root). Other frameworks fall through with `exists: false` +
 * `framework: "unknown"` so the agent can fall back to `list_directory` /
 * `read_file` manually. Future: detect Rails/Django/Go mux.
 *
 * Path-param convention: `:id` or `{id}` becomes `[id]` in the filesystem.
 */
export interface FindHandlerResult {
  framework: "next-app-router" | "unknown";
  file: string | null;
  function: string | null;
  exists: boolean;
  note?: string;
}

export function findHandler(
  repoRoot: string,
  method: string,
  path: string
): FindHandlerResult {
  if (!method || !path) {
    return {
      framework: "unknown",
      file: null,
      function: null,
      exists: false,
      note: "both method and path are required",
    };
  }
  const appRouter = resolve(repoRoot, "src/app");
  if (!existsSync(appRouter)) {
    return {
      framework: "unknown",
      file: null,
      function: null,
      exists: false,
      note: "no `src/app/` directory — framework detection failed. Use list_directory / read_file to locate the handler manually.",
    };
  }

  // Normalise path params: `:id` or `{id}` → `[id]`.
  const normalised = path
    .replace(/:([a-zA-Z_][\w]*)/g, "[$1]")
    .replace(/\{([a-zA-Z_][\w]*)\}/g, "[$1]")
    .replace(/^\/+/, "");

  const relFile = `src/app/${normalised}/route.ts`;
  const relFileTsx = `src/app/${normalised}/route.tsx`;
  const fullTs = resolve(repoRoot, relFile);
  const fullTsx = resolve(repoRoot, relFileTsx);
  const pick = existsSync(fullTs) ? relFile : existsSync(fullTsx) ? relFileTsx : relFile;
  const exists = existsSync(fullTs) || existsSync(fullTsx);

  return {
    framework: "next-app-router",
    file: pick,
    function: method.toUpperCase(),
    exists,
    note: exists
      ? undefined
      : `File does not exist yet — brewing needs to create it (export async function ${method.toUpperCase()}).`,
  };
}

/**
 * Produce a compact "outline" of a TypeScript/JavaScript source file:
 * imports, exports, top-level signatures, and line counts. Returns
 * something the brewing agent can read in ~200 tokens instead of the
 * ~5k-per-read-file that drove most of the 2026-04-21 brew spend.
 *
 * Heuristic-only (regex + line scan). Good enough for deciding "is the
 * handler I need in here?" without a full AST. When the agent needs to
 * look inside a function body, it uses `read_file` normally.
 */
export function outlineFile(pathHint: string, source: string): string {
  const lines = source.split("\n");
  const bits: string[] = [];
  bits.push(`# outline: ${pathHint} (${lines.length} lines)`);

  const imports: string[] = [];
  const sigs: Array<{ line: number; text: string }> = [];
  const sigPattern =
    /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\b[^{=;]*/;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;

    if (/^import\b/.test(trimmed) || /^export\s+\*\s/.test(trimmed)) {
      // Import (or re-export) — keep the whole statement compactly.
      imports.push(trimmed.replace(/\s+/g, " "));
      continue;
    }

    // Only top-level declarations (indent == 0)
    const indent = raw.length - raw.replace(/^\s*/, "").length;
    if (indent !== 0) continue;

    const m = sigPattern.exec(trimmed);
    if (m) {
      // Keep a single tidy line up to `{` or `=` or end-of-line
      const sig = m[0]
        .replace(/\s+/g, " ")
        .replace(/\s*\{$/, "")
        .trim();
      sigs.push({ line: i + 1, text: sig });
    }
  }

  if (imports.length > 0) {
    bits.push("");
    bits.push("## imports");
    for (const imp of imports) bits.push(imp);
  }
  if (sigs.length > 0) {
    bits.push("");
    bits.push("## top-level declarations");
    for (const { line, text } of sigs) bits.push(`L${line}: ${text}`);
  }
  if (imports.length === 0 && sigs.length === 0) {
    bits.push("");
    bits.push("(no imports or top-level declarations detected — use read_file if you need the body)");
  }
  return bits.join("\n");
}

/** ------------------------- Path helpers ------------------------- */

function resolveRepoPath(ctx: BrewContext, p: string): string {
  if (isAbsolute(p)) {
    // Must stay inside repoRoot
    const rel = relative(ctx.repoRoot, p);
    if (rel.startsWith("..")) throw new Error(`path escapes repo: ${p}`);
    return p;
  }
  return resolve(ctx.repoRoot, p);
}

function normalizeRepoPath(ctx: BrewContext, p: string): string {
  const full = resolveRepoPath(ctx, p);
  return relative(ctx.repoRoot, full);
}

function isFrozenPath(path: string, frozen: FrozenPaths): boolean {
  if (frozen.files.includes(path)) return true;
  for (const d of frozen.directories) {
    const normalized = d.replace(/\/$/, "");
    if (path === normalized || path.startsWith(d) || path.startsWith(normalized + "/")) {
      return true;
    }
  }
  return false;
}

function isAllowedPath(path: string, allowedPaths: string[]): boolean {
  if (allowedPaths.length === 0) return true;
  for (const ap of allowedPaths) {
    const normalized = ap.replace(/\/$/, "");
    if (path === normalized || path.startsWith(ap) || path.startsWith(normalized + "/")) {
      return true;
    }
  }
  return false;
}

/** ------------------------- Snapshot / revert ------------------------- */

interface Snapshot {
  // Maps repo-relative path → original contents (or null for "didn't exist").
  files: Map<string, string | null>;
  // Track the total set of paths that might be touched so we can detect creation.
  trackedPaths: Set<string>;
}

function snapshotAllowedPaths(ctx: BrewContext): Snapshot {
  // Cheap & safe: we snapshot lazily on write. Use an empty map.
  // During the turn, on first write to a path, we capture its pre-write state.
  // Actual implementation: the handleToolUse for write_file could do the snapshotting.
  // For simplicity in this first cut, we do a single git-based diff after the turn.
  void ctx;
  return { files: new Map(), trackedPaths: new Set() };
}

function revertToSnapshot(ctx: BrewContext, _snapshot: Snapshot): void {
  // Hard reset the working tree to HEAD for files inside allowedPaths + frozenPaths surface,
  // plus any untracked files the agent created. Safe because we committed everything before the turn.
  execSync(`git -C "${ctx.repoRoot}" reset --hard HEAD`, { stdio: "ignore" });
  execSync(`git -C "${ctx.repoRoot}" clean -fd`, { stdio: "ignore" });
}

interface DiffInfo {
  changedPaths: string[];
  linesAdded: number;
  linesRemoved: number;
  linesTotal: number;
}

function computeDiff(_snapshot: Snapshot): DiffInfo {
  // Use git to see what changed since HEAD.
  // (We rely on the caller having committed prior state before the turn started.)
  const output = execSync("git diff --numstat HEAD 2>/dev/null || echo ''", {
    encoding: "utf8",
  }).trim();
  const changedPaths: string[] = [];
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of output.split("\n")) {
    if (!line) continue;
    const parts = line.split(/\s+/);
    const added = parts[0] === "-" ? 0 : parseInt(parts[0] ?? "0", 10);
    const removed = parts[1] === "-" ? 0 : parseInt(parts[1] ?? "0", 10);
    const path = parts.slice(2).join(" ");
    if (!path) continue;
    changedPaths.push(path);
    linesAdded += isNaN(added) ? 0 : added;
    linesRemoved += isNaN(removed) ? 0 : removed;
  }
  // Also include untracked new files
  const untracked = execSync(
    `git ls-files --others --exclude-standard 2>/dev/null || echo ''`,
    { encoding: "utf8" }
  ).trim();
  for (const p of untracked.split("\n").filter(Boolean)) {
    if (!changedPaths.includes(p)) {
      changedPaths.push(p);
      try {
        const content = readFileSync(p, "utf8");
        linesAdded += content.split("\n").length;
      } catch {
        // skip
      }
    }
  }
  return {
    changedPaths,
    linesAdded,
    linesRemoved,
    linesTotal: linesAdded + linesRemoved,
  };
}

function commitCheckpoint(
  ctx: BrewContext,
  args: { iteration: number; target: string; gains: string[]; filesTouched: string[] }
): void {
  execSync(`git -C "${ctx.repoRoot}" add -A`, { stdio: "ignore" });
  const msg = `slowcook/brew iter ${args.iteration}: +${args.gains.length} green — target ${args.target}`;
  execSync(`git -C "${ctx.repoRoot}" commit -m ${JSON.stringify(msg)}`, { stdio: "ignore" });
  // Best-effort immediate push so operators watching GitHub see the
  // checkpoint as it happens. `--set-upstream` is a no-op once upstream is
  // already wired up, so this works for the first checkpoint AND subsequent
  // ones without branching logic. Push failures (network, auth) do NOT halt
  // the brew — the branch is still intact locally and the final halt path
  // will try one more push at the end.
  try {
    execSync(
      `git -C "${ctx.repoRoot}" push --set-upstream origin ${ctx.branchName}`,
      { stdio: "ignore" }
    );
  } catch {
    // best effort — log to runlog but don't throw
    appendRunLog(ctx, `WARN  push after checkpoint iter ${args.iteration} failed — branch stays local until the next push attempt`);
  }
}

async function pushBranch(ctx: BrewContext): Promise<void> {
  execSync(
    `git -C "${ctx.repoRoot}" push --set-upstream origin ${ctx.branchName}`,
    { stdio: "ignore" }
  );
  void ctx.forge;
}

/**
 * After a successful brew OR a halt-with-checkpoints, open a draft PR so
 * the work has a review surface. Skipped when checkpoints_committed === 0
 * (the halt path checks that before calling this) because there's nothing
 * to review. Best-effort: a forge failure here (e.g. the GH App token
 * lacks pull-request:write) is logged but doesn't mutate the return value
 * — the brew is still a success/halt on its own merits; the operator can
 * open a PR manually from the pushed branch.
 */
interface BrewPrOutcome {
  kind: "success" | "halted";
  iterationsRun: number;
  checkpointsCommitted: number;
  greenCount: number;
  totalCount: number;
  spendUsd: number;
  iterationLogs: IterationLog[];
  haltReport?: HaltReport;
}

async function openBrewPullRequest(
  ctx: BrewContext,
  outcome: BrewPrOutcome
): Promise<void> {
  const storyTag = `story-${ctx.storyId}`;
  const titlePrefix = outcome.kind === "success" ? "brew ✓" : "brew (partial)";
  const title =
    `${titlePrefix} ${storyTag}: ${outcome.checkpointsCommitted} checkpoint(s) · ` +
    `${outcome.greenCount}/${outcome.totalCount} green · $${outcome.spendUsd.toFixed(2)}`;
  const body = buildBrewPrBody(ctx, outcome);

  try {
    const pr = await ctx.forge.createPullRequest({
      title,
      body,
      head: ctx.branchName,
      base: "main",
      draft: true,
      labels: [
        "slowcook-brew",
        outcome.kind === "success" ? "brew:success" : "brew:partial",
      ],
    });
    appendRunLog(ctx, `PR opened: ${pr.url}`);

    // Audit-trail comment on source issue (halts already post their own).
    // Success case is otherwise silent — the issue thread should say that
    // the brew PR landed so the reviewer doesn't have to hunt for it.
    const sourceIssue = ctx.spec.source_issue?.match(/^#?(\d+)$/)?.[1];
    if (sourceIssue && outcome.kind === "success") {
      const marker =
        `<!-- slowcook:cost agent=brew usd=${outcome.spendUsd.toFixed(4)}` +
        ` iterations=${outcome.iterationsRun} checkpoints=${outcome.checkpointsCommitted}` +
        ` model=${ctx.model} -->`;
      const body =
        `### slowcook · brew opened (SUCCESS)\n\n` +
        `[PR #${pr.number}](${pr.url}) — \`story-${ctx.storyId}\`, ` +
        `${outcome.greenCount}/${outcome.totalCount} tests green across ` +
        `${outcome.checkpointsCommitted} checkpoint(s) / ${outcome.iterationsRun} iteration(s), ` +
        `$${outcome.spendUsd.toFixed(2)} spent.\n\n` +
        `Review the diff, merge when ready.\n\n` +
        `---\n*Generated by \`slowcook brew\`.*\n\n` +
        marker;
      try {
        await ctx.forge.createIssueComment(parseInt(sourceIssue, 10), body);
      } catch {
        /* best effort */
      }
    }
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    appendRunLog(ctx, `WARN  PR open failed: ${msg} — branch ${ctx.branchName} is pushed; open a PR manually.`);
  }
}

function buildBrewPrBody(ctx: BrewContext, outcome: BrewPrOutcome): string {
  const lines: string[] = [];
  const storyTag = `story-${ctx.storyId}`;
  lines.push(
    `### slowcook brew · \`${storyTag}\` · ${outcome.kind === "success" ? "SUCCESS" : `halted (${outcome.haltReport?.halt_reason ?? "unknown"})`}`
  );
  lines.push("");
  lines.push(
    `**Progress:** ${outcome.greenCount}/${outcome.totalCount} tests green · ${outcome.checkpointsCommitted} checkpoint(s) across ${outcome.iterationsRun} iteration(s)`
  );
  lines.push(
    `**Spend:** $${outcome.spendUsd.toFixed(2)} of $${ctx.budgetUsd.toFixed(2)} budget · model \`${ctx.model}\``
  );
  if (ctx.spec.source_issue) {
    lines.push(`**Source:** ${ctx.spec.source_issue}`);
  }

  if (outcome.kind === "halted" && outcome.haltReport) {
    lines.push("");
    lines.push(haltReportToMarkdown(outcome.haltReport));
  } else {
    // Success body
    const checkpoints = outcome.iterationLogs.filter((l) => l.outcome === "checkpoint");
    lines.push("");
    lines.push("#### Checkpoints");
    for (const c of checkpoints) {
      lines.push(
        `- **iter ${c.iteration}**: +${c.note.match(/\+(\d+) green/)?.[1] ?? "?"} green, ${c.files_touched.length} file(s), +${c.lines_added}/-${c.lines_removed} lines — target \`${c.target_test_id}\``
      );
    }
    lines.push("");
    lines.push("#### Review guidance");
    lines.push(
      "- The diff IS the proposed implementation. Every commit on this branch is a test-ratcheted checkpoint — each one flipped ≥1 red test to green without regressing any green.",
    );
    lines.push(
      "- Reviewer focus: correctness of the semantic interpretation, not test coverage (tests are frozen).",
    );
    lines.push(
      "- If the implementation looks right but the test was too narrow, open a follow-up story to broaden the spec — don't hand-patch tests here.",
    );
  }
  lines.push("");
  lines.push(`_Branch: \`${ctx.branchName}\` · _Generated by \`slowcook brew\`._`);
  return lines.join("\n");
}

/**
 * Regenerate `.brewing/code-map.{json,md}`. Called at brew start and after
 * every checkpoint so the agent's next turn sees an up-to-date map of API
 * routes, pages, components, helpers, and types. Best-effort — a map
 * generation failure (e.g. ts-morph parse error on malformed TS) is
 * logged but does NOT halt the brew.
 */
function regenerateCodeMap(ctx: BrewContext, when: string): void {
  try {
    const fresh = generateMap({
      repoRoot: ctx.repoRoot,
      slowcookVersion: ctx.cliVersion,
    });
    writeFreshMap(ctx.repoRoot, CODE_MAP_JSON_PATH, CODE_MAP_MD_PATH, fresh);
    appendRunLog(
      ctx,
      `CODEMAP regenerated (${when})  routes=${fresh.api_routes.length} components=${fresh.components.length} helpers=${fresh.helpers.length} types=${fresh.types.length}`
    );
  } catch (e) {
    appendRunLog(ctx, `CODEMAP regenerate FAILED (${when}): ${(e as Error).message.slice(0, 200)}`);
  }
}

/**
 * Append a line to the rolling iteration log if one is configured. Cheap
 * and best-effort: if the log directory wasn't initialised, or the write
 * fails for any reason, swallow it — the brew must not crash because
 * logging failed.
 */
function appendRunLog(ctx: BrewContext, line: string): void {
  // Mirror to stdout so GH Actions / terminal tails show per-iteration
  // progress (spend deltas, files touched, green-count deltas, ratchet
  // outcomes) live — not just the iteration headers that were the only
  // previous stdout signal. Operators could read this trail only by
  // downloading the halt artifact before 0.7.13.
  process.stdout.write(`  ${line}\n`);
  if (!ctx.runLogPath) return;
  try {
    const ts = ctx.now().toISOString();
    appendFileSync(ctx.runLogPath, `${ts}  ${line}\n`, "utf8");
  } catch {
    /* ignore */
  }
}

/** ------------------------- Runner + parsers ------------------------- */

function runTestSuite(ctx: BrewContext, scopeFiles?: string[]): RunResult {
  // 0.11.16+ — bounded-attention scoped runs. When scopeFiles is
  // provided, vitest only runs those files; per-iter cycle becomes
  // ~50-70% faster (fewer tests = less wall-clock + less compute).
  // Caller passes manifest tests for per-iter; passes nothing for
  // the brew-completion full-suite gate.
  return runTests(ctx.stackConfig, {
    cwd: ctx.repoRoot,
    scopeFiles: scopeFiles && scopeFiles.length > 0 ? scopeFiles : undefined,
  });
}

/**
 * 0.11.16+ — derive the file-scope for per-iter scoped test runs.
 *
 * Conservative scope: take every distinct file path from the story's
 * manifest. This guarantees the agent's own contract tests run, while
 * skipping every test from other stories. Catch case: when a brew
 * touches a shared helper, it could break a test in another story —
 * NOT caught per-iter; caught at the brew-completion full-suite gate.
 *
 * Could be expanded later (Phase 2) to also include tests in the
 * import-closure of files brew touched. For 0.11.16, manifest-only is
 * the cheap reliable heuristic.
 */
function deriveStoryTestFiles(manifestTests: Array<{ id: string; file: string }>): string[] {
  const files = new Set<string>();
  for (const t of manifestTests) {
    if (t.file && t.file.length > 0) files.add(t.file);
  }
  return Array.from(files);
}

/**
 * Build a test-id → failure-message lookup from a RunResult. Used by
 * the turn prompt to surface vitest's actual failure output for the
 * current target test (and optionally for other red tests).
 */
/**
 * 0.7.15: compact one-line summary of a tool-use block's input for
 * logging. Keeps the per-turn tool trace readable — no JSON payload
 * dumps, just the operation + the relevant path/name/method.
 */
function summarizeToolInput(tool: {
  name: string;
  input: unknown;
}): string {
  const input = tool.input as Record<string, unknown>;
  const pick = (keys: string[]): string => {
    for (const k of keys) {
      const v = input[k];
      if (typeof v === "string" && v) return `(${k}=${v.slice(0, 80)})`;
    }
    return "";
  };
  switch (tool.name) {
    case "find_handler":
      return `(${input.method ?? "?"} ${input.path ?? "?"})`;
    case "outline_file":
    case "read_file":
    case "write_file":
    case "list_directory":
      return pick(["path"]);
    case "justify_diff_overflow":
      return pick(["reason_category"]);
    default:
      return "";
  }
}

function buildFailureMap(
  tests: Array<{ id: string; status: string; failure_message?: string }>
): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of tests) {
    if (t.status !== "passed" && t.failure_message) {
      map.set(t.id, t.failure_message);
    }
  }
  return map;
}

/** ------------------------- Target selection ------------------------- */

function pickTarget(redTests: Set<string>, previous: string | null): string | null {
  if (redTests.size === 0) return null;
  // Prefer sticking with the previous target if it's still red
  if (previous && redTests.has(previous)) return previous;
  // Otherwise first by sorted order — deterministic
  return [...redTests].sort()[0] ?? null;
}

function findTargetTestFile(ctx: BrewContext, testId: string): string | null {
  const manifestPath = join(ctx.repoRoot, ".brewing/manifests", `story-${ctx.storyId}.json`);
  if (!existsSync(manifestPath)) return null;
  try {
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      tests: Array<{ id: string; file: string }>;
    };
    return m.tests.find((t) => t.id === testId)?.file ?? null;
  } catch {
    return null;
  }
}

/** ------------------------- Cost accounting ------------------------- */

function costUsdForResponse(
  response: Anthropic.Messages.Message,
  model: string
): number {
  const pricing = matchPricing(model);
  if (!pricing) return 0;
  const input = response.usage?.input_tokens ?? 0;
  const output = response.usage?.output_tokens ?? 0;
  // Cache fields aren't in the older SDK type; read via loose cast.
  const usage = response.usage as
    | { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
    | undefined;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheCreate = usage?.cache_creation_input_tokens ?? 0;
  // Anthropic's API reports `input_tokens` as new-input only (excludes cache tokens);
  // `cache_read_input_tokens` and `cache_creation_input_tokens` are separate counters.
  // Cache reads bill at ~10% of input; cache writes at ~125%. Prior versions subtracted
  // them from `input` on the assumption they were a subset — producing negative costs.
  const effectiveInput = input + cacheRead * 0.1 + cacheCreate * 1.25;
  return (effectiveInput / 1_000_000) * pricing.input + (output / 1_000_000) * pricing.output;
}

function matchPricing(model: string): { input: number; output: number } | null {
  // exact match first
  if (PRICING_PER_M_TOKENS[model]) return PRICING_PER_M_TOKENS[model];
  // prefix match (e.g., "claude-opus-4-7-20250912" → "claude-opus-4-7")
  for (const key of Object.keys(PRICING_PER_M_TOKENS)) {
    if (model.startsWith(key)) return PRICING_PER_M_TOKENS[key]!;
  }
  return null;
}

/** ------------------------- Halt path ------------------------- */

interface HaltArgs {
  reason: HaltReason;
  iterations: number;
  checkpoints: number;
  greenCount: number;
  totalCount: number;
  spendUsd: number;
  summary: string;
  iterationLogs?: IterationLog[];
}

async function haltFor(ctx: BrewContext, args: HaltArgs): Promise<BrewOutcome> {
  const iterationDiffs = (args.iterationLogs ?? []).map<IterationDiff>((l) => ({
    iteration: l.iteration,
    target_test_id: l.target_test_id,
    files_changed: l.files_touched.length,
    files_touched: l.files_touched,
    lines_added: l.lines_added,
    lines_removed: l.lines_removed,
    outcome: l.outcome,
    note: l.note,
    broken_tests: l.broken_tests,
    spend_delta_usd: l.spend_delta_usd,
    rationale: l.rationale && l.rationale.length > 0 ? l.rationale : undefined,
  }));
  const lastRationale = (args.iterationLogs ?? []).slice(-1)[0]?.rationale;

  const report: HaltReport = {
    story_id: ctx.storyId,
    halt_reason: args.reason,
    halt_timestamp: ctx.now().toISOString(),
    iterations_run: args.iterations,
    checkpoints_committed: args.checkpoints,
    tests_green: args.greenCount,
    tests_total: args.totalCount,
    tokens_spent_usd: args.spendUsd,
    budget_usd: ctx.budgetUsd,
    model: ctx.model,
    summary_plain_english: args.summary,
    iteration_diffs: iterationDiffs.length > 0 ? iterationDiffs : undefined,
    last_agent_rationale: lastRationale,
    suggested_actions: defaultSuggestedActions(args.reason, {
      budget_usd: ctx.budgetUsd,
      iterations_run: args.iterations,
    }),
  } as HaltReport;

  const reportPath = join(
    ctx.haltDir,
    `story-${ctx.storyId}-${report.halt_timestamp.replace(/[:.]/g, "-")}.json`
  );
  writeHaltReport(reportPath, report);
  appendRunLog(
    ctx,
    `HALT ${args.reason}  iterations=${args.iterations}  checkpoints=${args.checkpoints}  green=${args.greenCount}/${args.totalCount}  spend=$${args.spendUsd.toFixed(2)}  report=${reportPath}`
  );

  // 0.11.14+ — record provenance on halts too. Halted brews still
  // touched files; recording them gives the next brew on overlapping
  // surface a richer prior-context block (showing where prior brews
  // halted vs succeeded). 0.11.13 only recorded on success; 0.11.14
  // closes that gap. Writes are no-op-safe (try/catch) so a
  // provenance failure never masks the underlying halt.
  if (args.iterationLogs && args.iterationLogs.length > 0) {
    try {
      const filesTouched = Array.from(
        new Set(
          args.iterationLogs
            .filter((l) => l.outcome === "checkpoint")
            .flatMap((l) => l.files_touched)
        )
      );
      const regressionCount = args.iterationLogs.filter(
        (l) => l.outcome === "reverted-regression"
      ).length;
      // Only record when at least one checkpoint landed; otherwise
      // there's nothing useful to remember.
      if (filesTouched.length > 0) {
        recordBrewProvenance(ctx.repoRoot, {
          story_id: `story-${ctx.storyId}`,
          pr_url: null,
          completed_at: report.halt_timestamp,
          files_touched: filesTouched,
          regression_count: regressionCount,
          halted: true,
        });
        appendRunLog(
          ctx,
          `PROVENANCE  halted=true files=${filesTouched.length} regressions=${regressionCount}`
        );
      }
    } catch (e) {
      appendRunLog(
        ctx,
        `PROVENANCE_ERROR  ${(e as Error).message.slice(0, 200)}`
      );
    }
  }

  // Copy the rolling run log into the halts/ directory so CI's
  // halt-artifact upload (which is pointed at .brewing/halts/) captures it.
  // Without this, halts with 0 checkpoints leave no diagnostic trail off the
  // runner — the log only gets pushed to the brew branch on checkpoint push.
  if (ctx.runLogPath && existsSync(ctx.runLogPath)) {
    try {
      const logDest = reportPath.replace(/\.json$/, ".log");
      copyFileSync(ctx.runLogPath, logDest);
    } catch {
      /* best effort */
    }
  }

  // Attempt to push partial progress (if any checkpoints exist) so the operator can see what was tried
  if (report.checkpoints_committed > 0) {
    try {
      execSync(
        `git -C "${ctx.repoRoot}" push --set-upstream origin ${ctx.branchName}`,
        { stdio: "ignore" }
      );
    } catch {
      // best effort
    }
    // Open a draft PR so the partial progress has a review surface.
    // Skipping when checkpoints_committed === 0 because there's literally
    // nothing to review — the branch is the baseline.
    //
    // Awaited (not fire-and-forget) so any failure is logged BEFORE the
    // run log is rescued to halts/; otherwise the WARN line lands after
    // the artifact is copied and the operator has no trail.
    try {
      await openBrewPullRequest(ctx, {
        kind: "halted",
        iterationsRun: args.iterations,
        checkpointsCommitted: args.checkpoints,
        greenCount: args.greenCount,
        totalCount: args.totalCount,
        spendUsd: args.spendUsd,
        iterationLogs: args.iterationLogs ?? [],
        haltReport: report,
      });
    } catch (e) {
      // Shouldn't happen — openBrewPullRequest's own try/catch swallows
      // forge errors and logs WARN. But if something further up throws
      // (e.g. bad args), surface it visibly so it's not lost.
      const msg = (e as Error).message.slice(0, 300);
      console.error(`\nWARN  PR open path threw: ${msg}\n  Branch ${ctx.branchName} is pushed; open a PR manually.`);
      appendRunLog(ctx, `HALT_PR_OPEN_FAILED ${msg}`);
    }
  }

  // Post comment to the source issue if present
  const sourceIssue = ctx.spec.source_issue?.match(/#?(\d+)/)?.[1];
  if (sourceIssue) {
    ctx.forge
      .createIssueComment(parseInt(sourceIssue, 10), haltReportToMarkdown(report))
      .catch(() => {
        /* best effort */
      });
  }

  return { kind: "halted", report };
}

function generateDiagnosis(
  iterationLogs: IterationLog[],
  greenSet: Set<string>,
  expected: Set<string>
): string {
  const storyGreen = [...greenSet].filter((t) => expected.has(t)).length;
  if (iterationLogs.length === 0) {
    return "No iterations ran.";
  }
  const checkpoints = iterationLogs.filter((l) => l.outcome === "checkpoint").length;
  const regressions = iterationLogs.filter((l) => l.outcome === "reverted-regression").length;
  const noProgress = iterationLogs.filter((l) => l.outcome === "reverted-no-progress").length;

  if (checkpoints === 0 && noProgress > 0 && regressions === 0) {
    // Classic "wrong layer" signal: agent tried, nothing moved
    return `All ${iterationLogs.length} iterations reverted for no-progress (no test changed from red to green). The target test is likely unreachable from the code the agent is editing — a layer mismatch. Common cause: HTTP-loopback tests that fetch a URL with no running server. See \`.brewing/context.md\` → Testing conventions for the tier-1 (vi.mock) style that brewing can actually ratchet against.`;
  }
  if (regressions > iterationLogs.length / 2) {
    return `${regressions} iterations regressed (broke a previously-green test). Agent may be misunderstanding an invariant — consider clarifying the spec.`;
  }
  if (checkpoints > 0 && storyGreen < expected.size) {
    return `${checkpoints} checkpoints committed; ${storyGreen}/${expected.size} story tests green. Progress was real but incomplete.`;
  }
  return `${checkpoints} checkpoint(s), ${noProgress} no-progress, ${regressions} regression(s).`;
}

/** ------------------------- Entry helpers ------------------------- */

export function readFrozenPaths(repoRoot: string): FrozenPaths {
  const path = join(repoRoot, ".brewing/frozen-paths.json");
  if (!existsSync(path)) {
    return { directories: [], files: [], partial: {} };
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    directories?: string[];
    files?: string[];
    partial?: Record<string, { frozen_key_paths?: string[] }>;
  };
  return {
    directories: raw.directories ?? [],
    files: raw.files ?? [],
    partial: raw.partial ?? {},
  };
}

export function readStackConfig(repoRoot: string): StackConfig {
  const path = join(repoRoot, ".brewing/stack.json");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return validateStackConfig(raw);
}

export function loadSpec(repoRoot: string, storyId: string): Spec {
  return readSpec(repoRoot, storyId);
}
