/**
 * `slowcook recipe --pr <n>` — tests-PR resubmit (ledger G10).
 *
 * The tests are recipe's artifact, so recipe answers reviews on a tests
 * PR — taste's findings or a human's. Mirror of refine's resubmit:
 *
 *   1. THE PR IS AUTHORITATIVE (G9): resolve the story from the PR head
 *      branch and make the checkout match before touching a file.
 *   2. Feedback = timeline comments since the branch's last commit
 *      (taste posts its findings there for exactly this reason) plus
 *      human inline review comments. Refine's own brand-header comments
 *      are filtered; nothing else is.
 *   3. The model amends ONLY the test files that need to change, in an
 *      explicit file-block protocol; amended files are committed to the
 *      SAME branch and pushed — taste re-derives once the commit is
 *      newer than its review.
 *
 * stdout contract (worker mapping): "Tests amended: N file(s)" +
 * "Pushed to branch <branch>." — or "Noop: <reason>".
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { Octokit } from "@octokit/rest";
import type { LlmClient } from "@slowcook-ai/core";
import { costEntryUsd, costMarker } from "@slowcook-ai/llm-anthropic";

export interface TestsResubmitContext {
  prNumber: number;
  repoRoot: string;
  owner: string;
  repo: string;
  token: string;
  llm: LlmClient;
  model: string;
}

/** Parse `<file path="...">...</file>` blocks from model output. */
export function parseFileBlocks(text: string): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  const re = /<file path="([^"]+)">\n?([\s\S]*?)<\/file>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const path = m[1]!.trim();
    // Never let the model write outside the tests tree or escape the repo.
    if (!path.startsWith("tests/") || path.includes("..")) continue;
    out.push({ path, content: (m[2] ?? "").replace(/\n?$/, "\n") });
  }
  return out;
}

