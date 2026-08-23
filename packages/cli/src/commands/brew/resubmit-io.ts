/**
 * IO wrapper for `slowcook brew --pr N` (PR-B). See resubmit.ts for the
 * agent; this file owns the forge/git/verification plumbing.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Octokit } from "@octokit/rest";
import { createLlmClient } from "@slowcook-ai/llm-anthropic";
import { runTests, discoverTests, validateStackConfig, type StackConfig } from "../../stack-resolve.js";
import { parseStoryBranch } from "../../lib/story-branch.js";
import { loadAnsweredIds, recordAnsweredIds } from "../plate/answered-store.js";
import { finalGateVerdict } from "./gate-verdict.js";
import { foldCrossSuiteTests } from "./cross-suite.js";
import {
  runResubmitAgent,
  buildResubmitUserPrompt,
  isBrewFeedback,
  type ResubmitFeedbackItem,
} from "./resubmit.js";

const ANSWERED_STORE = "brew-answered.json";

export interface BrewResubmitArgs {
  pr: number;
  repoRoot: string;
  model: string;
  budgetUsd: number;
  owner: string;
  repo: string;
  token: string;
}

function sh(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export async function runBrewResubmit(args: BrewResubmitArgs): Promise<void> {
  const octokit = new Octokit({ auth: args.token, userAgent: "slowcook-ai/cli brew-resubmit" });
  const { owner, repo } = args;

  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: args.pr });
  const head = pr.head?.ref ?? "";
  const parsed = parseStoryBranch(head);
  if (!parsed || parsed.kind !== "brew") {
    console.error(`slowcook brew --pr: PR #${args.pr} head "${head}" is not a brew branch.`);
    process.exit(2);
  }
  if (pr.state !== "open") {
    console.error(`slowcook brew --pr: PR #${args.pr} is ${pr.state} — nothing to amend.`);
    process.exit(2);
  }
  const storyId = parsed.storyId;

  // Own the checkout, worker-style: refuse dirt, land on the PR head.
  const dirty = sh(args.repoRoot, "git status --porcelain")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("??"));
  if (dirty.length > 0) {
    console.error(`slowcook brew --pr: working tree is dirty — refusing:\n${dirty.join("\n")}`);
    process.exit(2);
  }
  sh(args.repoRoot, `git fetch origin ${JSON.stringify(head)}`);
  sh(args.repoRoot, `git checkout ${JSON.stringify(head)}`);
  sh(args.repoRoot, `git reset --hard ${JSON.stringify(`origin/${head}`)}`);

  // Feedback: taste advisories + humans, minus machine notices, minus
  // anything a prior resubmit already answered.
  const answered = loadAnsweredIds(args.repoRoot, args.pr, ANSWERED_STORE);
  const [{ data: issueComments }, { data: reviews }] = await Promise.all([
    octokit.issues.listComments({ owner, repo, issue_number: args.pr, per_page: 100 }),
    octokit.pulls.listReviews({ owner, repo, pull_number: args.pr, per_page: 100 }),
  ]);
  const feedback: ResubmitFeedbackItem[] = [];
  const consideredIds: number[] = [];
  for (const c of issueComments) {
    const body = c.body ?? "";
    if (!isBrewFeedback(body) || answered.has(c.id)) continue;
    feedback.push({ author: c.user?.login ?? "?", body, createdAt: c.created_at });
    consideredIds.push(c.id);
  }
  for (const r of reviews) {
    const body = r.body ?? "";
    if (!body.trim() || !isBrewFeedback(body) || answered.has(r.id)) continue;
    feedback.push({ author: r.user?.login ?? "?", body, createdAt: r.submitted_at ?? "" });
    consideredIds.push(r.id);
  }
  if (feedback.length === 0) {
    console.log("No unanswered feedback on this PR. Nothing to do.");
    return;
  }
  console.log(`Feedback to act on: ${feedback.length} item(s).`);

  // Context: spec from base (G26), current PR diff.
  let specYaml: string | null = null;
  try {
    specYaml = sh(args.repoRoot, `git show origin/${pr.base?.ref ?? "main"}:specs/story-${storyId}.yaml`);
  } catch {
    /* absent spec is stated by absence */
  }
  const { data: diffData } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: args.pr,
    mediaType: { format: "diff" },
  });
  let diff = String(diffData);
  if (diff.length > 120_000) diff = diff.slice(0, 120_000) + "\n… (diff truncated)";

  // Pre-edit baseline for honest regression comparison.
  const stackConfig: StackConfig = validateStackConfig(
    JSON.parse(readFileSync(join(args.repoRoot, ".brewing", "stack.json"), "utf8"))
  );
  console.log("Baseline test run (full suite)…");
  const baseline = runTests(stackConfig, { cwd: args.repoRoot });
  const baselineGreen = new Set(
    baseline.tests.filter((t) => t.status === "passed").map((t) => t.id)
  );

  // The story contract: manifest + cross-suite fold (same as a fresh brew).
  let expectedIds = new Set<string>();
  try {
    const manifest = JSON.parse(
      readFileSync(join(args.repoRoot, ".brewing", "manifests", `story-${storyId}.json`), "utf8")
    ) as { tests: Array<{ id: string; file: string }> };
    const discovery = discoverTests(stackConfig, { cwd: args.repoRoot });
    const folded = foldCrossSuiteTests(manifest.tests, discovery.tests, storyId);
    expectedIds = new Set([...manifest.tests, ...folded].map((t) => t.id));
  } catch {
    /* manifest missing → story set empty; gate still guards regressions */
  }

  const llm = await createLlmClient();
  console.log(`Running brew resubmit agent (model ${args.model}, budget $${args.budgetUsd})…`);
  const outcome = await runResubmitAgent({
    llm,
    model: args.model,
    repoRoot: args.repoRoot,
    userPrompt: buildResubmitUserPrompt({ prNumber: args.pr, storyId, specYaml, diff, feedback, codeMapSlice: null }),
    budgetUsd: args.budgetUsd,
  });

  const postComment = async (body: string): Promise<void> => {
    await octokit.issues.createComment({ owner, repo, issue_number: args.pr, body });
  };
  const header = `### slowcook · brew resubmit\n\n`;
  const costLine = `\n\n<!-- slowcook:cost agent=brew-resubmit usd=${outcome.spendUsd.toFixed(4)} model=${args.model} rounds=${outcome.rounds} -->`;

  if (outcome.editedPaths.length === 0) {
    const note = outcome.escalation
      ? `No safe amendment — the feedback requires a CONTRACT change:\n\n> ${outcome.escalation}\n\ncc: the PM must rule (spec/tests edits are not this agent's to make).`
      : `No amendment made.\n\n${outcome.summary.slice(0, 3000)}`;
    await postComment(header + note + costLine);
    recordAnsweredIds(args.repoRoot, args.pr, consideredIds, ANSWERED_STORE);
    console.log(`No edits (spend $${outcome.spendUsd.toFixed(2)}). Comment posted.`);
    return;
  }

  // Verify: story contract green + fail-closed gate vs the pre-edit baseline.
  console.log(`Agent edited ${outcome.editedPaths.length} file(s). Verifying…`);
  const finalRun = runTests(stackConfig, { cwd: args.repoRoot });
  const verdict = finalGateVerdict(finalRun, expectedIds, baselineGreen);
  if (verdict.kind !== "pass") {
    sh(args.repoRoot, "git checkout -- .");
    const detail =
      verdict.kind === "runner_broken"
        ? `suite runner(s) [${verdict.brokenSuites.join(", ")}] broke: ${verdict.detail.slice(0, 400)}`
        : verdict.kind === "story_red"
          ? `story tests went red: ${verdict.storyRed.slice(0, 3).map((t) => t.id.slice(0, 120)).join("; ")}`
          : `true regressions outside the story: ${verdict.breaks.slice(0, 3).map((t) => t.id.slice(0, 120)).join("; ")}`;
    await postComment(
      header +
        `Amendment REVERTED — verification failed (${verdict.kind}): ${detail}\n\nThe branch is unchanged. The attempted approach:\n\n${outcome.summary.slice(0, 2000)}` +
        costLine
    );
    console.error(`Verification failed (${verdict.kind}) — reverted. Comment posted.`);
    process.exit(1);
  }

  sh(args.repoRoot, `git add -A`);
  sh(
    args.repoRoot,
    `git -c user.name="slowcook-brew[bot]" -c user.email="slowcook-brew@users.noreply.github.com" commit -m ${JSON.stringify(
      `brew: amend story-${storyId} per PR #${args.pr} review\n\n${outcome.editedPaths.map((p) => `- ${p}`).join("\n")}`
    )}`
  );
  sh(args.repoRoot, `git push origin ${JSON.stringify(head)}`);
  await postComment(
    header +
      `Amendment pushed (${outcome.editedPaths.length} file(s): ${outcome.editedPaths.join(", ").slice(0, 400)}).\n\n${outcome.summary.slice(0, 3000)}` +
      (outcome.escalation ? `\n\n⚠️ Partial ESCALATION:\n\n> ${outcome.escalation}` : "") +
      costLine
  );
  recordAnsweredIds(args.repoRoot, args.pr, consideredIds, ANSWERED_STORE);
  console.log(
    `Amendment pushed + verified: story contract green, no regressions (spend $${outcome.spendUsd.toFixed(2)}).`
  );
}
