import { execSync } from "node:child_process";
import { GitHubAdapter } from "@slowcook-ai/forge-github";
import { detectPipelineState, formatReport } from "./detect.js";
import { onSpecMerged } from "../on-spec-merged/index.js";
import { testgen } from "../testgen/index.js";

interface CatchupArgs {
  dryRun: boolean;
  repoRoot: string;
  owner?: string;
  repo?: string;
  baseBranch: string;
}

function parseArgs(argv: string[]): CatchupArgs {
  const args: CatchupArgs = {
    dryRun: false,
    repoRoot: process.cwd(),
    baseBranch: "main",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--cwd" && next) { args.repoRoot = next; i++; }
    else if (arg === "--owner" && next) { args.owner = next; i++; }
    else if (arg === "--repo" && next) { args.repo = next; i++; }
    else if (arg === "--base" && next) { args.baseBranch = next; i++; }
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook catchup — detect and run pipeline steps that should have triggered

Scans the repo for "missed triggers" — state that's out of sync with what
the pipeline should have produced — and runs the corresponding commands
to bring everything back in sync. Useful after:

  - a workflow run failed and the state machine stalled
  - secrets were added/rotated (prior pushes didn't have auth)
  - a permission toggle changed (prior pushes got 403)
  - you manually merged something outside the automated flow

Three categories detected:

  1. Pending refinements — issues with \`needs-refinement\` label
     (surfaced only; re-triggering needs the PM to bounce the label)
  2. Pending on-spec-merged — spec PRs that merged but whose source
     issue still has \`spec-submitted\` (auto-run)
  3. Pending testgen — active specs without corresponding
     \`tests/integration/story-N.test.ts\` (auto-run)

Usage:
  slowcook catchup [options]

Options:
  --dry-run        Print the report; don't run any commands
  --cwd <path>     Repo working directory (default: .)
  --owner <login>  Repo owner (default: from git remote)
  --repo <name>    Repo name (default: from git remote)
  --base <branch>  Base branch for PRs (default: main)
  --help, -h       Show this help

Environment:
  GITHUB_TOKEN       (required)  GitHub token with issues + PR + contents write
  ANTHROPIC_API_KEY  (required if any testgen is pending)

Exit codes:
  0   report printed (dry-run) or all pending actions executed
  2   script error
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

export async function catchup(argv: string[], cliVersion: string): Promise<void> {
  const args = parseArgs(argv);

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

  console.log(`slowcook catchup · scanning ${owner}/${repo}...\n`);
  const state = await detectPipelineState(forge, args.repoRoot);
  console.log(formatReport(state));

  if (args.dryRun) {
    console.log("\n(dry-run — no actions taken)");
    return;
  }

  const autoPending =
    state.pendingOnSpecMerged.length + state.pendingTestgen.length;
  if (autoPending === 0) {
    console.log("\nNothing to do — auto-pending queues are empty.");
    return;
  }

  console.log(`\n=== Executing auto-pending actions ===\n`);

  // Phase 1: on-spec-merged (may shift issue state that testgen watches)
  for (const p of state.pendingOnSpecMerged) {
    console.log(`\n--- on-spec-merged for PR #${p.prNumber} (story-${p.storyId}) ---`);
    try {
      await onSpecMerged(["--pr", String(p.prNumber), "--cwd", args.repoRoot]);
    } catch (e) {
      console.error(`  failed: ${(e as Error).message}`);
    }
  }

  // Phase 2: testgen for any still-pending specs
  if (state.pendingTestgen.length > 0) {
    const anthropicKey = process.env["ANTHROPIC_API_KEY"];
    if (!anthropicKey) {
      console.error(
        "\nANTHROPIC_API_KEY is required to run testgen. Skipping the testgen phase."
      );
      return;
    }
    console.log(`\n--- testgen --all (${state.pendingTestgen.length} spec(s) need tests) ---`);
    try {
      await testgen(["--all", "--cwd", args.repoRoot, "--base", args.baseBranch], cliVersion);
    } catch (e) {
      console.error(`  testgen failed: ${(e as Error).message}`);
    }
  }

  console.log("\ncatchup done.");
}
