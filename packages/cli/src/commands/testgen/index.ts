import { execSync } from "node:child_process";
import { GitHubAdapter } from "@slowcook-ai/forge-github";
import { AnthropicClient } from "../refine/llm.js";
import { runTestgen, type TestgenContext } from "./agent.js";

interface TestgenArgs {
  specId: string | null;
  all: boolean;
  repoRoot: string;
  owner?: string;
  repo?: string;
  baseBranch: string;
  model: string;
}

function parseArgs(argv: string[]): TestgenArgs {
  const args: TestgenArgs = {
    specId: null,
    all: false,
    repoRoot: process.cwd(),
    baseBranch: "main",
    model: "claude-opus-4-7",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--spec" && next) {
      args.specId = next;
      i++;
    } else if (arg === "--all") {
      args.all = true;
    } else if (arg === "--cwd" && next) {
      args.repoRoot = next;
      i++;
    } else if (arg === "--owner" && next) {
      args.owner = next;
      i++;
    } else if (arg === "--repo" && next) {
      args.repo = next;
      i++;
    } else if (arg === "--base" && next) {
      args.baseBranch = next;
      i++;
    } else if (arg === "--model" && next) {
      args.model = next;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  // Default: operate on all active specs lacking tests
  if (!args.specId) args.all = true;
  return args;
}

function printHelp(): void {
  console.log(`
slowcook testgen — generate Vitest integration tests from merged specs

Runs over active specs that lack test files and produces a single draft PR
containing:
  - tests/integration/story-N.test.ts  (Vitest, HTTP-style integration)
  - .brewing/manifests/story-N.json    (the frozen test manifest for N)

If any spec has \`supersedes: [X, Y]\`, the old tests/manifests for X and Y
are removed in the same PR; \`override-freeze\` is auto-applied because the
supersede chain in the spec provides the audit trail.

Usage:
  slowcook testgen [--spec <id>] [--all] [options]

Options:
  --spec <id>      Generate tests for a specific story id (re-runs even if
                   tests exist).
  --all            Generate tests for every active spec that lacks them.
                   (Default when --spec is not set.)
  --cwd <path>     Repo working directory (default: .)
  --owner <login>  Repo owner (default: from \`git remote get-url origin\`)
  --repo <name>    Repo name (default: from \`git remote get-url origin\`)
  --base <branch>  Base branch for the tests PR (default: main)
  --model <id>     LLM model (default: claude-opus-4-7)
  --help, -h       Show this help

Environment:
  ANTHROPIC_API_KEY   (required)  Anthropic API key
  GITHUB_TOKEN        (required)  GitHub token with contents/pull-requests write

Exit codes:
  0   outcome reached (PR opened, or nothing to generate)
  2   script error (bad args, missing env, network failure)
`);
}

function detectOwnerRepo(cwd: string): { owner: string; repo: string } | null {
  try {
    const url = execSync("git remote get-url origin", {
      cwd,
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

export async function testgen(argv: string[], cliVersion: string): Promise<void> {
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
      console.error(
        "Could not detect owner/repo from git remote. Pass --owner and --repo explicitly."
      );
      process.exit(2);
    }
    owner = owner ?? detected.owner;
    repo = repo ?? detected.repo;
  }

  const forge = new GitHubAdapter({ owner, repo, token: githubToken });
  const llm = new AnthropicClient(anthropicKey);

  const branchName = args.specId
    ? `slowcook/tests/story-${args.specId}`
    : `slowcook/tests/batch-${Date.now()}`;

  const ctx: TestgenContext = {
    repoRoot: args.repoRoot,
    forge,
    llm,
    model: args.model,
    cliVersion,
    baseBranch: args.baseBranch,
    all: args.all,
    specId: args.specId,
    branchName,
    now: new Date(),
  };

  console.log(
    `slowcook testgen · ${args.specId ? `story-${args.specId}` : "all active specs"} on ${owner}/${repo}`
  );

  try {
    const outcome = await runTestgen(ctx);
    switch (outcome.kind) {
      case "tests-emitted":
        console.log(
          `Tests written for ${outcome.storyIds.map((s) => `story-${s}`).join(", ")}`
        );
        if (outcome.removedStoryIds.length > 0) {
          console.log(
            `Removed superseded tests: ${outcome.removedStoryIds.map((s) => `story-${s}`).join(", ")}`
          );
        }
        console.log(`Draft PR: ${outcome.prUrl}`);
        break;
      case "nothing-to-generate":
        console.log(`Noop: ${outcome.reason}.`);
        break;
      case "pr-creation-blocked":
        console.log(
          `Tests committed and pushed to branch '${outcome.branchName}', but PR creation was blocked (403). Enable "Allow GitHub Actions to create and approve pull requests" and re-run, or open the PR manually.`
        );
        process.exit(2);
    }
  } catch (e) {
    console.error(`testgen failed: ${(e as Error).message}`);
    if (process.env["SLOWCOOK_DEBUG"]) {
      console.error(e);
    }
    process.exit(2);
  }
}
