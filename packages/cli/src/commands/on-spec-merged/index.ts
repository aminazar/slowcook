import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { Octokit } from "@octokit/rest";

/**
 * Called from a workflow that fires on `pull_request.closed` with
 * `merged == true` and the `slowcook-spec` label. Finds the spec file(s)
 * added by the merged PR, extracts each spec's `source_issue`, and
 * transitions that issue's label from `spec-submitted` to `spec-ready`.
 *
 * Idempotent: safe to re-run. Missing labels are silently skipped (404s
 * tolerated).
 */

interface Args {
  prNumber: number;
  repoRoot: string;
  owner?: string;
  repo?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    prNumber: 0,
    repoRoot: process.cwd(),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--pr" && next) {
      args.prNumber = parseInt(next, 10);
      i++;
    } else if (arg === "--cwd" && next) {
      args.repoRoot = next;
      i++;
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
  if (!args.prNumber || isNaN(args.prNumber)) {
    console.error("Missing required --pr <number>");
    printHelp();
    process.exit(64);
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook on-spec-merged — transition source-issue labels after a spec PR merges

Typically called from a GitHub Actions workflow listening for
pull_request.closed events on PRs labeled 'slowcook-spec'. Finds the spec
files in the merged PR, reads each spec's source_issue, and transitions
that issue's label from 'spec-submitted' to 'spec-ready'.

Usage:
  slowcook on-spec-merged --pr <number> [options]

Options:
  --pr <number>    PR number (required)
  --cwd <path>     Repo working directory (default: .)
  --owner <login>  Repo owner (default: detected from git remote)
  --repo <name>    Repo name (default: detected from git remote)
  --help, -h       Show this help

Environment:
  GITHUB_TOKEN  (required)  Token with issues:write + pull-requests:read

Exit codes:
  0   transitions applied (or nothing to do)
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
    /* ignore */
  }
  return null;
}

export async function onSpecMerged(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  const token = process.env["GITHUB_TOKEN"];
  if (!token) {
    console.error("GITHUB_TOKEN environment variable is not set.");
    process.exit(2);
  }

  let owner = args.owner;
  let repo = args.repo;
  if (!owner || !repo) {
    const detected = detectOwnerRepo(args.repoRoot);
    if (!detected) {
      console.error(
        "Could not detect owner/repo from git remote. Pass --owner and --repo."
      );
      process.exit(2);
    }
    owner = owner ?? detected.owner;
    repo = repo ?? detected.repo;
  }

  const octokit = new Octokit({ auth: token, userAgent: "slowcook-ai/cli" });

  // 1. List files changed in this PR
  const files = await octokit.paginate(octokit.pulls.listFiles, {
    owner,
    repo,
    pull_number: args.prNumber,
    per_page: 100,
  });

  // 2. Find spec YAML files (specs/story-NNN.yaml) that were added in this PR
  const specFiles = (files as Array<{ status: string; filename: string }>)
    .filter((f) => f.status === "added" || f.status === "modified")
    .map((f) => f.filename)
    .filter((name) => /^specs\/story-\d+\.yaml$/.test(name));

  if (specFiles.length === 0) {
    console.log(`No spec files in PR #${args.prNumber}. Nothing to transition.`);
    return;
  }

  // 3. For each spec file, read source_issue from the on-disk content and
  //    transition that issue's labels. The workflow checks out post-merge,
  //    so the files live at cwd/specs/story-NNN.yaml on main.
  const issuesToTransition: Array<{ issue: number; storyId: string }> = [];
  for (const specPath of specFiles) {
    try {
      const full = join(args.repoRoot, specPath);
      const doc = YAML.parse(readFileSync(full, "utf8")) as {
        story_id?: string;
        source_issue?: string;
      };
      if (!doc.source_issue) {
        console.log(`  skip ${specPath}: no source_issue field`);
        continue;
      }
      const m = doc.source_issue.match(/^#?(\d+)$/);
      if (!m || !m[1]) {
        console.log(
          `  skip ${specPath}: source_issue '${doc.source_issue}' not a numeric issue reference`
        );
        continue;
      }
      issuesToTransition.push({
        issue: parseInt(m[1], 10),
        storyId: doc.story_id ?? "?",
      });
    } catch (e) {
      console.log(`  skip ${specPath}: ${(e as Error).message}`);
    }
  }

  for (const { issue, storyId } of issuesToTransition) {
    console.log(`Transitioning #${issue} (story-${storyId}): spec-submitted → spec-ready`);
    try {
      await octokit.issues.addLabels({
        owner,
        repo,
        issue_number: issue,
        labels: ["spec-ready"],
      });
    } catch (e) {
      console.error(
        `  failed to add spec-ready on #${issue}: ${(e as Error).message}`
      );
    }
    try {
      await octokit.issues.removeLabel({
        owner,
        repo,
        issue_number: issue,
        name: "spec-submitted",
      });
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status !== 404) {
        console.error(
          `  failed to remove spec-submitted on #${issue}: ${(e as Error).message}`
        );
      }
    }
  }

  console.log(
    `Done — transitioned ${issuesToTransition.length} issue(s) on PR #${args.prNumber}.`
  );
}
