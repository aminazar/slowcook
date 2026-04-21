import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
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
} from "@slowcook-ai/stack-ts";
import { readSpec } from "../refine/spec-yaml.js";
import {
  BREW_SYSTEM,
  BREW_TOOLS,
  turnPrompt,
} from "./prompts.js";
import {
  writeHaltReport,
  haltReportToMarkdown,
  defaultSuggestedActions,
  type HaltReason,
  type HaltReport,
  type DiffShortstat,
} from "./halt.js";

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

const PRICING_PER_M_TOKENS: Record<string, { input: number; output: number }> = {
  "claude-opus-4-7": { input: 15, output: 75 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 0.8, output: 4 },
};

export async function runBrew(ctx: BrewContext): Promise<BrewOutcome> {
  const startMs = ctx.now().getTime();
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

  // Baseline: run tests once to see starting state
  console.log("→ baseline test run…");
  const baseline = runTestSuite(ctx);
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

  let greenSet = new Set(
    baseline.tests.filter((t) => t.status === "passed").map((t) => t.id)
  );
  let redSet = new Set(
    baseline.tests.filter((t) => t.status !== "passed").map((t) => t.id)
  );
  const discoveredIds = new Set<string>([...greenSet, ...redSet]);

  console.log(`→ baseline: ${greenSet.size} green, ${redSet.size} red / ${baseline.tests.length} total`);

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

  for (let iteration = 1; iteration <= ctx.maxIterations; iteration++) {
    console.log(`\n=== iteration ${iteration}/${ctx.maxIterations} — target: ${currentTarget} ===`);

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

    // Run one agent turn
    const turnResult = await runTurn(ctx, {
      iteration,
      target: currentTarget,
      greenList: [...greenSet],
      redList: [...redSet],
      priorAttempts,
      spendUsd,
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
      continue;
    }

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
      continue;
    }

    // Run tests to see the outcome of this turn
    const result = runTestSuite(ctx);
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

    // Pick next target from story scope, if any remain
    const next = pickTarget(storyRedSet(), currentTarget);
    currentTarget = next;
    if (!currentTarget) {
      break;
    }
  }

  // Loop exited
  const allStoryGreen =
    [...expectedTestIds].every((id) => greenSet.has(id));
  if (allStoryGreen) {
    await pushBranch(ctx);
    return {
      kind: "success",
      iterations: iterationLogs.length,
      checkpoints: iterationLogs.filter((l) => l.outcome === "checkpoint").length,
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
    greenList: string[];
    redList: string[];
    priorAttempts: Array<{
      iteration: number;
      outcome: "reverted-regression" | "reverted-no-progress" | "rejected-overflow";
      note: string;
      files_touched: string[];
    }>;
    spendUsd: number;
  }
): Promise<TurnResult> {
  const specYaml = YAML.stringify(ctx.spec);
  const targetFile = ctx.spec.story_id
    ? "(see manifest file for target test location)"
    : "(unknown)";
  const targetFilePath = findTargetTestFile(ctx, args.target) ?? targetFile;

  const userMessage = turnPrompt({
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
  });

  const filesTouched = new Set<string>();
  let rationale = "";
  let overflowJustification: TurnResult["overflowJustification"];
  let spendDelta = 0;

  // Tool-use loop: call the model, execute tool_use blocks, feed tool_results back, repeat
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: userMessage },
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
      tools: BREW_TOOLS as Anthropic.Messages.Tool[],
      messages,
    });
    spendDelta += costUsdForResponse(response, ctx.model);

    // Capture the assistant turn + any final text
    messages.push({ role: "assistant", content: response.content });

    const toolBlocks = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
    );
    if (toolBlocks.length === 0) {
      // Text-only ending → extract rationale
      const text = response.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      rationale = text.slice(0, 2000);
      break;
    }

    const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
    for (const tool of toolBlocks) {
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
}

async function pushBranch(ctx: BrewContext): Promise<void> {
  execSync(
    `git -C "${ctx.repoRoot}" push --set-upstream origin ${ctx.branchName}`,
    { stdio: "ignore" }
  );
  void ctx.forge;
}

/** ------------------------- Runner + parsers ------------------------- */

function runTestSuite(ctx: BrewContext): RunResult {
  return runTests(ctx.stackConfig, { cwd: ctx.repoRoot });
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
  // Anthropic caching: cache reads are ~10% of input; cache creates are ~125%.
  // We approximate — exact pricing depends on model, but this is within ~20%.
  const effectiveInput =
    (input - cacheRead - cacheCreate) + cacheRead * 0.1 + cacheCreate * 1.25;
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

function haltFor(ctx: BrewContext, args: HaltArgs): BrewOutcome {
  const last3 = (args.iterationLogs ?? [])
    .slice(-3)
    .map<DiffShortstat>((l) => ({
      iteration: l.iteration,
      files_changed: l.files_touched.length,
      lines_added: l.lines_added,
      lines_removed: l.lines_removed,
      outcome:
        l.outcome === "checkpoint"
          ? "checkpoint"
          : l.outcome === "reverted-regression"
            ? "reverted-regression"
            : l.outcome === "rejected-overflow"
              ? "rejected-overflow"
              : "reverted-no-progress",
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
    last_three_diffs: last3.length > 0 ? last3 : undefined,
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
