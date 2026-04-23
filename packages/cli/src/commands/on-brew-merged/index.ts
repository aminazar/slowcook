import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { Octokit } from "@octokit/rest";
import { parseCostMarkers } from "../refine/llm.js";

/**
 * Called from a workflow that fires on `pull_request.closed` with
 * `merged == true` and the `slowcook-brew` label. Infers the story id
 * from the brew branch name (\`slowcook/brew/story-N-<ts>\`), looks up
 * the source_issue via the spec, posts a "shipped" audit-trail comment.
 *
 * Final transition in the pipeline's audit-trail story. Prior transitions:
 * refine → on-spec-merged → testgen → on-tests-merged → brew → here.
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
slowcook on-brew-merged — post final audit-trail comment after a brew PR merges

Typically called from a GitHub Actions workflow listening for
pull_request.closed events on PRs labeled 'slowcook-brew'. Infers the
story id from the branch name, reads the spec's source_issue, and
posts the final "shipped" comment on the source issue.

Usage:
  slowcook on-brew-merged --pr <number> [options]

Options:
  --pr <number>    PR number (required)
  --cwd <path>     Repo working directory (default: .)
  --owner <login>  Repo owner (default: detected from git remote)
  --repo <name>    Repo name (default: detected from git remote)
  --help, -h       Show this help

Environment:
  GITHUB_TOKEN  (required)  Token with issues:write + pull-requests:read

Exit codes:
  0   comment posted (or nothing to do)
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

export async function onBrewMerged(argv: string[]): Promise<void> {
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

  // Get the PR to extract the head branch name
  const { data: pr } = await octokit.pulls.get({
    owner,
    repo,
    pull_number: args.prNumber,
  });

  // Brew branches look like `slowcook/brew/story-N-<ts>`
  const branchMatch = pr.head.ref.match(/slowcook\/brew\/story-(\d+)-/);
  if (!branchMatch || !branchMatch[1]) {
    console.log(
      `PR #${args.prNumber} branch '${pr.head.ref}' is not a slowcook brew branch. Nothing to do.`
    );
    return;
  }
  const storyId = branchMatch[1];

  // Resolve source_issue from the spec
  const specPath = join(args.repoRoot, "specs", `story-${storyId}.yaml`);
  if (!existsSync(specPath)) {
    console.log(`Spec not found at ${specPath}. Cannot post comment.`);
    return;
  }
  let sourceIssue: number | null = null;
  try {
    const doc = YAML.parse(readFileSync(specPath, "utf8")) as {
      source_issue?: string;
    };
    const m = doc.source_issue?.match(/^#?(\d+)$/);
    if (m && m[1]) sourceIssue = parseInt(m[1], 10);
  } catch (e) {
    console.log(`Failed to parse ${specPath}: ${(e as Error).message}`);
  }
  if (!sourceIssue) {
    console.log(`No source_issue on story-${storyId}. Nothing to post.`);
    return;
  }

  console.log(
    `Posting brew-merged (shipped) comment on #${sourceIssue} (story-${storyId})`
  );

  // Aggregate pipeline cost by reading existing comments on the source
  // issue and summing slowcook:cost markers. Agents post these markers
  // as hidden HTML comments in their audit-trail comments (0.7.9+).
  // Best-effort — if the walk fails we still post the shipped message
  // without the cost line.
  let costSummaryMd = "";
  try {
    const comments = await octokit.paginate(octokit.issues.listComments, {
      owner,
      repo,
      issue_number: sourceIssue,
      per_page: 100,
    });
    const markers = (comments as Array<{ body?: string }>)
      .flatMap((c) => parseCostMarkers(c.body ?? ""));
    if (markers.length > 0) {
      const byAgent = new Map<string, { usd: number; n: number }>();
      for (const m of markers) {
        const acc = byAgent.get(m.agent) ?? { usd: 0, n: 0 };
        acc.usd += m.usd;
        acc.n += 1;
        byAgent.set(m.agent, acc);
      }
      const totalUsd = [...byAgent.values()].reduce((a, b) => a + b.usd, 0);
      const order = ["refine", "testgen", "brew"];
      const lines: string[] = [];
      lines.push("**Pipeline cost:**");
      for (const agent of order) {
        const acc = byAgent.get(agent);
        if (!acc) continue;
        const roundsNote = acc.n > 1 ? ` (${acc.n} run${acc.n === 1 ? "" : "s"})` : "";
        lines.push(`- ${agent}${roundsNote}: $${acc.usd.toFixed(4)}`);
      }
      lines.push(`- **Total: $${totalUsd.toFixed(4)}**`);
      costSummaryMd = "\n\n" + lines.join("\n") + "\n";
    }
  } catch (e) {
    console.log(
      `  cost aggregation skipped: ${(e as Error).message}`
    );
  }

  const body =
    `### slowcook · shipped 🎉\n\n` +
    `[PR #${args.prNumber}](https://github.com/${owner}/${repo}/pull/${args.prNumber}) merged — ` +
    `\`story-${storyId}\` is now on main. This issue is considered shipped; feel free to close it.\n` +
    costSummaryMd +
    `\nPipeline trail:\n` +
    `- **refine** — \`spec-ready\` (earlier in this thread)\n` +
    `- **testgen** — tests merged (earlier in this thread)\n` +
    `- **brew** — this PR\n\n` +
    `---\n*Generated by \`slowcook on-brew-merged\`.*`;
  try {
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: sourceIssue,
      body,
    });
  } catch (e) {
    console.error(
      `  failed to post comment on #${sourceIssue}: ${(e as Error).message}`
    );
  }
  console.log("Done.");
}
