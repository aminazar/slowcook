import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { Octokit } from "@octokit/rest";

/**
 * Called from a workflow that fires on `pull_request.closed` with
 * `merged == true` and the `slowcook-tests` label. Finds the manifest
 * file(s) added by the merged PR, reads each story's spec, and posts
 * an audit-trail comment on the source_issue noting that tests merged
 * and brew-auto triggers next.
 *
 * Idempotent-safe: re-running double-posts comments but nothing destructive.
 * Pairs with on-spec-merged (previous transition) and the not-yet-existent
 * on-brew-merged (next transition).
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
slowcook on-tests-merged — post audit-trail comment after a tests PR merges

Typically called from a GitHub Actions workflow listening for
pull_request.closed events on PRs labeled 'slowcook-tests'. Finds the
manifest files in the merged PR, resolves each story's source_issue
via the corresponding spec YAML, and posts a comment noting that the
tests merged and \`slowcook-brew-auto\` triggers next.

Usage:
  slowcook on-tests-merged --pr <number> [options]

Options:
  --pr <number>    PR number (required)
  --cwd <path>     Repo working directory (default: .)
  --owner <login>  Repo owner (default: detected from git remote)
  --repo <name>    Repo name (default: detected from git remote)
  --help, -h       Show this help

Environment:
  GITHUB_TOKEN  (required)  Token with issues:write + pull-requests:read

Exit codes:
  0   comments posted (or nothing to do)
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

export async function onTestsMerged(argv: string[]): Promise<void> {
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

  // 2. Find manifest files that were added/modified
  const manifestFiles = (files as Array<{ status: string; filename: string }>)
    .filter((f) => f.status === "added" || f.status === "modified")
    .map((f) => f.filename)
    .filter((name) => /^\.brewing\/manifests\/story-\d+\.json$/.test(name));

  if (manifestFiles.length === 0) {
    console.log(`No story manifests in PR #${args.prNumber}. Nothing to post.`);
    return;
  }

  // 3. Resolve story_id + source_issue from each manifest's matching spec.
  //    Manifest file names embed the story id; specs live at specs/story-N.yaml.
  const toComment: Array<{ issue: number; storyId: string }> = [];
  for (const manifestPath of manifestFiles) {
    const m = manifestPath.match(/story-(\d+)\.json$/);
    const storyId = m && m[1] ? m[1] : null;
    if (!storyId) continue;
    const specPath = join(args.repoRoot, "specs", `story-${storyId}.yaml`);
    if (!existsSync(specPath)) {
      console.log(`  skip story-${storyId}: spec not found at ${specPath}`);
      continue;
    }
    try {
      const doc = YAML.parse(readFileSync(specPath, "utf8")) as {
        source_issue?: string;
      };
      if (!doc.source_issue) {
        console.log(`  skip story-${storyId}: spec has no source_issue`);
        continue;
      }
      const issueMatch = doc.source_issue.match(/^#?(\d+)$/);
      if (!issueMatch || !issueMatch[1]) {
        console.log(
          `  skip story-${storyId}: source_issue '${doc.source_issue}' not numeric`
        );
        continue;
      }
      toComment.push({ issue: parseInt(issueMatch[1], 10), storyId });
    } catch (e) {
      console.log(`  skip story-${storyId}: ${(e as Error).message}`);
    }
  }

  for (const { issue, storyId } of toComment) {
    console.log(`Posting tests-merged comment on #${issue} (story-${storyId})`);
    const body =
      `### slowcook · tests merged\n\n` +
      `[PR #${args.prNumber}](https://github.com/${owner}/${repo}/pull/${args.prNumber}) merged — ` +
      `\`story-${storyId}\` tests are frozen. \`slowcook-brew-auto\` triggers automatically; the brew agent will open an implementation PR when it's green.\n\n` +
      `---\n*Generated by \`slowcook on-tests-merged\`.*`;
    try {
      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: issue,
        body,
      });
    } catch (e) {
      console.error(
        `  failed to post comment on #${issue}: ${(e as Error).message}`
      );
    }
  }

  console.log(
    `Done — posted ${toComment.length} comment(s) for PR #${args.prNumber}.`
  );
}
