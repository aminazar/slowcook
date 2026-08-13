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
import { execSync } from "node:child_process";
import { GitHubAdapter } from "@slowcook-ai/forge-github";
import { runSift, type SiftContext, type SiftResult } from "./agent.js";
import { loadBugProfile } from "../recipe-regression/index.js";
import { validateStackConfig, type StackConfig } from "@slowcook-ai/stack-ts";
import type { BugProfile } from "../investigate/schema.js";
import { requireApiKey } from "../../lib/llm-runtime.js";
import { resolveModel } from "../../lib/model-defaults.js";

interface SiftArgs {
  bugId: string;
  repoRoot: string;
  model: string;
  maxIterations: number;
  budgetUsd: number;
  dryRun: boolean;
  /** Skip PR opening; leave the diff on a local branch only. */
  noPr: boolean;
  owner?: string;
  repo?: string;
}

function parseArgs(argv: string[]): SiftArgs {
  const args: SiftArgs = {
    bugId: "",
    repoRoot: process.cwd(),
    model: resolveModel("sift"), // Sift stays on the cheaper tier — narrow fixes.
    maxIterations: 3,
    budgetUsd: 0.5,
    dryRun: false,
    noPr: false,
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
    } else if (arg === "--no-pr") {
      args.noPr = true;
    } else if (arg === "--owner" && next) {
      args.owner = next;
      i++;
    } else if (arg === "--repo" && next) {
      args.repo = next;
      i++;
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
  --model <id>           LLM model (default: the sift stage model).
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

  const apiKey = requireApiKey("sift");

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

  const branchName = `slowcook/sift/${args.bugId}-${Date.now()}`;
  // Create the branch BEFORE the agent edits so the diff lands on
  // the sift branch, not on whatever branch was checked out.
  try {
    execSync(`git -C "${args.repoRoot}" checkout -b ${branchName}`, {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    console.error(
      `slowcook sift: could not create branch ${branchName}: ${(e as Error).message}`
    );
    process.exit(2);
  }

  const result = await runSift(ctx);

  console.error("");
  if (result.green) {
    console.error(
      `✓ Sift succeeded — regression green after ${result.iterations} iter(s), $${result.spendUsd.toFixed(4)} spent.`
    );
    console.error(`  Files touched: ${result.filesTouched.join(", ") || "(none)"}`);
  } else {
    console.error(
      `✗ Sift halted: ${result.haltReason}. ${result.iterations} iter(s), $${result.spendUsd.toFixed(4)} spent.`
    );
    if (result.filesTouched.length > 0) {
      console.error(`  Files touched: ${result.filesTouched.join(", ")}`);
    }
  }

  // Commit + push + open PR even on halt — the operator wants to see
  // partial progress when sift halts mid-fix. Skipped only on
  // --no-pr or when no files were edited.
  if (args.noPr) {
    console.error(`(--no-pr: branch ${branchName} kept locally; commit/push/PR skipped.)`);
    process.exit(result.green ? 0 : 1);
  }
  if (result.filesTouched.length === 0) {
    console.error(`(no files edited; nothing to push.)`);
    process.exit(result.green ? 0 : 1);
  }

  await openSiftPr({
    repoRoot: args.repoRoot,
    bugId: args.bugId,
    branchName,
    profile: bugProfile,
    result,
    owner: args.owner,
    repo: args.repo,
    cliVersion,
  });
  process.exit(result.green ? 0 : 1);
}

interface OpenSiftPrArgs {
  repoRoot: string;
  bugId: string;
  branchName: string;
  profile: BugProfile;
  result: SiftResult;
  owner?: string;
  repo?: string;
  cliVersion: string;
}

async function openSiftPr(args: OpenSiftPrArgs): Promise<void> {
  const githubToken = process.env["GITHUB_TOKEN"];
  if (!githubToken) {
    console.error(
      `GITHUB_TOKEN not set — branch ${args.branchName} kept locally with edits but PR not opened.`
    );
    return;
  }
  const detected = detectOwnerRepo(args.repoRoot);
  const owner = args.owner ?? detected?.owner;
  const repo = args.repo ?? detected?.repo;
  if (!owner || !repo) {
    console.error("Could not detect owner/repo from git remote — pass --owner + --repo to open the PR.");
    return;
  }

  const forge = new GitHubAdapter({ owner, repo, token: githubToken });

  try {
    // Stage all touched files + commit + push.
    for (const f of args.result.filesTouched) {
      await forge.git.stage(f);
    }
    await forge.git.commit(
      `slowcook sift ${args.result.green ? "✓" : "(partial)"} ${args.bugId}: ${args.result.iterations} iter(s) · $${args.result.spendUsd.toFixed(2)}`
    );
    await forge.git.push(args.branchName);
  } catch (e) {
    console.error(
      `Push failed: ${(e as Error).message}. Branch is local; commit/push manually.`
    );
    return;
  }

  try {
    const titlePrefix = args.result.green ? "sift ✓" : "sift (partial)";
    const pr = await forge.createPullRequest({
      title: `${titlePrefix} ${args.bugId}: ${args.profile.title}`,
      body: buildSiftPrBody(args),
      base: "main",
      head: args.branchName,
      draft: !args.result.green,
      labels: ["slowcook-sift", "bug"],
    });
    console.error(`Opened PR ${pr.url}.`);
  } catch (e) {
    console.error(
      `Pushed branch ${args.branchName} but PR open failed: ${(e as Error).message}\n  Open manually at https://github.com/${owner}/${repo}/pull/new/${args.branchName}`
    );
  }
}

function detectOwnerRepo(repoRoot: string): { owner: string; repo: string } | null {
  try {
    const url = execSync("git remote get-url origin", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (m && m[1] && m[2]) return { owner: m[1], repo: m[2] };
  } catch {
    /* not a git repo */
  }
  return null;
}

function buildSiftPrBody(args: OpenSiftPrArgs): string {
  const lines: string[] = [];
  lines.push(
    `Auto-emitted by \`slowcook sift\` (${args.cliVersion}) for bug profile \`${args.bugId}\`.`
  );
  lines.push("");
  lines.push(`Closes related: ${args.profile.source_issue}`);
  lines.push("");
  lines.push("## Result");
  lines.push(
    `- **${args.result.green ? "Regression GREEN" : "Halted: " + (args.result.haltReason ?? "(unknown)")}**`
  );
  lines.push(`- Iterations: ${args.result.iterations}`);
  lines.push(`- Spend: $${args.result.spendUsd.toFixed(4)}`);
  lines.push(
    `- Files: ${args.result.filesTouched.map((f) => "`" + f + "`").join(", ") || "(none)"}`
  );
  lines.push("");
  lines.push("## Bug profile (summary)");
  lines.push(`**Symptom:** ${args.profile.symptom.join(" / ")}`);
  lines.push("");
  lines.push(`**Failure locus:** \`${args.profile.failure_locus.file}\`${args.profile.failure_locus.line ? `:${args.profile.failure_locus.line}` : ""}`);
  lines.push(`> ${args.profile.failure_locus.diagnosis.split("\n").join("\n> ")}`);
  lines.push("");
  lines.push("## Verification");
  lines.push(
    `Sift's ratchet ran the regression test (\`tests/regression/${args.bugId}-*.test.ts\`) after each iteration; ` +
      `it ${args.result.green ? "passed on iteration " + args.result.iterations : "remained red — see haltReason"}.`
  );
  return lines.join("\n");
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
