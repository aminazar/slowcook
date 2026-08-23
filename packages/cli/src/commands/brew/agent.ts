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
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import YAML from "yaml";
import Anthropic from "@anthropic-ai/sdk";
import type { ForgeAdapter, Spec } from "@slowcook-ai/core";
import {
  type RunResult,
  type TestResult,
  formatLintIssues,
  type LintResult,
} from "@slowcook-ai/stack-ts";
import {
  runTests,
  runLint,
  discoverTests,
  validateStackConfig,
  type StackConfig,
} from "../../stack-resolve.js";
import { foldCrossSuiteTests } from "./cross-suite.js";
import { finalGateVerdict } from "./gate-verdict.js";
import { recordBrewProvenance, readProvenance, renderPriorContextBlock } from "./provenance.js";
import { gatherPatternIndex, renderPatternIndexBlock } from "./patterns.js";
import { sliceSpecForTarget, renderSpecSlice } from "./spec-slice.js";
import {
  findReferences,
  findImplementations,
  findDefinition,
  renderReferences,
} from "./retrieval.js";
import { readSpec } from "../refine/spec-yaml.js";
import {
  BREW_SYSTEM,
  BREW_TOOLS,
  turnPrompt,
  turnPromptParts,
  BREW_PLATE_MODE_ADDENDUM,
} from "./prompts.js";
import {
  writeHaltReport,
  haltReportToMarkdown,
  defaultSuggestedActions,
  type HaltReason,
  type HaltReport,
  type IterationDiff,
} from "./halt.js";
import { sliceCodeMap } from "../map/scan.js";
import { generateFullMap } from "../map/scan-solidity.js";
import type { CodeMap } from "../map/scan.js";
import { writeFreshMap } from "../map/index.js";
import {
  CODE_MAP_JSON_PATH,
  CODE_MAP_MD_PATH,
  CODE_MAP_TARGET_MD_PATH,
  renderMarkdown,
} from "../map/render.js";
import { appendCostEntry, applyCostToSpec } from "../../cost-store.js";
import { costEntryUsd, costUsdForUsage } from "@slowcook-ai/llm-anthropic";
import { recordRead, buildPreloadBlock, type ReadCacheEntry } from "./preload.js";
import { runCliTurn } from "./cli-driver.js";
import { touchLock } from "./run-lock.js";
import { detectMaskedMonolith, peelTargetPrompt, peelResolved, diagnoseToolFailure, peelIsStandaloneCheckpoint, type PeelResult } from "./testability.js";
import { ladderWindow, describeWindow } from "./ladder.js";
import { fileBackpropClaims } from "../../lib/backprop.js";
import {
  lessonMessage, compactOldToolResults, estimateTokens, resetDigest,
  COMPACT_AT_TOKENS, RESET_AFTER_FAILURES, type Msg,
} from "./conversation.js";

/** ------------------------- Context + options ------------------------- */

export interface BrewContext {
  /**
   * dovizir handover §2 (tail) — running token totals for THIS brew, so the
   * priciest stage in the pipeline stops being invisible to `slowcook cost`.
   * brew constructs the Anthropic SDK directly and had usage objects in hand
   * but wrote nothing to the ledger. Mutated in place by runTurn.
   */
  usageTotals?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number };
  /** §13 orientation carry — per-run read cache feeding the pre-load block. */
  readCache?: Map<string, ReadCacheEntry>;
  /** §13 — tool rounds per turn (default 12). The cap that cut orientation. */
  maxToolRounds?: number;
  /** §13/R5 — output tokens per round (default 16384). 4096 cut opus-5 mid-write. */
  maxOutputTokens?: number;
  /** #399 — consecutive failures on one target before a recovery reset (default 3). */
  resetAfterFailures?: number;
  /** Manifest test ids, for compile-fail synthesis in the runner. */
  manifestTestIds?: string[];
  /** #393 — drive turns through the local claude CLI (subscription auth)
   *  with tools over MCP, instead of the Anthropic SDK. Dollars are still
   *  recorded at list price (Amin's ruling). */
  useCliBackend?: boolean;
  /** #393 — the story's CLI session (the #399 conversation, CLI-side).
   *  Reset-recovery drops it. Mutated by the driver dispatch. */
  cliSessionId?: string;
  /** Multi-model: model for post-first turns on a target ("mechanical
   *  emission"). First contact + post-reset turns use ctx.model (plan). */
  emitModel?: string;
  /** Multi-model: which turn model runBrew resolved for THIS turn. */
  turnModel?: string;
  /** Restore the pre-0.30 guillotine: revert no-progress work instead of
   *  keeping it as the next turn's base. */
  strictRevert?: boolean;
  /** Ladder mode: reveal the manifest one release_order rung at a time. */
  ladder?: boolean;
  /**
   * dovizir §11 — override the consecutive-no-edit halt threshold. Absent =
   * 2 for a silent agent, EXPLORING_NO_EDIT_CAP when it is still calling
   * tools. Set it when a story's spec is big enough that orientation
   * legitimately takes longer.
   */
  stallIterations?: number;
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
  /**
   * 0.15.0-α.4 — execution mode.
   *
   * `freehand`: wide-scope. Brew has wide allowed_paths and writes
   *   implementation from empty stubs. Used for backend-only stories
   *   and any story where the plate track was skipped.
   *
   * `plate`: the mockup is on main (committed by plate after PM
   *   approval). Brew's allowed_paths exclude UI files entirely; the
   *   system prompt is augmented with "do NOT redesign components".
   *   Brew's job collapses to swapping `<domain>.ts` stubs for real
   *   fetches + writing API handlers + writing migrations. Halts with
   *   MOCKUP_DESIGN_CONFLICT when a test cannot be satisfied without
   *   editing a frozen UI file.
   */
  mode?: "freehand" | "plate";
  /**
   * 0.19.0-alpha.4 — pair-brew navigator hook (production wiring of
   * the validated pair-sim experiment). Fires AFTER the iteration's
   * existing regression / no-progress checks have passed, BEFORE the
   * checkpoint is committed. Use it to add a "design fidelity / cross-
   * story risk / responsive / accessibility" verdict beyond what
   * vitest can observe.
   *
   * Returning a verdict with `overall: "block"` causes the iteration
   * to revert + treat as a no-progress iter (its concerns fold into
   * the next iter's `prior_attempts` history). Returning null OR a
   * non-block verdict lets the iteration proceed to checkpoint as
   * normal.
   *
   * Default: undefined — no behavioral change vs pre-α.4 brew. Inject
   * via the cli's `--with-navigator` flag (wired up in α.5+) or via
   * a unit-test stub.
   */
  navigatorHook?: NavigatorHook;
}

/**
 * 0.19.0-alpha.4 — interface for the pair-brew navigator review.
 * Pure I/O contract; brew/agent.ts calls it with iteration context
 * and consumes the verdict deterministically. The default Anthropic-
 * backed implementation lives in `pair-navigator.ts`; tests inject
 * a stub.
 */
export interface NavigatorHook {
  /**
   * Called after a successful iteration's existing checks pass + before
   * the checkpoint is committed. Implementations may call an LLM, do
   * static analysis, or return null to abstain.
   *
   * @returns null when the navigator abstains (no opinion / disabled
   *   for this iter); a NavigatorHookVerdict otherwise.
   */
  review(input: NavigatorHookInput): Promise<NavigatorHookVerdict | null>;
}

export interface NavigatorHookInput {
  iteration: number;
  storyId: string;
  /** Files changed by this iteration. */
  filesTouched: string[];
  /** Diff lines added in this iteration. */
  linesAdded: number;
  /** Diff lines removed in this iteration. */
  linesRemoved: number;
  /** Driver's stated rationale for the changes. */
  rationale: string;
  /** Tests that just went red→green this iter. */
  gainedTests: string[];
  /** Repo root, so the hook can read additional context if needed. */
  repoRoot: string;
  /**
   * α.55 — the test id the iteration was targeting. Navigator scopes
   * concerns to this target; non-target concerns are warn-only.
   */
  targetTestId?: string;
}

export interface NavigatorHookVerdict {
  overall: "approve" | "block";
  /** Per-axis concerns; surfaced in audit + folded into next iter on block. */
  concerns: string[];
  /** Cost incurred (USD). Tracked against budget by callers that care. */
  costUsd?: number;
  /**
   * 0.19.0-alpha.5 (#77) — when navigator's soft signals (concerns
   * folded into prompts) have been ignored across iterations, it may
   * emit a HARD signal: a failing test that codifies the concern. The
   * test file is written into tests/navigator/ + becomes part of the
   * next iter's red-set, so driver MUST satisfy it.
   *
   * Path constraints (validated by validateProposedTestPath):
   *   - must start with `tests/navigator/`
   *   - must end with `.test.ts` or `.test.tsx`
   *   - no .. or absolute paths
   * Content is the literal file body (vitest test).
   *
   * Optional. Hook implementations gate this on their own escalation
   * heuristics (e.g., 2+ consecutive blocks on the same concern).
   */
  proposedTest?: { path: string; content: string };
}

/**
 * 0.19.0-alpha.4 — pure decision helper for navigator verdicts. Pulled
 * out of the runBrew loop so unit tests can exercise the consumer
 * logic without standing up the full brew context.
 *
 * Inputs: a verdict (or null when no hook configured / abstaining).
 * Output: { action, concernsSummary, costUsd } — concernsSummary is
 *   only set when action='block' (used for revert-history note).
 */
export function decideNavigatorAction(
  verdict: NavigatorHookVerdict | null,
): { action: "approve" | "block"; concernsSummary: string; costUsd: number } {
  if (!verdict) {
    return { action: "approve", concernsSummary: "", costUsd: 0 };
  }
  const cost = verdict.costUsd ?? 0;
  if (verdict.overall === "block") {
    const summary = verdict.concerns.slice(0, 5).join("; ") || "(no concerns text)";
    return { action: "block", concernsSummary: summary, costUsd: cost };
  }
  return { action: "approve", concernsSummary: "", costUsd: cost };
}