export async function runTestsResubmit(ctx: TestsResubmitContext): Promise<void> {
  const octokit = new Octokit({ auth: ctx.token, userAgent: "slowcook-ai/cli recipe-resubmit" });
  const { data: pr } = await octokit.pulls.get({
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: ctx.prNumber,
  });
  const branch = pr.head?.ref ?? "";
  const storyId = branch.match(/slowcook\/tests\/story-(.+)$/)?.[1];
  if (!storyId) {
    console.log(`Noop: PR #${ctx.prNumber} head "${branch}" is not a slowcook tests branch.`);
    return;
  }

  // Checkout must MATCH the PR (G9) — fail closed on dirt.
  const dirty = execSync("git status --porcelain", { cwd: ctx.repoRoot, encoding: "utf8" })
    .split("\n")
    .filter((l) => l.trim() && !l.includes(".brewing/history-index"));
  if (dirty.length > 0) {
    console.error(`slowcook recipe: checkout has uncommitted changes — refusing.`);
    process.exit(2);
  }
  execSync(`git fetch origin ${branch}`, { cwd: ctx.repoRoot });
  execSync(`git checkout ${branch}`, { cwd: ctx.repoRoot, stdio: ["ignore", "ignore", "pipe"] });
  execSync(`git reset --hard origin/${branch}`, { cwd: ctx.repoRoot });

  // Feedback: timeline comments (taste findings live here) + human inline.
  const [{ data: comments }, { data: files }, { data: inline }] = await Promise.all([
    octokit.issues.listComments({ owner: ctx.owner, repo: ctx.repo, issue_number: ctx.prNumber, per_page: 100 }),
    octokit.pulls.listFiles({ owner: ctx.owner, repo: ctx.repo, pull_number: ctx.prNumber, per_page: 100 }),
    octokit.pulls.listReviewComments({ owner: ctx.owner, repo: ctx.repo, pull_number: ctx.prNumber, per_page: 100 }),
  ]);
  const feedback = [
    ...comments
      .filter((c) => !(c.body ?? "").startsWith("### slowcook ·"))
      .slice(-6)
      .map((c) => `## Comment by @${c.user?.login} at ${c.created_at}\n${c.body}`),
    ...inline
      .filter((c) => c.user?.type !== "Bot")
      .map((c) => `## Inline comment by @${c.user?.login} on ${c.path}:${c.line ?? "?"}\n${c.body}`),
  ].join("\n\n");
  if (!feedback.trim()) {
    console.log("Noop: no review feedback to process on the PR.");
    return;
  }

  const testPaths = files.map((f) => f.filename).filter((f) => f.startsWith("tests/"));
  const currentFiles = testPaths
    .map((p) => {
      try {
        return `<file path="${p}">\n${readFileSync(join(ctx.repoRoot, p), "utf8")}</file>`;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .join("\n\n");
  let specYaml = "";
  try {
    specYaml = readFileSync(join(ctx.repoRoot, "specs", `story-${storyId}.yaml`), "utf8");
  } catch {
    /* spec context best-effort */
  }

  const system = `You are slowcook's test-generation agent amending a tests PR in answer to review feedback.
Rules:
- Change ONLY what the findings require; leave everything else byte-identical.
- Tests stay honest: red before a correct implementation exists, green after; no tautologies; assert real behavior, never mock internals of mocks.
- The spec is the contract — where a finding says a test contradicts the spec, the SPEC wins.
- Output ONLY the files that change, each as:
<file path="tests/...">
<full new content>
</file>
No prose outside the file blocks. If no change is warranted, output exactly: NO_CHANGES <one-line reason>.`;

  const user = [
    `## Spec (story-${storyId})\n\`\`\`yaml\n${specYaml}\n\`\`\``,
    `## Review feedback to answer\n${feedback}`,
    `## Current test files\n${currentFiles}`,
  ].join("\n\n---\n\n");

  console.log(`slowcook recipe · resubmit on PR #${ctx.prNumber} (story-${storyId}, model ${ctx.model})`);
  const response = await ctx.llm.complete({
    system,
    messages: [{ role: "user", content: user }],
    model: ctx.model,
    maxTokens: 32000,
    stream: true,
  });

  const noChange = response.text.match(/^NO_CHANGES\s+(.*)$/m)?.[1];
  if (noChange) {
    await octokit.issues.createComment({
      owner: ctx.owner,
      repo: ctx.repo,
      issue_number: ctx.prNumber,
      body: `### slowcook · recipe resubmit\n\nReviewed the feedback; no test change warranted: ${noChange}`,
    });
    console.log(`Noop: model judged no change warranted (${noChange}).`);
    return;
  }
  const blocks = parseFileBlocks(response.text);
  if (blocks.length === 0) {
    console.error("slowcook recipe: no parseable file blocks in the amendment — failing closed.");
    process.exit(2);
  }
  for (const b of blocks) {
    const abs = join(ctx.repoRoot, b.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, b.content, "utf8");
  }
  execSync(`git add tests/`, { cwd: ctx.repoRoot });
  execSync(
    `git -c user.name="slowcook" -c user.email="agents@slowcook.dev" commit -m "recipe: resubmit story-${storyId} per PR #${ctx.prNumber} review"`,
    { cwd: ctx.repoRoot }
  );
  execSync(`git push origin ${branch}`, { cwd: ctx.repoRoot });

  const usd = costEntryUsd(ctx.model, response.usage);
  await octokit.issues.createComment({
    owner: ctx.owner,
    repo: ctx.repo,
    issue_number: ctx.prNumber,
    body:
      `### slowcook · recipe resubmit\n\nAmended ${blocks.length} test file${blocks.length === 1 ? "" : "s"} per the review; pushed to \`${branch}\`.\n` +
      blocks.map((b) => `- \`${b.path}\``).join("\n") +
      (usd !== null
        ? "\n\n" +
          costMarker({
            agent: "testgen",
            usd,
            tokensIn: response.usage.inputTokens,
            tokensOut: response.usage.outputTokens,
            cacheRead: response.usage.cacheReadTokens,
            cacheCreate: response.usage.cacheCreateTokens,
            model: ctx.model,
            round: "resubmit",
          })
        : ""),
  });
  console.log(`Tests amended: ${blocks.length} file(s)`);
  console.log(`Pushed to branch ${branch}.`);
}
