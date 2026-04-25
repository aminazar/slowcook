/**
 * `slowcook sift --bug B-N` — bug-flow brew analogue.
 *
 * Reads a bug-profile + the regression test, runs an LLM ratchet to
 * make the regression go green, halts when:
 *  - regression test passes (green = success)
 *  - budget cap hit
 *  - max iterations hit
 *  - agent halts voluntarily
 *
 * Usage:
 *   slowcook sift --bug B-1 [--cwd <path>] [--model <id>]
 *                          [--max-iterations <n>] [--budget-usd <n>]
 *                          [--dry-run]
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runSift, type SiftContext } from "./agent.js";
import { loadBugProfile } from "../recipe-regression/index.js";
import { validateStackConfig, type StackConfig } from "@slowcook-ai/stack-ts";

interface SiftArgs {
  bugId: string;
  repoRoot: string;
  model: string;
  maxIterations: number;
  budgetUsd: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): SiftArgs {
  const args: SiftArgs = {
    bugId: "",
    repoRoot: process.cwd(),
    model: "claude-sonnet-4-6", // Sift defaults to Sonnet — narrow fixes shouldn't need Opus.
    maxIterations: 3,
    budgetUsd: 0.5,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--bug" && next) {
      args.bugId = normaliseBugId(next);
      i++;
    } else if (arg === "--cwd" && next) {
      args.repoRoot = next;
      i++;
    } else if (arg === "--model" && next) {
      args.model = next;
      i++;
    } else if ((arg === "--max-iterations" || arg === "--iters") && next) {
      args.maxIterations = parseInt(next, 10);
      i++;
    } else if (arg === "--budget-usd" && next) {
      args.budgetUsd = parseFloat(next);
      i++;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function normaliseBugId(raw: string): string {
  const m = raw.trim().match(/^B?-?(\d+)$/i);
  if (!m || !m[1]) return raw;
  return `B-${m[1]}`;
}

function printHelp(): void {
  console.log(`
slowcook sift — narrow red→green ratchet for a bug fix

Reads .brewing/bug-profiles/B-N.yaml + the matching regression test
under tests/regression/B-N-*.test.ts, runs an LLM agent in a tight
loop to flip the regression to green with minimum-diff edits scoped
to the bug profile's fix_scope.

Usage:
  slowcook sift --bug B-1 [options]

Options:
  --bug <id>             Bug id (B-N or just N).
  --cwd <path>           Repo root (default: cwd).
  --model <id>           LLM model (default: claude-sonnet-4-6).
  --max-iterations <n>   Max iterations (default: 3).
  --budget-usd <n>       Spend cap in USD (default: 0.5).
  --dry-run              Print plan + exit; don't make LLM calls.

Environment:
  ANTHROPIC_API_KEY (required unless --dry-run)
  GITHUB_TOKEN      (optional; not used by sift directly today)

Exit codes:
  0  regression went green
  1  halted (budget / iters / voluntary halt / no-progress)
  2  setup error (missing profile / regression test / stack config)
`);
}

export async function sift(argv: string[], cliVersion: string): Promise<void> {
  const args = parseArgs(argv);
  if (!args.bugId) {
    console.error("slowcook sift: --bug <id> is required");
    printHelp();
    process.exit(64);
  }

  // Load bug profile + regression test + stack config.
  let bugProfile;
  try {
    bugProfile = loadBugProfile(args.repoRoot, args.bugId);
  } catch (e) {
    console.error(`slowcook sift: ${(e as Error).message}`);
    process.exit(2);
  }

  const regressionTestPath = findRegressionTestForBug(args.repoRoot, args.bugId);
  if (!regressionTestPath) {
    console.error(
      `slowcook sift: no regression test found at tests/regression/${args.bugId}-*.test.ts. ` +
        `Run 'slowcook recipe --regression --bug ${args.bugId}' first.`
    );
    process.exit(2);
  }
  const regressionTestSrc = readFileSync(
    join(args.repoRoot, regressionTestPath),
    "utf8"
  );

  let stackConfig: StackConfig;
  try {
    const raw = JSON.parse(
      readFileSync(join(args.repoRoot, ".brewing/stack.json"), "utf8")
    );
    stackConfig = validateStackConfig(raw);
  } catch (e) {
    console.error(`slowcook sift: stack.json missing or invalid: ${(e as Error).message}`);
    process.exit(2);
  }

  console.error(
    `slowcook sift (${cliVersion}) — ${args.bugId}, model ${args.model}, max ${args.maxIterations} iter, budget $${args.budgetUsd.toFixed(2)}.`
  );
  console.error(`  bug profile : .brewing/bug-profiles/${args.bugId}.yaml`);
  console.error(`  regression  : ${regressionTestPath}`);
  console.error(`  fix_scope   : ${bugProfile.fix_scope.join(", ")}`);

  if (args.dryRun) {
    console.error("\n(dry-run: would invoke runSift; not making LLM calls)");
    process.exit(0);
  }

  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    console.error("slowcook sift: ANTHROPIC_API_KEY is required");
    process.exit(78);
  }

  const ctx: SiftContext = {
    repoRoot: args.repoRoot,
    anthropicApiKey: apiKey,
    model: args.model,
    bugProfile,
    regressionTestPath,
    regressionTestSrc,
    stackConfig,
    maxIterations: args.maxIterations,
    budgetUsd: args.budgetUsd,
  };

  const result = await runSift(ctx);

  console.error("");
  if (result.green) {
    console.error(
      `✓ Sift succeeded — regression green after ${result.iterations} iter(s), $${result.spendUsd.toFixed(4)} spent.`
    );
    console.error(`  Files touched: ${result.filesTouched.join(", ") || "(none)"}`);
    process.exit(0);
  } else {
    console.error(
      `✗ Sift halted: ${result.haltReason}. ${result.iterations} iter(s), $${result.spendUsd.toFixed(4)} spent.`
    );
    if (result.filesTouched.length > 0) {
      console.error(`  Files touched: ${result.filesTouched.join(", ")}`);
    }
    process.exit(1);
  }
}

/**
 * Find the regression test file for a bug. Looks for
 * `tests/regression/B-N-<slug>.test.ts` (matching what
 * recipe --regression emits).
 */
export function findRegressionTestForBug(
  repoRoot: string,
  bugId: string
): string | null {
  const dir = join(repoRoot, "tests/regression");
  if (!existsSync(dir)) return null;
  const prefix = `${bugId}-`;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(prefix) && entry.endsWith(".test.ts")) {
      return `tests/regression/${entry}`;
    }
  }
  return null;
}
