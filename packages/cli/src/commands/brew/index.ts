import { execSync } from "node:child_process";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { GitHubAdapter } from "@slowcook-ai/forge-github";
import {
  runBrew,
  readFrozenPaths,
  readStackConfig,
  loadSpec,
  type BrewContext,
} from "./agent.js";
import { haltReportToMarkdown } from "./halt.js";

interface BrewArgs {
  storyId: string;
  repoRoot: string;
  owner?: string;
  repo?: string;
  budgetUsd: number;
  maxIterations: number;
  wallClockMs: number;
  model: string;
  baseBranch: string;
}

function parseArgs(argv: string[]): BrewArgs {
  const args: BrewArgs = {
    storyId: "",
    repoRoot: process.cwd(),
    budgetUsd: 10,
    maxIterations: 10,
    wallClockMs: 60 * 60 * 1000, // 1 hour
    model: "claude-sonnet-4-6",
    baseBranch: "main",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--story" && next) { args.storyId = next; i++; }
    else if (arg === "--cwd" && next) { args.repoRoot = next; i++; }
    else if (arg === "--owner" && next) { args.owner = next; i++; }
    else if (arg === "--repo" && next) { args.repo = next; i++; }
    else if (arg === "--budget-usd" && next) { args.budgetUsd = parseFloat(next); i++; }
    else if (arg === "--max-iterations" && next) { args.maxIterations = parseInt(next, 10); i++; }
    else if (arg === "--wall-clock-minutes" && next) { args.wallClockMs = parseInt(next, 10) * 60 * 1000; i++; }
    else if (arg === "--model" && next) { args.model = next; i++; }
    else if (arg === "--base" && next) { args.baseBranch = next; i++; }
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (!args.storyId) {
    console.error("Missing required --story <id>");
    printHelp();
    process.exit(64);
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook brew — run the ratcheted implementation loop for one story

Reads the story's spec + test manifest, then iterates: agent proposes a
diff, slowcook runs tests, reverts regressions or no-progress turns,
commits only when a red test flips to green. Halts when budget or
iteration cap is hit, or when all story tests are green.

Usage:
  slowcook brew --story <id> [options]

Options:
  --story <id>               Story id to brew (required)
  --cwd <path>               Repo working directory (default: .)
  --owner <login>            Repo owner (default: from git remote)
  --repo <name>              Repo name (default: from git remote)
  --budget-usd <n>           Token-spend cap per story (default: 10)
  --max-iterations <n>       Iteration cap (default: 10)
  --wall-clock-minutes <n>   Wall-clock cap in minutes (default: 60)
  --model <id>               LLM model (default: claude-sonnet-4-6; override with --model claude-opus-4-7 for harder stories)
  --base <branch>            Base branch for PRs (default: main)
  --help, -h                 Show this help

Environment:
  ANTHROPIC_API_KEY   (required)
  GITHUB_TOKEN        (required)

Exit codes:
  0   success (all story tests green, branch pushed)
  1   halted (budget, iterations, stagnation, wall-clock, etc.) — see halt report
  2   script error (missing env, bad args, etc.)
`);
}

function detectOwnerRepo(cwd: string): { owner: string; repo: string } | null {
  try {
    const url = execSync("git remote get-url origin", {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (m && m[1] && m[2]) return { owner: m[1], repo: m[2] };
  } catch { /* not a git repo */ }
  return null;
}

export async function brew(argv: string[], cliVersion: string): Promise<void> {
  void cliVersion;
  const args = parseArgs(argv);

  const anthropicKey = process.env["ANTHROPIC_API_KEY"];
  if (!anthropicKey) {
    console.error("ANTHROPIC_API_KEY environment variable is not set.");
    process.exit(2);
  }
  const githubToken = process.env["GITHUB_TOKEN"];
  if (!githubToken) {
    console.error("GITHUB_TOKEN environment variable is not set.");
    process.exit(2);
  }

  let owner = args.owner;
  let repo = args.repo;
  if (!owner || !repo) {
    const detected = detectOwnerRepo(args.repoRoot);
    if (!detected) {
      console.error("Could not detect owner/repo from git remote. Pass --owner and --repo.");
      process.exit(2);
    }
    owner = owner ?? detected.owner;
    repo = repo ?? detected.repo;
  }

  const spec = loadSpec(args.repoRoot, args.storyId);
  const stackConfig = readStackConfig(args.repoRoot);
  const frozenPaths = readFrozenPaths(args.repoRoot);

  // Allowed paths: honour spec's `api_contract` paths if declared; else empty (wide).
  // For 0.6, we don't strictly parse allowed_paths from the spec — it's a future field.
  // Treat absence as "anywhere outside frozen is fine" (allowedPaths=[]).
  const allowedPaths: string[] = [];

  const forge = new GitHubAdapter({ owner, repo, token: githubToken });
  const anthropic = new Anthropic({ apiKey: anthropicKey });

  const startedAt = new Date();
  const runTag = startedAt.toISOString().replace(/[:.]/g, "-");
  const branchName = `slowcook/brew/story-${args.storyId}-${startedAt.getTime()}`;
  const haltDir = join(args.repoRoot, ".brewing/halts");
  // Rolling per-iteration log. Operator can `ssh runner; tail -f` this
  // during long brews to see progress without waiting for CI log flush.
  const runLogPath = join(
    args.repoRoot,
    ".brewing/runs",
    `story-${args.storyId}-${runTag}`,
    "iterations.log"
  );

  // Create branch before starting
  execSync(`git -C "${args.repoRoot}" checkout -b ${branchName}`, { stdio: "inherit" });

  console.log(`\nslowcook brew · story-${args.storyId} on ${owner}/${repo}`);
  console.log(`  budget: $${args.budgetUsd.toFixed(2)} · iterations: ${args.maxIterations} · model: ${args.model}`);
  console.log(`  branch: ${branchName}`);
  console.log(`  run log: ${runLogPath}\n`);

  const ctx: BrewContext = {
    repoRoot: args.repoRoot,
    storyId: args.storyId,
    spec,
    stackConfig,
    forge,
    anthropic,
    model: args.model,
    budgetUsd: args.budgetUsd,
    maxIterations: args.maxIterations,
    wallClockMs: args.wallClockMs,
    now: () => new Date(),
    branchName,
    allowedPaths,
    frozenPaths,
    haltDir,
    runLogPath,
  };

  try {
    const outcome = await runBrew(ctx);
    if (outcome.kind === "success") {
      console.log(
        `\n✓ All story tests green after ${outcome.iterations} iteration(s). ` +
        `${outcome.checkpoints} checkpoint(s), $${outcome.spendUsd.toFixed(2)} spent.`
      );
      console.log(`Branch pushed: ${branchName}`);
      process.exit(0);
    } else {
      console.log(`\n✗ Halted: ${outcome.report.halt_reason}`);
      console.log(haltReportToMarkdown(outcome.report));
      process.exit(1);
    }
  } catch (e) {
    console.error(`brew failed: ${(e as Error).message}`);
    if (process.env["SLOWCOOK_DEBUG"]) console.error(e);
    process.exit(2);
  }
}
