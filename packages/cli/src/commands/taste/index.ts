/**
 * `slowcook taste` — reviewer agent for pipeline PRs (worker stage).
 *
 *   slowcook taste --pr <n> [--merge] [--cwd <path>] [--owner <o>] [--repo <r>]
 *                  [--model <id>]
 *
 * Triggered BY the PR (the worker derives a job for any open agent PR
 * without a submitted review — no labels). Gathers the story lineage
 * (source issue + PM Q&A, spec, diff), asks the model for a structured
 * verdict, posts a COMMENT review under the agent identity, and — only
 * with --merge, only on approve, only with a parseable verdict — merges.
 *
 * Fail-closed rules: unparseable verdict = exit 2, no review posted, no
 * merge. Blocking finding = never approve. Merge failure = review stands,
 * PR stays open, PM is cc'd.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Octokit } from "@octokit/rest";
import { createLlmClient } from "../refine/llm.js";
import { resolveModel } from "../../lib/model-defaults.js";
import { costEntryUsd, costMarker } from "@slowcook-ai/llm-anthropic";
import { readIndex } from "../refine/spec-yaml.js";
import { pmCc } from "../../lib/pm-notify.js";
import {
  buildTastePrompt,
  parseTasteVerdict,
  renderReviewBody,
  type PrKind,
  type TasteContext,
} from "./review.js";

interface TasteArgs {
  pr: number;
  merge: boolean;
  repoRoot: string;
  owner?: string;
  repo?: string;
  model?: string;
}

const DIFF_CAP = 70_000;

export async function taste(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const token = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  if (!token) {
    console.error("slowcook taste: GITHUB_TOKEN / GH_TOKEN is not set.");
    process.exit(2);
  }
  const { owner, repo } = resolveOwnerRepo(args);
  if (!owner || !repo) {
    console.error("slowcook taste: cannot resolve the target repo (pass --owner/--repo).");
    process.exit(2);
  }
  const octokit = new Octokit({ auth: token, userAgent: "slowcook-ai/cli taste" });

  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: args.pr });
  const head = pr.head?.ref ?? "";
  const kindMatch = head.match(/slowcook\/(spec|tests)\/story-(.+)$/);
  if (!kindMatch) {
    console.error(
      `slowcook taste: PR #${args.pr} head "${head}" is not a slowcook spec/tests branch — refusing to review what no agent owns.`
    );
    process.exit(2);
  }
  const kind = kindMatch[1] as PrKind;
  const storyId = kindMatch[2]!;

  const { data: diffData } = await octokit.request(
    "GET /repos/{owner}/{repo}/pulls/{pull_number}",
    { owner, repo, pull_number: args.pr, mediaType: { format: "diff" } }
  );
  let diff = String(diffData);
  if (diff.length > DIFF_CAP) diff = diff.slice(0, DIFF_CAP) + "\n… (diff truncated)";

  // Lineage: spec + source issue + PM thread. Best-effort — missing
  // context is stated in the prompt by its absence, never faked.
  let specYaml: string | null = null;
  try {
    specYaml = readFileSync(join(args.repoRoot, "specs", `story-${storyId}.yaml`), "utf8");
  } catch {
    /* spec PR under review may BE the spec — it's in the diff */
  }
  let sourceIssueTitle: string | null = null;
  let sourceIssueBody: string | null = null;
  let issueThread: string | null = null;
  try {
    const index = readIndex(args.repoRoot);
    const srcNum = index.stories?.[storyId]?.source_issue?.match(/(\d+)\s*$/)?.[1];
    if (srcNum) {
      const issueNumber = Number(srcNum);
      const [{ data: issue }, { data: comments }] = await Promise.all([
        octokit.issues.get({ owner, repo, issue_number: issueNumber }),
        octokit.issues.listComments({ owner, repo, issue_number: issueNumber, per_page: 100 }),
      ]);
      sourceIssueTitle = `#${issueNumber} ${issue.title}`;
      sourceIssueBody = (issue.body ?? "").slice(0, 4000);
      issueThread = comments
        .slice(-8)
        .map((c) => `@${c.user?.login}: ${(c.body ?? "").slice(0, 1200)}`)
        .join("\n\n")
        .slice(0, 8000);
    }
  } catch {
    /* lineage best-effort */
  }

  const ctx: TasteContext = {
    prNumber: args.pr,
    prTitle: pr.title,
    prBody: (pr.body ?? "").slice(0, 3000),
    headBranch: head,
    kind,
    storyId,
    diff,
    specYaml,
    sourceIssueTitle,
    sourceIssueBody,
    issueThread,
  };

  const model = resolveModel("taste", args.model);
  console.log(`slowcook taste · PR #${args.pr} (${kind}, story-${storyId}) — model ${model}`);
  const llm = await createLlmClient();
  const prompt = buildTastePrompt(ctx);
  const response = await llm.complete({
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
    model,
    maxTokens: 4000,
    stream: true,
  });

  const verdict = parseTasteVerdict(response.text);
  if (!verdict) {
    console.error(
      "slowcook taste: could not parse a verdict from the model output — failing closed (no review, no merge)."
    );
    process.exit(2);
  }

  const usd = costEntryUsd(model, response.usage);
  const header = `**slowcook-taste** · PR #${args.pr} · story-${storyId}`;

  let merged = false;
  let mergeNote = "";
  if (verdict.verdict === "approve" && args.merge) {
    try {
      await octokit.pulls.merge({
        owner,
        repo,
        pull_number: args.pr,
        merge_method: "squash",
      });
      merged = true;
    } catch (e) {
      mergeNote = (e as Error).message;
    }
  }

  const body =
    renderReviewBody(verdict, { header, merged, mergeAuthority: args.merge }) +
    (mergeNote ? `\n\n⚠️ Merge failed: ${mergeNote}` : "") +
    (verdict.verdict === "request_changes" || mergeNote ? pmCc(args.repoRoot) : "") +
    (usd !== null
      ? "\n\n" + costMarker({ agent: "taste", usd, tokensIn: response.usage.inputTokens, tokensOut: response.usage.outputTokens, cacheRead: response.usage.cacheReadTokens, cacheCreate: response.usage.cacheCreateTokens, model })
      : "");
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: args.pr,
    event: "COMMENT",
    body,
  });

  console.log(
    `Review verdict: ${verdict.verdict === "approve" ? "APPROVE" : "REQUEST_CHANGES"}`
  );
  if (merged) console.log(`Merged PR #${args.pr}.`);
  else if (mergeNote) console.log(`Merge failed: ${mergeNote}`);
}