/**
 * 0.19.0-alpha.5 (#77) — validate a navigator-proposed test path.
 * Pure: takes a candidate path string + returns either the normalized
 * path or an error reason. Centralizes the path-shape rules so brew's
 * apply step + tests share the same gate.
 *
 * Rules:
 *   - must be relative
 *   - must start with `tests/navigator/`
 *   - must end with `.test.ts` or `.test.tsx`
 *   - no `..` segments
 *   - no leading slash
 */
export function validateProposedTestPath(
  path: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  if (typeof path !== "string" || path.length === 0) {
    return { ok: false, reason: "path is empty" };
  }
  if (path.startsWith("/")) {
    return { ok: false, reason: "absolute paths not allowed" };
  }
  if (path.split("/").includes("..")) {
    return { ok: false, reason: "'..' segments not allowed" };
  }
  if (!path.startsWith("tests/navigator/")) {
    return { ok: false, reason: "must start with 'tests/navigator/'" };
  }
  if (!path.endsWith(".test.ts") && !path.endsWith(".test.tsx")) {
    return { ok: false, reason: "must end with '.test.ts' or '.test.tsx'" };
  }
  return { ok: true, path };
}

/**
 * 0.19.0-alpha.5 (#77) — extract a navigator-proposed test from a
 * verdict. Pure: returns the validated file payload OR null when the
 * verdict has no proposedTest / fails validation. Caller owns the
 * write side-effect.
 *
 * Note: only proposedTests on BLOCK verdicts are honored. An approve
 * verdict with proposedTest is a logic error in the hook and we
 * silently drop it (this prevents a navigator from polluting tests/
 * mid-run on iterations it actually approved of).
 */
