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
import { loadGates } from "../../lib/gates.js";
import { constitutionBlock } from "../../lib/constitution.js";
import { analyzeSpecYaml, renderFindings } from "../analyze/index.js";
import { parseStoryBranch } from "../../lib/story-branch.js";
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
  const parsed = parseStoryBranch(head);
  const kindMatch = parsed ? [head, parsed.kind, parsed.storyId] : null;
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
    // The spec must come from the BASE branch, never the working tree
    // (ledger G26): a resubmit leaves the checkout on the PR branch,
    // whose spec predates amendments — taste then argues against a
    // contract that no longer exists. `git show` is deterministic and
    // checkout-independent.
    const base = pr.base?.ref ?? "main";
    specYaml = execSync(`git show origin/${base}:specs/story-${storyId}.yaml`, {
      cwd: args.repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    try {
      specYaml = readFileSync(join(args.repoRoot, "specs", `story-${storyId}.yaml`), "utf8");
    } catch {
      /* spec PR under review may BE the spec — it's in the diff */
    }
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

  // The PR's own discussion thread — where PM rulings/relays land during
  // review rounds. Taste's own findings comments are excluded (it must not
  // treat its past verdicts as lineage evidence).
  let prThread: string | null = null;
  try {
    const { data: prComments } = await octokit.issues.listComments({
      owner,
      repo,
      issue_number: args.pr,
      per_page: 100,
    });
    prThread =
      prComments
        .filter((c) => !(c.body ?? "").startsWith("**slowcook-taste**"))
        .slice(-8)
        .map((c) => `@${c.user?.login}: ${(c.body ?? "").slice(0, 2000)}`)
        .join("\n\n")
        .slice(0, 10_000) || null;
  } catch {
    /* lineage best-effort */
  }

  // 2026-08-23 (PR-D) — the PRESENT, deterministically. The diff shows
  // deltas and the thread shows history; reviews were recalling stale
  // thread errors as current defects. Fetch the head and read the
  // story's key files as they ARE (git show against FETCH_HEAD — the
  // checkout-independent G26 pattern), plus commit subjects so PM-
  // arbitration commits are visible to the tampering rule.
  let headFiles: Array<{ path: string; content: string }> | null = null;
  let commitSubjects: string[] | null = null;
  try {
    const { data: prFiles } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: args.pr,
      per_page: 100,
    });
    execSync(`git fetch origin ${JSON.stringify(head)}`, {
      cwd: args.repoRoot,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const keyPaths = prFiles
      .map((f) => f.filename)
      .filter(
        (f) =>
          f.startsWith("tests/") ||
          f.startsWith("supabase/tests/") ||
          f.startsWith("specs/") ||
          f.startsWith(".brewing/manifests/")
      )
      .slice(0, 8);
    headFiles = [];
    for (const path of keyPaths) {
      try {
        const content = execSync(`git show FETCH_HEAD:${JSON.stringify(path)}`, {
          cwd: args.repoRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: 4 * 1024 * 1024,
        });
        headFiles.push({ path, content: content.slice(0, 12_000) });
      } catch {
        /* deleted at head — its absence IS the current state */
      }
    }
    if (headFiles.length === 0) headFiles = null;
  } catch {
    headFiles = null;
  }
  try {
    const { data: prCommits } = await octokit.pulls.listCommits({
      owner,
      repo,
      pull_number: args.pr,
      per_page: 50,
    });
    commitSubjects = prCommits.map((c) => (c.commit.message ?? "").split("\n")[0]!.slice(0, 120));
    if (commitSubjects.length === 0) commitSubjects = null;
  } catch {
    commitSubjects = null;
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
    prThread,
    manifestJson: (() => {
      if (kind !== "brew") return null;
      try {
        return readFileSync(
          join(args.repoRoot, ".brewing", "manifests", `story-${storyId}.json`),
          "utf8"
        ).slice(0, 8000);
      } catch {
        return null;
      }
    })(),
    headFiles,
    commitSubjects,
    constitution: constitutionBlock(args.repoRoot),
    analyzeFindings: await (async () => {
      if (kind !== "spec" || !specYaml) return "";
      try {
        const findings = await analyzeSpecYaml(specYaml, args.repoRoot);
        return findings.length > 0 ? renderFindings(findings) : "";
      } catch (e) {
        // Analysis is evidence, not a gate on taste itself — surface the
        // breakage instead of silently reviewing without it.
        return `analyze failed to run: ${e instanceof Error ? e.message : String(e)}`;
      }
    })(),
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

  // Gate declarations (.brewing/gates.yaml): a "human" gate means taste
  // reviews and advises but THE MERGE IS THE PM's — authority granted by
  // --merge never overrides a declared human gate.
  const gates = loadGates(args.repoRoot);
  const humanGate = gates[kind] === "human";
  let merged = false;
  let mergeNote = "";
  if (verdict.verdict === "approve" && humanGate) {
    console.log(`gate: ${kind} is declared human — merge left to the PM`);
  }
  if (verdict.verdict === "approve" && args.merge && !humanGate) {
    try {
      // Agent PRs are born drafts; an approved draft is ready by definition.
      if (pr.draft) {
        await octokit.graphql(
          `mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }`,
          { id: pr.node_id }
        );
      }
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

  const costLine =
    usd !== null
      ? "\n\n" + costMarker({ agent: "taste", usd, tokensIn: response.usage.inputTokens, tokensOut: response.usage.outputTokens, cacheRead: response.usage.cacheReadTokens, cacheCreate: response.usage.cacheCreateTokens, model })
      : "";
  const body =
    renderReviewBody(verdict, { header, merged, mergeAuthority: args.merge && !humanGate }) +
    (humanGate && verdict.verdict === "approve"
      ? `\n\n🔒 **${kind} is a declared human gate** — merge is the PM's call.`
      : "") +
    (mergeNote ? `\n\n⚠️ Merge failed: ${mergeNote}` : "") +
    (verdict.verdict === "request_changes" || mergeNote || (humanGate && verdict.verdict === "approve")
      ? pmCc(args.repoRoot)
      : "") +
    costLine;
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: args.pr,
    event: "COMMENT",
    body,
  });
  // Findings must be CONSUMABLE by the author agent. Resubmit paths read
  // TIMELINE comments (review bodies are a separate API surface they never
  // see), so changes-requested findings are also posted as a plain PR
  // comment — the actionable copy; the review above is the verdict record
  // and taste's own re-fire guard.
  if (verdict.verdict === "request_changes") {
    await octokit.issues.createComment({
      owner,
      repo,
      issue_number: args.pr,
      body: renderReviewBody(verdict, { header, merged: false, mergeAuthority: false }),
    });
  }

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
