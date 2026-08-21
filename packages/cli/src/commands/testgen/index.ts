import { execSync } from "node:child_process";
import { GitHubAdapter } from "@slowcook-ai/forge-github";
import { createLlmClient } from "../refine/llm.js";
import { runTestgen, type TestgenContext } from "./agent.js";
import { resolveModel } from "../../lib/model-defaults.js";
import { requireTsStack } from "../../lib/stack-support.js";

interface TestgenArgs {
  specId: string | null;
  /** PR-driven resubmit (G10): answer reviews on an existing tests PR. */
  prNumber: number | null;
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
    prNumber: null,
    all: false,
    repoRoot: process.cwd(),
    baseBranch: "main",
    model: resolveModel("testgen"),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--spec" && next) {
      args.specId = normalizeSpecId(next);
      i++;
    } else if (arg === "--pr" && next) {
      args.prNumber = parseInt(next, 10);
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
  if (!args.specId && !args.prNumber) args.all = true;
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
  ANTHROPIC_API_KEY   Anthropic API key — or SLOWCOOK_LLM=claude-cli for the
                      local claude CLI's subscription auth (key-less)
  GITHUB_TOKEN        (required)  GitHub token with contents/pull-requests write

Exit codes:
  0   outcome reached (PR opened, or nothing to generate)
  2   script error (bad args, missing env, network failure)
`);
}

/**
 * Accept `--spec 005`, `--spec story-005`, or `--spec Story-005` and return
 * the bare id (`005`). Upstream `readSpec` / `handlerTestPathFor` prepend
 * `story-` themselves, so passing the prefixed form silently mismatches
 * everything and testgen no-ops. Normalising at the arg boundary means the
 * operator's mental model ("story-005") matches the file on disk without a
 * trap between the two. See docs/plans/0.7.17-pipeline-gap-assertions.md §2a.
 */
export function normalizeSpecId(raw: string): string {
  return raw.replace(/^story-/i, "");
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
  // dovizir §8 — refuse rather than emit vitest files a forge/pytest runner
  // can never discover. Honest v1 until testgen becomes stack-dispatched.
  requireTsStack("testgen", args.repoRoot);

  // sc#233 — the LLM runtime is environment-decided: ANTHROPIC_API_KEY (API)
  // or SLOWCOOK_LLM=claude-cli (key-less, Claude Code subscription auth).
  let llm;
  try {
    llm = await createLlmClient();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
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

  // Discovery certifies the COMMITTED artifact — refuse to let worktree
  // residue under src|tests make it lie (ledger G20).
  const { assertDiscoveryHygiene } = await import("../../lib/discovery-hygiene.js");
  assertDiscoveryHygiene(args.repoRoot);

  // PR-driven resubmit: answer reviews on an existing tests PR (G10).
  if (args.prNumber) {
    const { runTestsResubmit } = await import("./resubmit.js");
    await runTestsResubmit({
      prNumber: args.prNumber,
      repoRoot: args.repoRoot,
      owner,
      repo,
      token: githubToken,
      llm,
      model: args.model,
    });
    return;
  }

  const forge = new GitHubAdapter({ owner, repo, token: githubToken });

  const branchName = args.specId
    ? `slowcook/tests/story-${args.specId}`
    : `slowcook/tests/batch-${Date.now()}`;

  // G18: a regeneration must not trip over the previous round's fossil.
  // The PR is the authority: a local branch with an OPEN PR belongs to
  // resubmit (`recipe --pr N`), never to a fresh run; without an open PR
  // the branch is a fossil of a merged/closed round — delete it (and any
  // stale remote copy) so the fresh branch starts from base.
  if (args.specId) {
    const localExists = (() => {
      try {
        execSync(`git rev-parse --verify --quiet refs/heads/${branchName}`, {
          cwd: args.repoRoot,
          stdio: ["ignore", "ignore", "ignore"],
        });
        return true;
      } catch {
        return false;
      }
    })();
    if (localExists) {
      const { Octokit } = await import("@octokit/rest");
      const octokit = new Octokit({ auth: githubToken, userAgent: "slowcook-ai/cli testgen" });
      const { data: openPrs } = await octokit.pulls.list({
        owner,
        repo,
        state: "open",
        head: `${owner}:${branchName}`,
        per_page: 1,
      });
      if (openPrs.length > 0) {
        console.error(
          `testgen: branch ${branchName} has open PR #${openPrs[0]!.number} — use \`slowcook recipe --pr ${openPrs[0]!.number}\` to amend it instead of regenerating.`
        );
        process.exit(2);
      }
      execSync(`git branch -D ${branchName}`, { cwd: args.repoRoot, stdio: ["ignore", "ignore", "ignore"] });
      try {
        execSync(`git push origin --delete ${branchName}`, {
          cwd: args.repoRoot,
          stdio: ["ignore", "ignore", "ignore"],
        });
      } catch {
        /* no stale remote — fine */
      }
      console.log(`testgen: cleared fossil branch ${branchName} (its PR is merged/closed).`);
    }
  }

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