function parseArgs(argv: string[]): TasteArgs {
  const out: TasteArgs = { pr: 0, merge: false, repoRoot: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--pr" && next) { out.pr = Number(next); i++; }
    else if (a === "--merge") { out.merge = true; }
    else if (a === "--cwd" && next) { out.repoRoot = next; i++; }
    else if (a === "--owner" && next) { out.owner = next; i++; }
    else if (a === "--repo" && next) { out.repo = next; i++; }
    else if (a === "--model" && next) { out.model = next; i++; }
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  if (!out.pr) {
    console.error("slowcook taste: --pr <number> is required.");
    printHelp();
    process.exit(64);
  }
  return out;
}

function resolveOwnerRepo(args: TasteArgs): { owner?: string; repo?: string } {
  if (args.owner && args.repo) return { owner: args.owner, repo: args.repo };
  try {
    const url = execSync("git remote get-url origin", {
      cwd: args.repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (m) return { owner: args.owner ?? m[1], repo: args.repo ?? m[2] };
  } catch {
    /* caller reports */
  }
  return { owner: args.owner, repo: args.repo };
}

function printHelp(): void {
  console.log(`
slowcook taste — reviewer agent for pipeline PRs

Usage:
  slowcook taste --pr <n> [--merge] [--cwd <path>] [--owner <o>] [--repo <r>] [--model <id>]

Reviews an agent-authored spec/tests PR against its full lineage (source
issue + PM Q&A + spec + diff) and posts a structured verdict as a review.
With --merge (operator-granted authority) an APPROVE verdict merges the
PR (squash). Fail-closed: unparseable verdicts exit 2 and merge nothing;
a blocking finding can never ride an approve; merge failures cc the PM.

The worker derives taste jobs from open agent PRs with no submitted
review — the PR itself is the trigger.
`);
}
