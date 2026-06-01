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

function centre(text: string, width: number): string {
  if (text.length >= width) return text;
  const totalPad = width - text.length;
  const left = Math.floor(totalPad / 2);
  return " ".repeat(left) + text + " ".repeat(totalPad - left);
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

  // 0.19.4-α (sc#146 finding 3) — brew PR's base ref MUST be main.
  // Brew opens its PRs against main; if a PM (or another agent) re-targets
  // the PR to a sibling feature branch, the canonical files land on the
  // sibling branch and the apps/<role>/ lift typically orphans on the
  // cross-branch merge. Warn loudly on the source issue + the brew PR
  // itself instead of posting the misleading "shipped" message.
  const expectedBase = "main";
  if (pr.base.ref !== expectedBase) {
    const warningBody =
      `### slowcook · brew merged into non-main branch ⚠️\n\n` +
      `[PR #${args.prNumber}](https://github.com/${owner}/${repo}/pull/${args.prNumber}) ` +
      `(\`story-${storyId}\`) merged into \`${pr.base.ref}\`, NOT \`${expectedBase}\`.\n\n` +
      `The story is **not** shipped yet — the canonical files live on \`${pr.base.ref}\`. ` +
      `Heads up:\n\n` +
      `- The slowcook-canonical-vs-app-shell dual-path lift in this brew may be lost when ` +
      `\`${pr.base.ref}\` is rebased / cherry-picked into \`${expectedBase}\`. Verify that ` +
      `BOTH \`src/app/(main)/...\` AND \`apps/<role>/src/app/...\` files are present after the ` +
      `eventual merge to \`${expectedBase}\`.\n` +
      `- Pipeline audit-trail comments (refine → testgen → brew → shipped) assume merges land ` +
      `on \`${expectedBase}\`. The "shipped" comment is suppressed here so it doesn't fire ` +
      `prematurely; it'll be posted by the next on-brew-merged run when the consolidation PR ` +
      `lands on \`${expectedBase}\`.\n\n` +
      `Refs: aminazar/slowcook#146 finding 3.\n\n` +
      `---\n*Generated by \`slowcook on-brew-merged\`.*`;
    // Post on the brew PR itself so the next reviewer sees the warning,
    // AND on the source issue so the PM tracking the story knows the
    // pipeline trail diverged from expectation.
    try {
      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: args.prNumber,
        body: warningBody,
      });
    } catch (e) {
      console.error(
        `  failed to post warning on PR #${args.prNumber}: ${(e as Error).message}`
      );
    }
    // Resolve source_issue to mirror the warning there (best effort —
    // continues even if the spec lookup later fails).
    const specPathEarly = join(args.repoRoot, "specs", `story-${storyId}.yaml`);
    if (existsSync(specPathEarly)) {
      try {
        const doc = YAML.parse(readFileSync(specPathEarly, "utf8")) as {
          source_issue?: string;
        };
        const m = doc.source_issue?.match(/^#?(\d+)$/);
        const sourceIssueEarly = m && m[1] ? parseInt(m[1], 10) : null;
        if (sourceIssueEarly) {
          await octokit.issues.createComment({
            owner,
            repo,
            issue_number: sourceIssueEarly,
            body: warningBody,
          });
        }
      } catch (e) {
        console.error(
          `  failed to post warning on source issue: ${(e as Error).message}`
        );
      }
    }
    console.log(
      `Non-main brew merge (target=${pr.base.ref}); posted warning + suppressed shipped comment.`
    );
    return;
  }

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
      // 0.12.13+ — restaurant-bill rendering. Wrapped in a code block so
      // GitHub renders it in a fixed-width font; columns align.
      // Order respects the pipeline flow (refine → testgen/recipe →
      // brew/sift). Bug-flow agents (investigate, sift) included so
      // future bugs render with the same template.
      const order = ["refine", "investigate", "testgen", "recipe", "brew", "sift"];
      const lineWidth = 38;
      const lines: string[] = [];
      const sep = "─".repeat(lineWidth);
      lines.push(sep);
      lines.push(centre("SLOWCOOK · PIPELINE BILL", lineWidth));
      lines.push(sep);
      for (const agent of order) {
        const acc = byAgent.get(agent);
        if (!acc) continue;
        const left = ` ${agent.padEnd(12)}× ${acc.n}`;
        const right = `$${acc.usd.toFixed(4)} `;
        lines.push(left + " ".repeat(Math.max(1, lineWidth - left.length - right.length)) + right);
      }
      lines.push(sep);
      const totalLeft = " TOTAL";
      const totalRight = `$${totalUsd.toFixed(4)} `;
      lines.push(
        totalLeft + " ".repeat(Math.max(1, lineWidth - totalLeft.length - totalRight.length)) + totalRight
      );
      lines.push(sep);
      costSummaryMd = "\n\n```\n" + lines.join("\n") + "\n```\n";
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
