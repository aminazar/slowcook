/**
 * `slowcook on-mockup-approved --pr <number>` — 0.16.0-α.23.
 *
 * Called from a workflow that fires on `pull_request.labeled` with
 * label = `slowcook-mockup-approved`. Walks the mockup PR's comment
 * thread to extract every cost marker (vibe + plate runs), sums them,
 * then posts a cost-rollup audit comment on the originating GitHub
 * issue (looked up via the spec's `source_issue` field).
 *
 * Pairs with on-spec-merged / on-tests-merged / on-brew-merged so the
 * issue thread tells the full pipeline story end-to-end. Approval is
 * the half-way mark — mockup signed off; brew runs next once the PR
 * actually merges.
 *
 * Idempotent-safe: re-running double-posts. The workflow's
 * `concurrency` group + the labeled-event trigger fire it once per
 * label-add, which is correct for the single-shot semantics.
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { Octokit } from "@octokit/rest";

interface Args {
  prNumber: number;
  repoRoot: string;
  owner?: string;
  repo?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { prNumber: 0, repoRoot: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--pr" && next) { args.prNumber = parseInt(next, 10); i++; }
    else if (arg === "--cwd" && next) { args.repoRoot = next; i++; }
    else if (arg === "--owner" && next) { args.owner = next; i++; }
    else if (arg === "--repo" && next) { args.repo = next; i++; }
    else if (arg === "--help" || arg === "-h") { printHelp(); process.exit(0); }
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
slowcook on-mockup-approved — post cost-rollup on the source issue when a mockup PR is approved

Triggered by a workflow listening for pull_request.labeled events on
PRs labeled \`slowcook-mockup\` when the \`slowcook-mockup-approved\`
label is added. Reads the mockup PR's comment thread, sums every
cost marker (vibe + plate runs), looks up the originating GitHub
issue from the spec's source_issue field, and posts a cost rollup.

Usage:
  slowcook on-mockup-approved --pr <number> [options]

Options:
  --pr <number>    PR number (required)
  --cwd <path>     Repo working directory (default: .)
  --owner <login>  Repo owner (default: detected from git remote)
  --repo <name>    Repo name (default: detected from git remote)

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
  } catch { /* ignore */ }
  return null;
}

const COST_MARKER_RE = /<!--\s*slowcook:cost\s+agent=(\w+)\s+usd=([0-9.]+)/g;

interface CostEntry {
  agent: string;
  usd: number;
}

function extractCostsFromBody(body: string): CostEntry[] {
  const out: CostEntry[] = [];
  COST_MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COST_MARKER_RE.exec(body)) !== null) {
    out.push({ agent: m[1]!, usd: parseFloat(m[2]!) });
  }
  return out;
}

export async function onMockupApproved(argv: string[]): Promise<void> {
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
      console.error("Could not detect owner/repo from git remote. Pass --owner and --repo.");
      process.exit(2);
    }
    owner = owner ?? detected.owner;
    repo = repo ?? detected.repo;
  }

  const octokit = new Octokit({ auth: token, userAgent: "slowcook-ai/cli" });

  // 1. Fetch the PR to get its head ref + verify it's a mockup PR
  const pr = await octokit.rest.pulls.get({ owner, repo, pull_number: args.prNumber });
  const headRef = pr.data.head.ref;
  const m = headRef.match(/^slowcook\/mockup\/story-([\w-]+)$/);
  if (!m || !m[1]) {
    console.error(
      `PR #${args.prNumber} head ref "${headRef}" doesn't match slowcook/mockup/story-N. Skipping.`
    );
    return;
  }
  const storyId = m[1];

  // 2. Read the spec to find source_issue
  const specPath = join(args.repoRoot, "specs", `story-${storyId}.yaml`);
  if (!existsSync(specPath)) {
    console.error(`Spec not found at ${specPath}; cannot resolve source_issue.`);
    process.exit(0);
  }
  const spec = YAML.parse(readFileSync(specPath, "utf8")) as { source_issue?: string };
  if (!spec.source_issue) {
    console.log(`Spec story-${storyId} has no source_issue. Nothing to bill.`);
    return;
  }
  const issueMatch = spec.source_issue.match(/^#?(\d+)$/);
  if (!issueMatch || !issueMatch[1]) {
    console.error(`spec source_issue "${spec.source_issue}" not numeric.`);
    process.exit(0);
  }
  const issueNumber = parseInt(issueMatch[1], 10);

  // 3. Fetch all comments on the mockup PR + extract cost markers
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner, repo, issue_number: args.prNumber, per_page: 100,
  });
  const costs: CostEntry[] = [];
  for (const c of comments) {
    if (!c.body) continue;
    costs.push(...extractCostsFromBody(c.body));
  }
  // Also include the PR body itself (vibe's initial cost is in the
  // PR description, not a comment).
  if (pr.data.body) costs.push(...extractCostsFromBody(pr.data.body));

  const total = costs.reduce((s, c) => s + c.usd, 0);
  const byAgent = new Map<string, number>();
  for (const c of costs) {
    byAgent.set(c.agent, (byAgent.get(c.agent) ?? 0) + c.usd);
  }

  // 4. Build + post the issue comment
  const lines: string[] = [];
  lines.push(`### slowcook · mockup approved (story-${storyId})`);
  lines.push("");
  lines.push(
    `Mockup PR #${args.prNumber} signed off; \`slowcook-mockup-approved\` label applied. ` +
      `Plate refuses further amendments. **Next**: merge the PR to fire \`brew --mode plate\` ` +
      `(once recipe-tests PR is also merged).`
  );
  lines.push("");
  lines.push(`#### Spend so far on this story`);
  lines.push("");
  lines.push("| Agent | Runs | $ |");
  lines.push("|---|---:|---:|");
  for (const [agent, usd] of [...byAgent.entries()].sort()) {
    const runs = costs.filter((c) => c.agent === agent).length;
    lines.push(`| \`${agent}\` | ${runs} | ${usd.toFixed(4)} |`);
  }
  lines.push(`| **Total** | **${costs.length}** | **${total.toFixed(4)}** |`);
  lines.push("");
  lines.push(
    `_Post-merge brew run will add its own cost line; the on-brew-merged comment will fire when that lands._`
  );
  lines.push("");
  lines.push(`<!-- slowcook:on-mockup-approved pr=${args.prNumber} story=${storyId} usd=${total.toFixed(4)} -->`);

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: lines.join("\n"),
  });
  console.log(
    `Posted approval cost rollup on issue #${issueNumber} (story-${storyId}, total $${total.toFixed(4)} across ${costs.length} runs).`
  );
}