export function extractNavigatorProposedTest(
  verdict: NavigatorHookVerdict | null,
): { path: string; content: string } | null {
  if (!verdict || verdict.overall !== "block" || !verdict.proposedTest) return null;
  const { path, content } = verdict.proposedTest;
  const v = validateProposedTestPath(path);
  if (!v.ok) return null;
  if (typeof content !== "string" || content.length === 0) return null;
  return { path: v.path, content };
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
 * dovizir §11 — how many consecutive no-EDIT turns to allow when the agent is
 * still calling tools (reading, listing). Higher than the silent cap because
 * orienting on a large spec legitimately takes several read-only turns.
 */
const EXPLORING_NO_EDIT_CAP = 5;

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
  // dovizir §11 — an EMPTY codemap (scope_files=0) leaves the driver to
  // rediscover the repo by hand every turn, which is what the stall detector
  // then punished. Nothing warned; now it does.
  warnIfCodeMapEmpty(ctx);

  const manifestPath = join(ctx.repoRoot, ".brewing/manifests", `story-${ctx.storyId}.json`);
  if (!existsSync(manifestPath)) {
    return haltFor(ctx, {
      reason: "MANIFEST_MISSING",
      iterations: 0,
      checkpoints: 0,
      greenCount: 0,
      totalCount: 0,
      spendUsd: 0,
      summary: `No manifest found at \`.brewing/manifests/story-${ctx.storyId}.json\`. Run testgen first.`,
    });
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    tests: Array<{ id: string; file: string; release_order?: number }>;
  };
  // 2026-08-23 (story-016 post-mortem) — cross-suite story contract. The
  // recorded manifest historically listed only the primary (vitest) tier;
  // story-matched tests in other declared suites (pgTAP db, acceptance)
  // were invisible to the red-set and a schema story could go "green"
  // with no migration. Cheap discovery over every suite folds them in;
  // the loop then brews them like any other red.
  try {
    const discovery = discoverTests(ctx.stackConfig, { cwd: ctx.repoRoot });
    const folded = foldCrossSuiteTests(manifest.tests, discovery.tests, ctx.storyId);
    if (folded.length > 0) {
      manifest.tests = [...manifest.tests, ...folded];
      appendRunLog(
        ctx,
        `CROSS_SUITE  +${folded.length} story test(s) beyond the recorded manifest folded into the contract: ${folded.map((t) => t.id).join(", ").slice(0, 300)}`
      );
    }
  } catch (e) {
    appendRunLog(ctx, `CROSS_SUITE_DISCOVERY_ERROR  ${(e as Error).message.slice(0, 200)}`);
  }
  // LADDER MODE: the manifest is the whole coherent suite, but the agent sees
  // only the released prefix — rung k must be green before rung k+1 exists.
  // Without --ladder (or without release_order fields) this is exactly the
  // full set, today's behavior.
  const allManifestIds = new Set(manifest.tests.map((t) => t.id));
  let expectedTestIds = ctx.ladder
    ? ladderWindow(manifest.tests, new Set<string>()).released
    : allManifestIds;
  ctx.manifestTestIds = [...expectedTestIds];
  // (ladder: refreshed after every window advance so compile-fail synthesis
  // never manufactures failures for tests the agent cannot even see)

  // 0.11.16+ — derive per-iter test scope from manifest. Per-iter
  // runs only the story's tests (cheap heuristic); the
  // brew-completion full-suite gate catches transitive regressions
  // in other stories before we open the PR.
  const storyTestFiles = deriveStoryTestFiles(manifest.tests);

  // 0.12.0+ — load cross-brew provenance. Build a prior-context
  // block referencing files this brew is likely to touch (manifest
  // files + their directory neighbours). Empty string when there's
  // no history (first brew on the project, or no overlap with prior
  // brews). Computed once per brew run; injected into the cached
  // prefix of every iter's prompt — same data, free re-cache.
  const provenanceIndex = readProvenance(ctx.repoRoot);
  const priorContextBlock = renderPriorContextBlock(
    provenanceIndex,
    storyTestFiles,
    `story-${ctx.storyId}`
  );
  if (priorContextBlock) {
    appendRunLog(
      ctx,
      `PRIOR_CONTEXT  files=${(priorContextBlock.match(/^- `/gm) ?? []).length}`
    );
  }

  // Phase 2C (0.12.12+) — load the project's pattern index. Hand-
  // written recipes at .brewing/patterns/*.md describe project-specific
  // conventions. The index (title + summary per pattern) is cheap to
  // include in the cached prefix; the agent reads full pattern files
  // on-demand via read_file.
  const patternIndexBlock = renderPatternIndexBlock(gatherPatternIndex(ctx.repoRoot));
  if (patternIndexBlock) {
    appendRunLog(
      ctx,
      `PATTERN_INDEX  count=${(patternIndexBlock.match(/^- /gm) ?? []).length}`
    );
  }

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

  // 0.12.3+ — full-suite baseline ALSO runs at brew start. Captures
  // which tests OUTSIDE the story manifest are currently green so the
  // brew-completion gate can detect TRUE transitive regressions
  // (tests that were green and went red because of brew's edits)
  // vs FALSE POSITIVES (tests that were already red on main from
  // unbrewed stories — common in multi-story projects).
  //
  // Without this, the gate flags all pre-existing reds as regressions
  // and halts every successful brew. Observed on rewo Run F (Sonnet,
  // 32/32 story green) which incorrectly halted with 123 "transitive
  // regressions" — all of which were already red on main from
  // story-001/003/004 etc. that hadn't been brewed yet.
  console.log("→ baseline test run (full suite for gate reference)…");
  const fullBaseline = runTestSuite(ctx); // no scope = full suite
  const fullBaselineGreen = fullBaseline.ran
    ? new Set(fullBaseline.tests.filter((t) => t.status === "passed").map((t) => t.id))
    : new Set<string>();
  appendRunLog(
    ctx,
    `BASELINE_FULL  total=${fullBaseline.tests.length} green=${fullBaselineGreen.size} red=${fullBaseline.tests.length - fullBaselineGreen.size}`
  );
  if (!baseline.ran) {
    // 0.16.0-α.28 — partial-degradation: if SOME suites produced tests
    // (e.g. backend vitest passed) but others failed (e.g. playwright
    // acceptance crashed because Next webServer couldn't boot without
    // .env.acceptance), proceed with what we got + log the degradation
    // instead of halting TEST_RUNNER_BROKEN. Halt only when nothing ran.
    if (baseline.tests.length === 0) {
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
    const failedSuiteNames = baseline.suites
      .filter((s) => s.exit_code !== 0)
      .map((s) => s.suite)
      .join(", ") || "(unknown)";
    console.log(
      `⚠ baseline DEGRADED — suite(s) "${failedSuiteNames}" couldn't boot; proceeding with ${baseline.tests.length} test(s) from suite(s) that did run.`
    );
    console.log(`   degradation reason: ${(baseline.error ?? "").slice(0, 300)}`);
    appendRunLog(
      ctx,
      `BASELINE_DEGRADED  failed_suites=${failedSuiteNames}  surviving_tests=${baseline.tests.length}  reason="${(baseline.error ?? "").slice(0, 200).replace(/"/g, "'")}"`
    );
  }

  // Fix 1 (0.7.14): keep a lookup of failure messages per test id so
  // each iteration's turn prompt can include the target test's failure
  // output. Seeds from baseline; refreshes after each test run below.
  let failureMessagesByTestId: Map<string, string> = buildFailureMap(baseline.tests);
  let lastRunTests = baseline.tests;
  let greenSet = new Set(
    baseline.tests.filter((t) => t.status === "passed").map((t) => t.id)
  );
  let redSet = new Set(
    baseline.tests.filter((t) => t.status !== "passed").map((t) => t.id)
  );
  const discoveredIds = new Set<string>([...greenSet, ...redSet]);

  if (ctx.ladder) {
    const w = ladderWindow(manifest.tests, greenSet);
    expectedTestIds = w.released;
    appendRunLog(ctx, describeWindow(w, manifest.tests.length));
  }
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
        `Story manifest lists ${expectedTestIds.size} test(s) but the test runner reported only ${discoveredIds.size} test(s) in this run — ${undiscoveredStoryTests.length} of the story's tests are invisible to the runner. ` +
        `First missing: \`${undiscoveredStoryTests[0]}\`. ` +
        `Most common cause: the runner's include pattern doesn't cover the test files' path (vitest: \`vitest.config.ts\` \`include\` only matching \`src/**/*.test.ts\` while tests live under \`tests/integration/\`; forge: \`foundry.toml\` \`test\` dir not covering the files). ` +
        `Fix the config and re-run.`,
    });
  }

  // TESTS_BROKEN pre-flight (ledger G27): when the story's failures are
  // dominated by one shared NON-assertion error (a setup crash — missing
  // export, unresolvable module), the suite cannot initialize and no
  // amount of src/ iteration can green it: the broken file is the frozen
  // tests' own. Halt IMMEDIATELY with the error surfaced — story-019's
  // brew burned $6.24 discovering "mockUnification is not a function"
  // one read-only iteration at a time.
  {
    const setupCrashRe = /is not a function|is not defined|Cannot find (module|package)|ReferenceError|TypeError/;
    const storyFailures = baseline.tests.filter(
      (t) => expectedTestIds.has(t.id) && t.status !== "passed" && t.failure_message
    );
    const crashes = storyFailures.filter((t) => setupCrashRe.test(t.failure_message ?? ""));
    if (storyFailures.length >= 4 && crashes.length / storyFailures.length > 0.5) {
      const byMsg = new Map<string, number>();
      for (const t of crashes) {
        const key = (t.failure_message ?? "").slice(0, 120);
        byMsg.set(key, (byMsg.get(key) ?? 0) + 1);
      }
      const [topMsg, topCount] = [...byMsg.entries()].sort((a, b) => b[1] - a[1])[0]!;
      return haltFor(ctx, {
        reason: "TESTS_BROKEN",
        iterations: 0,
        checkpoints: 0,
        greenCount: greenSet.size,
        totalCount: expectedTestIds.size,
        spendUsd: 0,
        summary:
          `${crashes.length}/${storyFailures.length} of the story's failing tests crash in SETUP rather than failing an assertion ` +
          `(${topCount}x: \`${topMsg}\`). The frozen suite cannot initialize — no implementation change can green it. ` +
          `Fix the tests artifact (recipe resubmit) before brewing; not one iteration was spent.`,
      });
    }
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
  /** Consecutive no-edit turns in which the agent DID call tools (§11). */
  let consecutiveExploring = 0;
  // #399 — ONE conversation per story; lessons + recovery-reset state.
  const conversation: Msg[] = [];
  const lessons: { iteration: number; note: string }[] = [];
  let failuresOnCurrentTarget = 0;
  let lastFailedTarget = "";
  let pendingResetDigest = "";
  const seenTargets = new Set<string>();
  // P5 — contradiction detection: target × broken-green pairs, counted.
  const regressionPairs = new Map<string, number>();
  // STASH, DON'T DELETE (the $31 post-mortem): a revert that erases an
  // 800-line attempt forces the next turn to re-emit it at full output price
  // — we paid for near-identical code three times. The diff is saved as a
  // patch and the next turn is told to READ + PATCH instead of re-emitting.
  const stashAttempt = (iterN: number): string | null => {
    try {
      const diff = execSync("git diff", { cwd: ctx.repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
      if (!diff.trim()) return null;
      const rel = join(".brewing", "local", "runs", "patches", `story-${ctx.storyId}-iter-${iterN}.patch`);
      const abs = join(ctx.repoRoot, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, diff, "utf8");
      return rel;
    } catch { return null; }
  };
  const recordTargetFailure = (target: string): void => {
    failuresOnCurrentTarget = target === lastFailedTarget ? failuresOnCurrentTarget + 1 : 1;
    lastFailedTarget = target;
    if (failuresOnCurrentTarget >= (ctx.resetAfterFailures ?? RESET_AFTER_FAILURES)) {
      // #399 — fresh context as RECOVERY: the reasoning on this target is
      // likely poisoned; wipe once, carry the lessons as a digest.
      pendingResetDigest = resetDigest(lessons);
      conversation.length = 0;
      ctx.cliSessionId = undefined; // #393 — the CLI session IS the conversation
      failuresOnCurrentTarget = 0;
      appendRunLog(ctx, `ITER-BOUNDARY CONTEXT RESET (recovery after repeated failures on ${target.slice(0, 80)}) — lessons carried: ${lessons.length}`);
    }
  };
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
  // PEEL ("ratchet, not a deadlock"): when most failing tests share ONE
  // failure root (deploy revert / thrown beforeAll), the suite is masked, not
  // atomic. The rung to climb first is the shared cause; the turn prompt
  // LEADS with it, and resolution (root gone/changed/fragmented) counts as
  // progress even though no test flipped yet.
  const peelInput = () => baselineScopedFailures();
  function baselineScopedFailures() {
    return lastRunTests
      .filter((t) => expectedTestIds.has(t.id))
      .map((t) => ({ id: t.id, status: t.status, failure_message: t.failure_message }));
  }
  let activePeel: PeelResult = detectMaskedMonolith(peelInput());
  if (activePeel.masked) appendRunLog(ctx, `PEEL  ${activePeel.reason}`);
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
    // Heartbeat: a long run must not look abandoned to a brew on another host,
    // which cannot signal-check our pid and falls back to this timestamp.
    touchLock(ctx.repoRoot);
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

    // 0.12.8+ (Phase 2B) — refresh per-iter target slice. Cheap (slice +
    // render off the cached JSON, no ts-morph rescan). The agent's first
    // read on this iter sees just the entries scoped to currentTarget.
    regenerateTargetSlice(ctx, currentTarget, findTargetTestFile(ctx, currentTarget));

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

    // #399 — compact when the story conversation nears the window; reset is
    // handled at the failure sites (a recovery, never the default).
    if (estimateTokens(conversation) > COMPACT_AT_TOKENS) {
      const n = compactOldToolResults(conversation);
      appendRunLog(ctx, `ITER ${iteration} COMPACTED  ${n} old tool_result(s) truncated  est_tokens≈${estimateTokens(conversation)}`);
    }
    // Multi-model (the $31 post-mortem): FIRST contact with a target (and any
    // post-reset turn) uses the PLAN model; every later turn on the same
    // target is mechanical emission/repair — the cheaper EMIT model.
    const isFirstContact = !seenTargets.has(currentTarget) || conversation.length === 0;
    seenTargets.add(currentTarget);
    ctx.turnModel = isFirstContact ? ctx.model : (ctx.emitModel ?? ctx.model);
    if (ctx.turnModel !== ctx.model) appendRunLog(ctx, `ITER ${iteration} MODEL  emit=${ctx.turnModel} (plan=${ctx.model})`);
    const usageBefore = { ...(ctx.usageTotals ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 }) };
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
      priorContextBlock,
      patternIndexBlock,
      conversation,
      resetDigestText: pendingResetDigest,
      peelBlock: activePeel.masked ? peelTargetPrompt(activePeel) : undefined,
    });
    pendingResetDigest = "";
    spendUsd += turnResult.spendDelta;
    // LEDGER PER ITERATION (the $31 reconciliation, 2026-08-15): exit-time
    // writes lose killed/crashed runs — which are precisely the expensive
    // ones. One small row per turn is crash-proof; `cost reprice` can always
    // re-derive from the tokens. Never fail a brew over bookkeeping.
    try {
      const t = ctx.usageTotals ?? usageBefore;
      appendCostEntry(ctx.repoRoot, ctx.storyId, {
        agent: "brew",
        usd: turnResult.spendDelta,
        model: ctx.turnModel ?? ctx.model,
        round: `iter-${iteration}`,
        at: new Date().toISOString(),
        tokens_in: t.inputTokens - usageBefore.inputTokens,
        tokens_out: t.outputTokens - usageBefore.outputTokens,
        cache_read: t.cacheReadTokens - usageBefore.cacheReadTokens,
        cache_create: t.cacheCreateTokens - usageBefore.cacheCreateTokens,
      });
      applyCostToSpec(ctx.repoRoot, ctx.storyId);
    } catch { /* bookkeeping must never halt the work */ }

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
      // §13 — a TRUNCATED turn (round cap hit while the agent still wanted
      // tools) is brew cutting the agent off mid-work. Counting it toward the
      // agent-stall verdict punished the agent for brew's own cap: the live
      // run halted AGENT_STALLED_NO_EDITS after two truncated orientation
      // turns. Truncation still costs stagnation (the global progress cap),
      // but never feeds the stall counter.
      if (!turnResult.truncatedAtRoundCap) consecutiveNoEdits += 1;
      // dovizir §11 — a turn with tool calls but no edits is EXPLORING, not
      // idle. Tracked separately so the stall threshold can be laxer for it.
      if (turnResult.toolCallCount > 0) consecutiveExploring += 1;
      else consecutiveExploring = 0;

      // Log the no-edits event so CI stdout shows the stall live.
      // Without this, the dominant-pattern stall (agent reasoning but
      // never calling a tool) looks identical in logs to a fast
      // successful turn — only the spend-delta on the NEXT iter's
      // START line reveals tokens were burned.
      appendRunLog(
        ctx,
        // The old wording claimed "no tool calls" even when 22 were made
        // (dovizir §11) — it only ever meant no EDIT calls. Say which.
        `ITER ${iteration} NO-EDITS  (${turnResult.toolCallCount > 0
          ? `${turnResult.toolCallCount} read-only tool calls — exploring, no writes`
          : "agent made no tool calls at all"})  spend_delta=$${turnResult.spendDelta.toFixed(2)}  consecutive_no_edits=${consecutiveNoEdits}  stagnation=${stagnation}/${STAGNATION_CAP}`
      );

      // 0.16.0-α.30: halt-envelope parser. The plate-mode prompt tells
      // the agent to halt by emitting `<halt class="X">...</halt>` in
      // its text. Without this parser, brew never reads its own agent's
      // halt envelopes and falls through to AGENT_STALLED_NO_EDITS — the
      // agent's perfect MOCKUP_DESIGN_CONFLICT classification gets
      // converted to a generic stall (rewo PR #147 brew run 25278580747:
      // agent emitted MOCKUP_DESIGN_CONFLICT envelope, brew reported
      // AGENT_STALLED_NO_EDITS, $0.91 wasted on the misclassification).
      const haltEnvelope = parseHaltEnvelope(turnResult.rationale);
      if (haltEnvelope) {
        appendRunLog(
          ctx,
          `ITER ${iteration} ${haltEnvelope.class} — agent emitted halt envelope in rationale`
        );
        return haltFor(ctx, {
          reason: haltEnvelope.class,
          iterations: iteration,
          checkpoints: iterationLogs.filter((l) => l.outcome === "checkpoint").length,
          greenCount: greenSet.size,
          totalCount: expectedTestIds.size,
          spendUsd,
          iterationLogs,
          summary: haltEnvelope.summary,
        });
      }

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

      // Fix 4 (0.7.14): consecutive zero-edit iterations → halt. The model
      // spent context tokens reasoning but produced nothing.
      //
      // dovizir handover §11 — that rule killed a legitimate run: the driver
      // made 21–22 read_file/list_directory calls per iteration orienting on
      // a large pinned spec, and was halted after 2. Reading IS work, so an
      // exploring turn gets a laxer threshold than a truly silent one. The
      // cap is also configurable now (`--stall-iterations`) because the right
      // number depends on how big the thing being read is.
      const silentCap = ctx.stallIterations ?? 2;
      const exploringCap = Math.max(silentCap, (ctx.stallIterations ?? 0) || EXPLORING_NO_EDIT_CAP);
      const isExploring = consecutiveExploring >= consecutiveNoEdits && consecutiveNoEdits > 0;
      const stallCap = isExploring ? exploringCap : silentCap;
      if (consecutiveNoEdits >= stallCap) {
        appendRunLog(
          ctx,
          `ITER ${iteration} AGENT_STALLED_NO_EDITS — halting after ${consecutiveNoEdits} consecutive zero-edit iterations` +
            (isExploring ? ` (all with tool activity; explore cap ${exploringCap})` : ` (no tool activity; cap ${silentCap})`)
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

    // 0.18.0-α.5 — prune slowcook-managed auto-generated artifacts from
    // the agent's diff before scope/frozen checks. Files like
    // `.brewing/code-map.target.md` are regenerated by `slowcook map` /
    // pre-commit hooks and have no business being in the agent's
    // commit. Without this prune, the agent collateral-touching them
    // (e.g. when its rationale step triggers code-map regen) caused
    // the WHOLE iteration to be rejected as a scope violation, even
    // when the actual src/ change was correct. Caught 2026-05-04 on
    // rewo issue #149 brew run 25305746902 — 10 iters $2.03 wasted.
    pruneAutoGeneratedArtifacts(ctx);

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

    // 0.16.0-α.29 — plate-mode contract refinement.
    //
    // Old contract ("don't touch the UI") was too rigid — the
    // data-wiring IS in the component (handlers POST, hooks fetch,
    // forms submit). Forbidding all UI edits forced brew to find
    // nonexistent escape hatches and stalled (rewo PR #147 brew run
    // 25278045422 — AGENT_STALLED_NO_EDITS at $1.82, agent correctly
    // diagnosed it needed to wire POST /api/pins but the click handler
    // lives in the ported component).
    //
    // New contract: "preserve UI shape, swap mock data for real data."
    //
    //   - Port-marked files (@slowcook-port-from) are the ONLY UI-tree
    //     files brew is allowed to write — to wire real data + handlers
    //     into the shape that vibe defined. Brew should preserve JSX
    //     structure, props signature, className, layout. Tier-2
    //     acceptance + visual regression are the backstop for shape
    //     drift.
    //
    //   - .mock.ts files: still rejected (those are pre-port mock
    //     fixtures with no behavior to wire).
    //
    //   - src/components/* and src/*.tsx WITHOUT the port marker:
    //     consumer's hand-written prod UI. Off-limits in plate mode
    //     (brew shouldn't touch UI it didn't get from vibe).
    // 0.17.0-α.7 — file-level edit lock LIFTED.
    //
    // Previously (α.29): brew rejected edits to src/components/* and
    // src/*.tsx files without @slowcook-port-from. That guard prevented
    // silent shape corruption BUT also blocked edits brew legitimately
    // needed (Server Component data-fetch, hand-written prod
    // extension, etc.). It produced "agent stalled" halts on stories
    // whose contract required cross-boundary edits.
    //
    // The replacement protection is structural shape tests emitted by
    // recon (slowcook 0.17.6+) into tests/integration/story-N-shape.test.tsx.
    // Those assert testid presence, visual className tokens, semantic
    // landmarks. Combined with the full-suite test gate (existing
    // α.27 logic that reverts iterations breaking previously-green
    // tests), shape corruption is caught at test-time.
    //
    // .mock.ts files are STILL rejected — those are pre-port mock
    // fixtures with no behavior to wire and no shape contract to
    // preserve. They shouldn't appear in src/ at all.
    const platePathHit =
      ctx.mode === "plate"
        ? diff.changedPaths.find((p) => /\.mock\.ts$/.test(p))
        : null;
    if (platePathHit) {
      revertToSnapshot(ctx, snapshot);
      iterationLogs.push({
        iteration,
        target_test_id: currentTarget,
        outcome: "rejected-frozen-path",
        note: `plate-mode rejects edits to .mock.ts files (pre-port mock fixtures): ${platePathHit}.`,
        files_touched: diff.changedPaths,
        lines_added: diff.linesAdded,
        lines_removed: diff.linesRemoved,
        spend_delta_usd: turnResult.spendDelta,
        rationale: turnResult.rationale,
      });
      priorAttempts.push({
        iteration,
        outcome: "reverted-no-progress",
        note: `rejected: edited a .mock.ts file (${platePathHit}). Those are mock fixtures; brew shouldn't touch them.`,
        files_touched: diff.changedPaths,
      });
      stagnation += 1;
      appendRunLog(
        ctx,
        `ITER ${iteration} REJECT mock-fixture-edit  ${platePathHit}  spend_delta=$${turnResult.spendDelta.toFixed(2)}`
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
      {
        const savedPatch = stashAttempt(iteration);
        const note = `FIRST ACTION NEXT TURN: call justify_diff_overflow, THEN write. Your edit was THROWN AWAY${savedPatch ? ` (SAVED at ${savedPatch} — read_file it, then re-apply via justify_diff_overflow + writes rather than re-deriving)` : ""}: it exceeded the graduality cap (${DIFF_LINE_CAP} lines × ${DIFF_FILE_CAP} files) and you did not call justify_diff_overflow. Either make a smaller change, or call justify_diff_overflow BEFORE ending the turn to explain why the size is necessary.`;
        priorAttempts.push({ iteration, outcome: "rejected-overflow", note, files_touched: diff.changedPaths });
        lessons.push({ iteration, note });
        conversation.push(lessonMessage(iteration, note));
        recordTargetFailure(currentTarget);
      }
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
    if (!result.ran && result.tests.length === 0) {
      // 0.16.0-α.28 — only halt when zero tests came back. Same
      // degrade-on-partial policy as the baseline run: if SOME suite
      // produced tests, proceed with what we got.
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
    lastRunTests = result.tests;

    const newGreen = new Set(
      result.tests.filter((t) => t.status === "passed").map((t) => t.id)
    );
    const newRed = new Set(
      result.tests.filter((t) => t.status !== "passed").map((t) => t.id)
    );
    const regressions = [...greenSet].filter((t) => !newGreen.has(t));
    const gains = [...newGreen].filter((t) => !greenSet.has(t));

    if (regressions.length > 0) {
      // P5 — the same target breaking the same green test twice in a row is
      // a SPEC contradiction, not an agent failure. Halt with the pair named
      // and file a backprop claim so the founder decides which side wins.
      for (const broken of regressions) {
        const key = `${currentTarget} ⊗ ${broken}`;
        const n = (regressionPairs.get(key) ?? 0) + 1;
        regressionPairs.set(key, n);
        if (n >= 2) {
          revertToSnapshot(ctx, snapshot);
          appendRunLog(ctx, `ITER ${iteration} SPEC_CONTRADICTION  greening "${currentTarget!.slice(0, 70)}" broke "${broken.slice(0, 70)}" ${n}× — the spec disagrees with itself`);
          try {
            await fileBackpropClaims(ctx.repoRoot, [{
              target: "stories",
              summary: `spec contradiction: satisfying one test repeatedly breaks another`,
              detail: `Greening the target test broke the same green test ${n} times in a row.\nTarget:  ${currentTarget}\nBroken:  ${broken}\nOne of the two requirements must be superseded; a machine cannot pick which.`,
              source: `brew story-${ctx.storyId} iteration ${iteration}`,
            }]);
          } catch { /* claim filing is best-effort; the halt still names the pair */ }
          return haltFor(ctx, {
            reason: "SPEC_CONTRADICTION",
            iterations: iteration,
            checkpoints: iterationLogs.filter((l) => l.outcome === "checkpoint").length,
            greenCount: greenSet.size,
            totalCount: expectedTestIds.size,
            spendUsd,
            iterationLogs,
            summary: `Satisfying "${currentTarget}" broke "${broken}" ${n} times in a row. The two requirements are incompatible — a backprop claim was filed; the founder decides which side wins.`,
          });
        }
      }
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
      {
        // §13 — the names are the one fact the next attempt needs; #399 — the
        // same note lands IN the conversation, so the next turn cites it
        // instead of re-orienting.
        const savedPatch = stashAttempt(iteration);
        const note = `your edit was REVERTED${savedPatch ? ` (the full diff is SAVED at ${savedPatch} — read_file it and PATCH what broke instead of re-emitting everything)` : ""} because it broke ${regressions.length} green test(s): ${regressions.slice(0, 4).join(" | ")}${regressions.length > 4 ? ` | +${regressions.length - 4} more` : ""}. The next edit must satisfy the target WITHOUT violating what these protect.`;
        priorAttempts.push({ iteration, outcome: "reverted-regression", note, files_touched: diff.changedPaths });
        lessons.push({ iteration, note });
        conversation.push(lessonMessage(iteration, note));
        recordTargetFailure(currentTarget);
      }
      stagnation += 1;
      appendRunLog(
        ctx,
        `ITER ${iteration} REVERT regression  files=[${diff.changedPaths.slice(0, 3).join(",")}${diff.changedPaths.length > 3 ? "+" + (diff.changedPaths.length - 3) : ""}] +${diff.linesAdded}/-${diff.linesRemoved}  broke=${regressions.length} [${regressions.slice(0, 3).join(" | ")}${regressions.length > 3 ? " | +" + (regressions.length - 3) : ""}]  spend_delta=$${turnResult.spendDelta.toFixed(2)}`
      );
      continue;
    }

    // PEEL resolution check: the turn may have dissolved the shared wall even
    // though no individual test flipped yet — that IS progress on the rung.
    const newPeel = detectMaskedMonolith(peelInput());
    const peelJustResolved = activePeel.masked && peelResolved(activePeel, newPeel);
    if (peelJustResolved) {
      appendRunLog(
        ctx,
        `ITER ${iteration} PEEL-RESOLVED  "${activePeel.sharedRoot.slice(0, 80)}" ` +
          (newPeel.masked ? `→ next mask: "${newPeel.sharedRoot.slice(0, 80)}" (${newPeel.sharedCount})` : `→ gradient unmasked (${[...newRed].length} independent reds)`)
      );
      activePeel = newPeel;
      if (newPeel.masked) appendRunLog(ctx, `PEEL  ${newPeel.reason}`);
    }
    // Only SHORT-CIRCUIT on peel resolution when nothing actually went green.
    // Dissolving the wall often greens the masked tests in the same turn — and
    // this branch used to `continue` before the gains were ever recorded, so
    // brew threw away a fully-green suite, kept reporting 0/4, and halted
    // AGENT_STALLED_NO_EDITS while the agent correctly insisted the code was
    // right. It was: `vitest run` said 4 passed at that exact commit.
    if (peelIsStandaloneCheckpoint(peelJustResolved, gains.length)) {
      iterationLogs.push({
        iteration,
        target_test_id: currentTarget,
        outcome: "checkpoint",
        note: "peel rung resolved — the shared failure wall fell; tests now report toward a gradient",
        files_touched: diff.changedPaths,
        lines_added: diff.linesAdded,
        lines_removed: diff.linesRemoved,
        spend_delta_usd: turnResult.spendDelta,
        rationale: turnResult.rationale,
      });
      continue;
    }
    activePeel = newPeel;

    if (gains.length === 0) {
      // KEEP-COMPILING-DIFF (the $31 post-mortem's biggest single flaw):
      // "compiles but 0 tests flipped YET" was treated identically to
      // garbage and reverted — so an all-or-nothing story re-emitted ~830
      // lines every iteration at full output price. No test regressed
      // (that's the branch above), so the work STAYS as the base and the
      // next turn PATCHES it in place. --strict-revert restores the old
      // guillotine. The stash is still written for provenance.
      if (ctx.strictRevert) {
        revertToSnapshot(ctx, snapshot);
      } else {
        stashAttempt(iteration);
      }
      const kept = !ctx.strictRevert;
      iterationLogs.push({
        iteration,
        target_test_id: currentTarget,
        outcome: "reverted-no-progress",
        note: kept ? "no test flipped — code KEPT in place as the next turn's base" : "no test changed from red to green",
        files_touched: diff.changedPaths,
        lines_added: diff.linesAdded,
        lines_removed: diff.linesRemoved,
        spend_delta_usd: turnResult.spendDelta,
        rationale: turnResult.rationale,
      });
      priorAttempts.push({
        iteration,
        outcome: "reverted-no-progress",
        note: kept
          ? "no test flipped YET — but your files are still IN PLACE. Read the failure messages and PATCH the existing code (small targeted edits); do NOT re-emit whole files."
          : "no test went from red to green",
        files_touched: diff.changedPaths,
      });
      stagnation += 1;
      appendRunLog(
        ctx,
        `ITER ${iteration} ${kept ? "KEPT no-progress (code stays as base)" : "REVERT no-progress"}  files=[${diff.changedPaths.slice(0, 3).join(",")}${diff.changedPaths.length > 3 ? "+" + (diff.changedPaths.length - 3) : ""}] +${diff.linesAdded}/-${diff.linesRemoved}  spend_delta=$${turnResult.spendDelta.toFixed(2)}`
      );
      continue;
    }

    // 0.19.0-alpha.4 — pair-brew navigator hook. Fires only when one
    // is configured (default: no hook → no behavioral change). On
    // 'block', the iteration reverts + folds the concerns into next
    // iter's prior_attempts. On 'approve' or null, the checkpoint
    // proceeds.
    if (ctx.navigatorHook) {
      const navVerdict = await ctx.navigatorHook.review({
        iteration,
        storyId: ctx.storyId,
        filesTouched: diff.changedPaths,
        linesAdded: diff.linesAdded,
        linesRemoved: diff.linesRemoved,
        rationale: turnResult.rationale,
        gainedTests: gains,
        repoRoot: ctx.repoRoot,
        // α.55 — scope navigator's concerns to the iteration target.
        targetTestId: currentTarget ?? undefined,
      });
      const navDecision = decideNavigatorAction(navVerdict);
      spendUsd += navDecision.costUsd;
      if (navDecision.action === "block") {
        appendRunLog(
          ctx,
          `ITER ${iteration} NAVIGATOR_BLOCK files=${diff.changedPaths.length} concerns=${(navVerdict?.concerns.length ?? 0)} cost=$${navDecision.costUsd.toFixed(2)}`
        );
        revertToSnapshot(ctx, snapshot);
        // 0.19.0-alpha.5 (#77) — navigator may emit a hard-signal test
        // when its soft prompts are being ignored. Write only AFTER
        // revert (the reverted state is the file system the test will
        // be run against). validateProposedTestPath has already
        // confirmed the path is under tests/navigator/, so frozen-path
        // checks won't catch it (tests/ is intentionally writable for
        // navigator escalations only).
        const proposed = extractNavigatorProposedTest(navVerdict);
        let proposedTestNote = "";
        if (proposed) {
          const abs = join(ctx.repoRoot, proposed.path);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, proposed.content, "utf8");
          proposedTestNote = ` · navigator emitted test: ${proposed.path}`;
          appendRunLog(
            ctx,
            `ITER ${iteration} NAVIGATOR_TEST_EMITTED  path=${proposed.path}  size=${proposed.content.length}b`
          );
        }
        priorAttempts.push({
          iteration,
          outcome: "reverted-no-progress",
          note: `navigator blocked: ${navDecision.concernsSummary}${proposedTestNote}`,
          files_touched: diff.changedPaths,
        });
        iterationLogs.push({
          iteration,
          target_test_id: currentTarget,
          outcome: "reverted-no-progress",
          note: `navigator blocked: ${navDecision.concernsSummary}${proposedTestNote}`,
          files_touched: diff.changedPaths,
          lines_added: diff.linesAdded,
          lines_removed: diff.linesRemoved,
          spend_delta_usd: turnResult.spendDelta + navDecision.costUsd,
          rationale: turnResult.rationale,
        });
        stagnation += 1;
        continue;
      }
      // approve → fall through to checkpoint commit
    }

    // Progress! checkpoint
    commitCheckpoint(ctx, {
      iteration,
      target: currentTarget,
      gains,
      filesTouched: diff.changedPaths,
    });
    greenSet = newGreen;
    if (ctx.ladder) {
      const before = expectedTestIds.size;
      const w = ladderWindow(manifest.tests, greenSet);
      expectedTestIds = w.released;
      if (w.released.size > before) {
        appendRunLog(ctx, `LADDER-ADVANCE  ${describeWindow(w, manifest.tests.length)}`);
      }
      ctx.manifestTestIds = [...expectedTestIds];
    }
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
      lintResult = runLint(ctx.stackConfig, {
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
    // 2026-08-23 (story-016 post-mortem) — FAIL CLOSED. The old mercy path
    // ("proceeding without full-suite verdict") let ONE broken suite runner
    // discard every other suite's verdict, and a schema story shipped with
    // no migration while its db suite sat red. A declared suite is a
    // promise: fix the runner or remove the suite from .brewing/stack.json.
    const verdict = finalGateVerdict(finalRun, expectedTestIds, fullBaselineGreen);
    if (verdict.kind === "runner_broken") {
      appendRunLog(
        ctx,
        `FINAL_GATE_RUNNER_BROKEN  suites=[${verdict.brokenSuites.join(", ")}] — halting (fail closed)`
      );
      return haltFor(ctx, {
        reason: "FINAL_GATE_RUNNER_BROKEN",
        iterations: iterationLogs.length,
        checkpoints: iterationLogs.filter((l) => l.outcome === "checkpoint").length,
        greenCount: greenSet.size,
        totalCount: expectedTestIds.size,
        spendUsd,
        iterationLogs,
        summary:
          `Story tests are green, but the final gate could not obtain a full-suite verdict: ` +
          `suite runner(s) [${verdict.brokenSuites.join(", ")}] failed to run. Detail: ${verdict.detail.slice(0, 500)}. ` +
          `A declared suite is a promise — fix the runner (or remove the suite from .brewing/stack.json if it is intentionally not runnable here), then re-run brew. ` +
          `Nothing was pushed: shipping without the verdict is how a schema story once merged with no migration.`,
      });
    }
    if (verdict.kind === "story_red") {
      appendRunLog(
        ctx,
        `FINAL_GATE_STORY_RED  count=${verdict.storyRed.length} first=${verdict.storyRed[0]?.id?.slice(0, 100)}`
      );
      return haltFor(ctx, {
        reason: "STORY_SUITE_RED",
        iterations: iterationLogs.length,
        checkpoints: iterationLogs.filter((l) => l.outcome === "checkpoint").length,
        greenCount: greenSet.size,
        totalCount: expectedTestIds.size,
        spendUsd,
        iterationLogs,
        summary:
          `${verdict.storyRed.length} story-scoped test(s) are red at the final gate: ` +
          verdict.storyRed.slice(0, 3).map((t) => `\`${t.id.slice(0, 150)}\`${t.failure_message ? ` (${t.failure_message.slice(0, 150)})` : ""}`).join("; ") +
          `. The loop reported green for its tracked set, so this indicates a contract the loop could not see or satisfy — investigate before shipping.`,
      });
    }
    if (verdict.kind === "regression") {
      appendRunLog(
        ctx,
        `FINAL_GATE_REGRESSION  true_regressions=${verdict.breaks.length} pre_existing_red=${verdict.preExistingRed} first_regression=${verdict.breaks[0]?.id?.slice(0, 100)}`
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
        summary: `Story tests all green, but the full-suite gate found ${verdict.breaks.length} TRUE regression(s) in tests OUTSIDE the story manifest (tests that WERE green at baseline and went red). Pre-existing reds on main (${verdict.preExistingRed}) are NOT counted. Brew touched code that other stories' tests cover. First true regression: \`${verdict.breaks[0]?.id?.slice(0, 200)}\`. Hand-investigate or expand the next brew's manifest scope.`,
      });
    }
    appendRunLog(
      ctx,
      `FINAL_GATE  pass  full_suite_green=${verdict.fullGreen} pre_existing_red=${verdict.preExistingRed}`
    );
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
  /**
   * dovizir handover §11 — how many tool calls the agent made, edits or not.
   * A driver that made 22 read_file calls orienting on a large spec is
   * EXPLORING, not stalled; without this the two were indistinguishable and
   * the run was killed after 2 iterations.
   */
  toolCallCount: number;
  /** §13 — the turn ended because brew's round cap cut it off mid-tool-use,
   *  not because the agent finished. Truncation is brew's doing; it must not
   *  count toward the agent-stall verdict. */
  truncatedAtRoundCap?: boolean;
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
    /** 0.12.0+ — markdown prior-brew-history block, derived once per brew run. */
    priorContextBlock?: string;
    /** 0.12.12+ — markdown index of `.brewing/patterns/*.md` (Phase 2C). */
    patternIndexBlock?: string;
    /** #399 — the story's ONE conversation. Empty ⇒ this turn builds the
     *  cached head (prefix + preload); non-empty ⇒ this turn appends a small
     *  dynamic body and inherits everything already read and learned. */
    conversation: Msg[];
    /** #399 — carried lesson digest after a recovery reset. */
    resetDigestText?: string;
    /** Peel rung block — leads the prompt when the suite is masked. */
    peelBlock?: string;
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
  // §13 orientation carry: pre-load the target test + the run's
  // most-consulted files, so a fresh-context turn starts oriented instead of
  // spending its tool rounds re-walking the repo (measured live: 14–26
  // read-only calls per iteration, two turns cut at the round cap).
  const preloadBlock = args.conversation.length > 0 ? "" : buildPreloadBlock({
    cache: ctx.readCache ?? new Map(),
    targetTestFile: targetFilePath,
    readFile: (rel) => {
      try {
        const full = resolveRepoPath(ctx, rel);
        return existsSync(full) && statSync(full).isFile() ? readFileSync(full, "utf8") : null;
      } catch { return null; }
    },
  });
  // #393 — CLI-backend dispatch happens after the prompt is built so both
  // backends share one prompt surface. The CLI session IS the conversation.
  const promptPartsForDispatch = null; // (marker; real parts built below)
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
    prior_context_block: args.priorContextBlock,
    pattern_index_block: args.patternIndexBlock,
    preloaded_files_block: preloadBlock,
    peel_rung_block: args.peelBlock,
  });
  // Backwards-compat: turnPrompt() still works for any non-brew caller
  // that hasn't migrated; quiet the lint that flags the unused import.
  void turnPrompt;
  void promptPartsForDispatch;

  // #393 — CLI backend: one headless claude session per iteration, tools
  // over MCP, session-resume as the #399 conversation. Dollars recorded at
  // LIST PRICE regardless of subscription auth (Amin's ruling).
  if (ctx.useCliBackend) {
    // Driver artifacts live OUTSIDE the repo (dogfood: mcp-config.json and
    // the overflow marker were counted in the agent's diff and reverted).
    const runDir = join(tmpdir(), `slowcook-brew-${ctx.storyId}`);
    const fresh = ctx.cliSessionId === undefined;
    const promptText = fresh
      ? `${promptParts.cachedPrefix}\n\n${promptParts.dynamicBody}${args.resetDigestText ? `\n\n${args.resetDigestText}` : ""}`
      : promptParts.dynamicBody;
    const model = ctx.turnModel ?? ctx.model;
    const r = runCliTurn({
      iteration: args.iteration,
      model,
      promptText,
      runDir,
      repoRoot: ctx.repoRoot,
      sessionId: ctx.cliSessionId,
      maxTurns: ctx.maxToolRounds ?? 30,
    });
    if (r.sessionId) ctx.cliSessionId = r.sessionId;
    // Fold usage into the run totals — the ledger's token fields read from
    // here, and the CLI path previously left them zero (the reason even a
    // graceful halt wrote no brew row on the dogfood box).
    const tot = (ctx.usageTotals ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 });
    tot.inputTokens += r.usage.inputTokens;
    tot.outputTokens += r.usage.outputTokens;
    tot.cacheReadTokens += r.usage.cacheReadTokens;
    tot.cacheCreateTokens += r.usage.cacheCreateTokens;
    if (r.errorText) appendRunLog(ctx, `ITER ${args.iteration} CLI-ERROR  ${r.errorText}`);
    if (r.authFailed) {
      // Not an agent stall: the local claude CLI has no usable session. Say
      // exactly that, once, and stop — retrying cannot help (rewo dogfood:
      // two iterations of 0 tool calls reported as AGENT_STALLED_NO_EDITS).
      console.error(
        `\nslowcook brew: the local claude CLI could not authenticate — ${r.errorText}\n` +
        `  Run \`claude setup-token\` on this host (or unset SLOWCOOK_LLM and set ANTHROPIC_API_KEY).\n`
      );
      process.exit(77);
    }
    appendRunLog(
      ctx,
      `ITER ${args.iteration} TOOLS  ${Math.min(r.toolTrace.length, 20)}/${r.toolTrace.length} calls  auth=subscription ($ at list price)  model=${model}${r.truncatedAtMaxTurns ? "  TRUNCATED" : ""}: ${r.toolTrace.slice(0, 20).join(", ")}${r.toolTrace.length > 20 ? ", …" : ""}`
    );
    // A tool failing the same way over and over is the finding. The
    // ladder-fixture run spent $2.27 across four iterations while the agent
    // kept saying write_file could not create a directory; brew reported
    // ITERATION_CAP and blamed the agent. Say the true thing instead.
    const toolFault = diagnoseToolFailure(r.toolErrors, r.toolTrace.length);
    if (toolFault.failing) {
      appendRunLog(ctx, `ITER ${args.iteration} ${toolFault.reason}`);
      console.error(
        `\nslowcook brew: ${toolFault.reason}\n` +
        `  The agent cannot make progress until this is fixed — halting instead of spending the budget on retries.\n`
      );
      // 78 is already the config-refusal code (unpriced model, unsupported
      // stack, dirty tree); a broken bridge needs its own so scripts can tell
      // "you configured this wrong" from "the tool itself is failing".
      process.exit(79);
    }
    // filesTouched via git status delta is the ratchet's own diff; report
    // write_file calls from the trace for the no-edit check.
    const writes = r.toolTrace.filter((t) => t.startsWith("write_file")).length;
    return {
      filesTouched: writes > 0 ? ["(cli-session-writes)"] : [],
      rationale: r.rationale,
      spendDelta: r.spendUsd,
      toolCallCount: r.toolCallCount,
      truncatedAtRoundCap: r.truncatedAtMaxTurns,
      ...(r.overflowJustification ? { overflowJustification: r.overflowJustification } : {}),
    };
  }

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
  // #399 — ONE conversation per story. First turn (or post-reset) sends the
  // cache-anchored head; later turns append only the small dynamic body, so
  // orientation and lessons persist instead of being re-paid.
  const messages = args.conversation;
  if (messages.length === 0) {
    const digest = args.resetDigestText ? `\n\n${args.resetDigestText}` : "";
    messages.push({
      role: "user",
      content: [
        { type: "text", text: promptParts.cachedPrefix, cache_control: { type: "ephemeral" } },
        { type: "text", text: promptParts.dynamicBody + digest },
      ] as never,
    });
  } else {
    // Continuing the story's conversation: the head already carries spec +
    // paths + preload; this turn only states what changed since last turn.
    messages.push({ role: "user", content: promptParts.dynamicBody });
  }

  // Safety cap on tool rounds per turn. "Should be plenty" was tuned on
  // sonnet webapp runs and cut opus-5 orientation mid-read (§13) — it is now
  // configurable, and hitting it is reported as TRUNCATION, not an agent stall.
  const maxRounds = ctx.maxToolRounds ?? 12;
  let roundsUsed = 0;
  let lastStopReason: string | null = null;
  for (let round = 0; round < maxRounds; round++) {
    roundsUsed = round + 1;
    // R3 slice (#399): the budget is checked BEFORE each call, not after the
    // turn — a single long turn can no longer blow through the cap unmetered.
    if (args.spendUsd + spendDelta >= ctx.budgetUsd) {
      appendRunLog(ctx, `ITER ${args.iteration} BUDGET-STOP pre-call  spent=$${(args.spendUsd + spendDelta).toFixed(2)} cap=$${ctx.budgetUsd.toFixed(2)} rounds=${round}`);
      break;
    }
    const response = await ctx.anthropic.messages.create({
      model: ctx.turnModel ?? ctx.model,
      // §13/R5 — 4096 was tuned on sonnet webapp diffs and cut opus-5 off
      // MID-WRITE: the live retry emitted justify_diff_overflow, started the
      // 333-line module, and died on stop_reason=max_tokens. An output cap is
      // a ceiling, not a purchase — raising it costs nothing until used.
      max_tokens: ctx.maxOutputTokens ?? 16384,
      // cache_control is accepted at runtime but older SDK type defs don't
      // expose it on TextBlockParam; `as never` gets past the structural
      // mismatch the same way refine/llm.ts does.
      system: [
        {
          type: "text",
          text:
            ctx.mode === "plate"
              ? BREW_SYSTEM + BREW_PLATE_MODE_ADDENDUM
              : BREW_SYSTEM,
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
    accumulateUsage(ctx, response);

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
      lastStopReason = response.stop_reason ?? null;
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

    lastStopReason = response.stop_reason ?? null;
    if (response.stop_reason !== "tool_use") break;
  }

  // §13/R6 — a turn that used every round and still wanted tools was CUT OFF
  // by brew, not finished by the agent. That distinction drives the stall
  // logic (truncation must not read as idling) and the halt report.
  const truncatedAtRoundCap = roundsUsed >= maxRounds && lastStopReason === "tool_use";

  // Rationale fallback chain (R6: a tool-only turn must never record "").
  // The dovizir halt reports had empty last_agent_rationale on every
  // iteration — with stop_reason unrecorded, the one diagnostic that would
  // have explained the stall was missing.
  if (!rationale && latestTextBlock) {
    rationale = `[no text-only completion within ${maxRounds} tool rounds; last text from exploration:]\n\n${latestTextBlock}`;
  }
  if (!rationale && toolCallTrace.length > 0) {
    rationale = `[tool-only turn: ${toolCallTrace.length} calls, stop_reason=${lastStopReason ?? "?"}${truncatedAtRoundCap ? ", TRUNCATED at round cap" : ""}. Trace: ${toolCallTrace.slice(0, 8).join(", ")}${toolCallTrace.length > 8 ? ", …" : ""}]`;
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
      `ITER ${args.iteration} TOOLS  ${trimmed.length}/${toolCallTrace.length} calls  rounds=${roundsUsed}/${maxRounds}  stop_reason=${lastStopReason ?? "?"}${truncatedAtRoundCap ? "  TRUNCATED" : ""}: ${trimmed.join(", ")}`
    );
  }

  return {
    filesTouched: [...filesTouched],
    rationale,
    spendDelta,
    toolCallCount: toolCallTrace.length,
    truncatedAtRoundCap,
    ...(overflowJustification ? { overflowJustification } : {}),
  };
}

/**
 * Say so when the driver is about to work blind (dovizir §11). `map generate`
 * had never run on the dovizir repo, so brew handed the agent an empty
 * codemap and then halted it for exploring — the two facts were connected and
 * neither was visible.
 */
function warnIfCodeMapEmpty(ctx: BrewContext): void {
  try {
    const p = join(ctx.repoRoot, ".brewing/code-map.json");
    if (!existsSync(p)) {
      appendRunLog(ctx, `WARN  no .brewing/code-map.json — the driver starts with no map of this repo. Run \`slowcook map generate\` for cheaper, better-targeted iterations.`);
      return;
    }
    const map = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown[]>;
    const total = ["api_routes", "pages", "components", "helpers", "types", "contracts"]
      .reduce((n, k) => n + (Array.isArray(map[k]) ? map[k].length : 0), 0);
    if (total === 0) {
      appendRunLog(ctx, `WARN  .brewing/code-map.json is EMPTY (0 entries) — the driver has no map of this repo and will spend iterations rediscovering it. Re-run \`slowcook map generate\`.`);
    }
  } catch { /* advisory only — never block a brew on the warning */ }
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
        const shown = txt.length > 20000 ? txt.slice(0, 20000) + "\n…(truncated)" : txt;
        // §13 orientation carry: remember what the run has consulted so the
        // NEXT fresh-context turn gets it pre-loaded instead of re-reading.
        recordRead((ctx.readCache ??= new Map()), p, shown);
        return { content: shown, is_error: false };
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
      // 0.12.0+ — symbol-aware retrieval (Phase 1 of bounded attention).
      // Backed by ts-morph syntax tree (no type-checking — fast, ~95%
      // accurate, false positives recoverable). Mandatory pre-write
      // discovery in BREW_SYSTEM tells the agent to call these BEFORE
      // writing any new exported symbol so duplications get caught.
      case "find_references": {
        const symbol = String(input["symbol"] ?? "").trim();
        const excludeDefinitions = Boolean(input["exclude_definitions"] ?? false);
        if (!symbol) return { content: "symbol is required", is_error: true };
        const refs = findReferences(ctx.repoRoot, symbol, { excludeDefinitions });
        return { content: renderReferences(refs), is_error: false };
      }
      case "find_implementations": {
        const name = String(input["interface_or_base"] ?? "").trim();
        if (!name) return { content: "interface_or_base is required", is_error: true };
        const refs = findImplementations(ctx.repoRoot, name);
        return { content: renderReferences(refs), is_error: false };
      }
      case "find_definition": {
        const symbol = String(input["symbol"] ?? "").trim();
        if (!symbol) return { content: "symbol is required", is_error: true };
        const def = findDefinition(ctx.repoRoot, symbol);
        if (!def) return { content: `(no declaration found for ${symbol})`, is_error: false };
        return {
          content: `${def.kind} | ${def.file}:${def.line}:${def.column} | ${def.context}`,
          is_error: false,
        };
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

/**
 * Slowcook-managed auto-generated artifacts that the agent should never
 * commit. These get regenerated by `slowcook map` / `slowcook recon` /
 * pre-commit hooks; the agent collateral-touching them (e.g. updating
 * `code-map.target.md` because its rationale included reading + updating
 * the slice) historically caused entire iterations to be rejected as
 * scope violations. We silently revert these instead.
 */
const AUTO_GENERATED_ARTIFACTS = [
  ".brewing/code-map.json",
  ".brewing/code-map.md",
  ".brewing/code-map.target.md",
  ".brewing/recon-result.json",
  ".brewing/history-index.json",
];

function pruneAutoGeneratedArtifacts(ctx: BrewContext): void {
  for (const path of AUTO_GENERATED_ARTIFACTS) {
    try {
      // If tracked + modified: revert to HEAD. If untracked: remove.
      const tracked = execSync(
        `git -C "${ctx.repoRoot}" ls-files --error-unmatch "${path}" 2>/dev/null || echo ""`,
        { encoding: "utf8" }
      ).trim();
      if (tracked) {
        execSync(`git -C "${ctx.repoRoot}" checkout HEAD -- "${path}" 2>/dev/null || true`, { stdio: "ignore" });
      } else {
        execSync(`rm -f "${ctx.repoRoot}/${path}"`, { stdio: "ignore" });
      }
    } catch {
      // best-effort; if pruning fails, the existing scope-violation path catches it
    }
  }
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
    const fresh = generateFullMap({
      repoRoot: ctx.repoRoot,
      slowcookVersion: ctx.cliVersion,
    });
    writeFreshMap(ctx.repoRoot, CODE_MAP_JSON_PATH, CODE_MAP_MD_PATH, fresh);
    appendRunLog(
      ctx,
      `CODEMAP regenerated (${when})  routes=${fresh.api_routes.length} components=${fresh.components.length} helpers=${fresh.helpers.length} types=${fresh.types.length}${fresh.contracts?.length ? ` contracts=${fresh.contracts.length}` : ""}`
    );
  } catch (e) {
    appendRunLog(ctx, `CODEMAP regenerate FAILED (${when}): ${(e as Error).message.slice(0, 200)}`);
  }
}

/**
 * Phase 2B (0.12.8+) — write a target-scoped slice of the code map to
 * `.brewing/code-map.target.md`. Called BEFORE every turn so the
 * agent's first read is the slice (cheap), not the full map.
 *
 * Scope derivation is intentionally cheap and approximate:
 *   1. mirror tests/X/Y/foo.test.ts → src/X/Y/ → keep entries whose
 *      file lives under that prefix (the "co-located src" intuition)
 *   2. tokenise the test file source → keep entries whose `name`
 *      appears in the test (the "what does the test reference?"
 *      intuition)
 *
 * The slice is the UNION of both. Empty scope falls through to the
 * full map (avoids surprising "empty slice" failures on early iters
 * before tests/ has been written, etc.). Best-effort — failures are
 * logged but never halt the brew.
 */
function regenerateTargetSlice(
  ctx: BrewContext,
  targetTestId: string,
  targetTestFile: string | null
): void {
  try {
    const jsonPath = join(ctx.repoRoot, CODE_MAP_JSON_PATH);
    if (!existsSync(jsonPath)) return;
    const map = JSON.parse(readFileSync(jsonPath, "utf8")) as CodeMap;
    const scope = deriveCodeMapScope(ctx.repoRoot, targetTestFile, map);
    const slice = sliceCodeMap(map, scope);
    const md = renderTargetSliceHeader(targetTestId, targetTestFile, scope, slice) + renderMarkdown(slice);
    const outPath = join(ctx.repoRoot, CODE_MAP_TARGET_MD_PATH);
    writeFileSync(outPath, md, "utf8");
    appendRunLog(
      ctx,
      `CODEMAP slice  scope_files=${scope.files?.size ?? 0} scope_names=${scope.names?.size ?? 0}  routes=${slice.api_routes.length} pages=${slice.pages.length} components=${slice.components.length} helpers=${slice.helpers.length} types=${slice.types.length}${slice.contracts?.length ? ` contracts=${slice.contracts.length}` : ""}`
    );
  } catch (e) {
    appendRunLog(ctx, `CODEMAP slice FAILED: ${(e as Error).message.slice(0, 200)}`);
  }
}

function deriveCodeMapScope(
  repoRoot: string,
  testFile: string | null,
  map: CodeMap
): { files: Set<string>; names: Set<string> } {
  const files = new Set<string>();
  const names = new Set<string>();
  if (!testFile) return { files, names };

  // Mirrored src dir: tests/X/Y/foo.test.ts → src/X/Y/ as a prefix.
  // Keep every entry whose file starts with that prefix.
  const mirrorPrefix = testFile
    .replace(/^tests\//, "src/")
    .replace(/\/[^/]+\.test\.tsx?$/, "/");
  const all: Array<{ file: string }> = [
    ...map.api_routes,
    ...map.pages,
    ...map.components,
    ...map.helpers,
    ...map.types,
  ];
  for (const entry of all) {
    if (entry.file.startsWith(mirrorPrefix)) files.add(entry.file);
  }

  // Names mentioned in the test file source — intersect with map names.
  // Cheap regex tokenisation, no parser. Catches imported identifiers,
  // bare references, JSX tags, and screen.getByText('Foo'). Ignored:
  // strings, comments — but we let those pass since the false-positive
  // cost is low (they just expand the slice slightly).
  const allNames = new Set<string>();
  for (const c of map.components) allNames.add(c.name);
  for (const h of map.helpers) allNames.add(h.name);
  for (const t of map.types) allNames.add(t.name);
  if (allNames.size > 0) {
    const fullPath = join(repoRoot, testFile);
    if (existsSync(fullPath)) {
      try {
        const src = readFileSync(fullPath, "utf8");
        const tokens = src.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
        for (const tok of tokens) {
          if (allNames.has(tok)) names.add(tok);
        }
      } catch {
        /* swallow — slice will still work via files alone */
      }
    }
  }

  return { files, names };
}

function renderTargetSliceHeader(
  targetTestId: string,
  testFile: string | null,
  scope: { files: Set<string>; names: Set<string> },
  slice: CodeMap
): string {
  const lines: string[] = [];
  lines.push(`<!-- Per-iter target slice. Regenerated by slowcook before every turn. -->`);
  lines.push("");
  lines.push(`> **Target:** \`${targetTestId}\``);
  if (testFile) lines.push(`> **Test file:** \`${testFile}\``);
  lines.push(
    `> **Scope:** ${scope.files.size} co-located file(s), ${scope.names.size} name match(es). ` +
      `Showing ${slice.api_routes.length + slice.pages.length + slice.components.length + slice.helpers.length + slice.types.length} entries.`
  );
  lines.push(`> Full map at \`${CODE_MAP_MD_PATH}\` if you need cross-cutting context.`);
  lines.push("");
  return lines.join("\n");
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
    // r4a dogfood — a compile failure in the agent's own code becomes N
    // failed tests carrying the compiler message (vitest semantics), never
    // a TEST_RUNNER_BROKEN halt that discards the feedback.
    expectedTestIds: ctx.manifestTestIds,
  } as Parameters<typeof runTests>[1]);
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
    case "find_references":
    case "find_definition":
      return pick(["symbol"]);
    case "find_implementations":
      return pick(["interface_or_base"]);
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

/** Fold one API response's usage into the run totals (dovizir §2 tail). */
function accumulateUsage(ctx: BrewContext, response: Anthropic.Messages.Message): void {
  const u = response.usage as
    | { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
    | undefined;
  const t = (ctx.usageTotals ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 });
  t.inputTokens += u?.input_tokens ?? 0;
  t.outputTokens += u?.output_tokens ?? 0;
  t.cacheReadTokens += u?.cache_read_input_tokens ?? 0;
  t.cacheCreateTokens += u?.cache_creation_input_tokens ?? 0;
}

/**
 * Write brew's spend to the canonical cost sidecar (dovizir §2 tail).
 *
 * brew is the most expensive stage and wrote NOTHING to the ledger, so
 * `slowcook cost` under-reported every story by the largest single line item.
 * Routed through `costEntryUsd` so an unpriced model lands as `null` (unknown)
 * rather than brew's own local silent-zero — and so `cost reprice` can settle
 * it later from the tokens recorded here.
 */
function recordBrewCost(ctx: BrewContext): void {
  const t = ctx.usageTotals;
  if (!t || (t.inputTokens === 0 && t.outputTokens === 0)) return;
  try {
    appendCostEntry(ctx.repoRoot, ctx.storyId, {
      agent: "brew",
      usd: costEntryUsd(ctx.model, t),
      model: ctx.model,
      at: new Date().toISOString(),
      tokens_in: t.inputTokens,
      tokens_out: t.outputTokens,
      cache_read: t.cacheReadTokens,
      cache_create: t.cacheCreateTokens,
    });
    applyCostToSpec(ctx.repoRoot, ctx.storyId);
  } catch { /* never fail a brew over its own bookkeeping */ }
}


/**
 * Cost for one API response — from the ONE canonical table (handover R1/R2).
 * brew's private copy (its own PRICING_PER_M_TOKENS + matchPricing, with its
 * own `if (!pricing) return 0`) is deleted: five copies existed, so fixing
 * only the shared one left the running system exactly as unsafe.
 */
function costUsdForResponse(
  response: Anthropic.Messages.Message,
  model: string
): number {
  const usage = response.usage as
    | { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
    | undefined;
  return costUsdForUsage(model, {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    cacheCreateTokens: usage?.cache_creation_input_tokens ?? 0,
  });
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
    // α.51 — surface brew runtime config so chef can give accurate PM
    // advice instead of hallucinating spec fields.
    brew_mode: ctx.mode,
    allowed_paths: ctx.allowedPaths,
    // α.57 — branch chef-on-brew-halt should checkout to see brew's
    // in-progress src/ checkpoints. Without this chef sees only main.
    brew_branch: ctx.branchName,
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

  // Post comment to the source issue if present.
  //
  // 0.12.13+ — this MUST be awaited. Previously fire-and-forget, the
  // process exited before the network round-trip completed, so the
  // halt report (containing the cost marker) never landed on the
  // issue and on-brew-merged's pipeline-cost rollup silently lost
  // brew's contribution. Symptom: rewo issue #124 / story-013 brew
  // halted with TRANSITIVE_REGRESSION, opened PR #134, but no brew
  // marker appeared on the source issue → "shipped" comment listed
  // only refine cost.
  const sourceIssue = ctx.spec.source_issue?.match(/#?(\d+)/)?.[1];
  if (sourceIssue) {
    try {
      await ctx.forge.createIssueComment(
        parseInt(sourceIssue, 10),
        haltReportToMarkdown(report)
      );
    } catch (e) {
      // Best-effort but logged (was silent before). If the comment
      // failed, the operator can still find the halt details in
      // .brewing/halts/.
      appendRunLog(
        ctx,
        `WARN  halt comment post failed: ${(e as Error).message.slice(0, 200)}`
      );
    }
  }

  return { kind: "halted", report };
}

/**
 * 0.16.0-α.30 — halt-envelope parser.
 *
 * The plate-mode prompt instructs the agent to halt by emitting an
 * XML envelope in its text output:
 *
 *   <halt class="MOCKUP_DESIGN_CONFLICT">
 *     <test>tests/integration/story-N-ui.test.tsx > "owner sees Pin"</test>
 *     <conflict>The test asserts X but the mock renders Y.</conflict>
 *     <recommendation>PM should /plate or /refine.</recommendation>
 *   </halt>
 *
 * Without this parser, brew never recognises its own agent's halt
 * envelopes. The agent's perfect classification gets converted to a
 * generic AGENT_STALLED_NO_EDITS halt because brew only counts tool
 * calls. Returns null when no envelope is found OR when the class
 * isn't in the recognised whitelist (defensive against typos).
 */
type HaltEnvelope = { class: HaltReason; summary: string };
const RECOGNISED_HALT_CLASSES: ReadonlySet<HaltReason> = new Set<HaltReason>([
  "MOCKUP_DESIGN_CONFLICT",
  "SPEC_AMBIGUITY_DETECTED",
  "TEST_RUNNER_BROKEN",
  "AGENT_SELF_REPORTED_STUCK",
]);

export function parseHaltEnvelope(rationale: string): HaltEnvelope | null {
  if (!rationale) return null;
  const m = rationale.match(/<halt\s+class\s*=\s*["']([A-Z_]+)["']\s*>([\s\S]*?)<\/halt>/);
  if (!m || !m[1] || !m[2]) return null;
  const cls = m[1] as HaltReason;
  if (!RECOGNISED_HALT_CLASSES.has(cls)) return null;
  const inner = m[2];
  // Prefer <conflict>; fall back to all text inside the envelope.
  const conflictMatch = inner.match(/<conflict>([\s\S]*?)<\/conflict>/);
  const raw = conflictMatch && conflictMatch[1]
    ? conflictMatch[1]
    : inner.replace(/<[^>]+>/g, " ");
  const summary = raw.replace(/\s+/g, " ").trim().slice(0, 800);
  return { class: cls, summary };
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
