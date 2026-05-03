/**
 * `slowcook plate --pr <number>` — 0.15.0-α.3.
 *
 * Mirrors `slowcook refine --pr` for the mockup branch. Triggered by
 * `/plate <prose>` PR comments + reviews on a slowcook-mockup PR.
 *
 * α.3 ships without screenshot-attachment vision (text-only feedback).
 * Vision support (PlateImageAttachment) is wired in the prompt + agent
 * but the index doesn't fetch image attachments yet — coming α.3.1.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GitHubAdapter } from "@slowcook-ai/forge-github";
import { parseReviewComment, type ReviewCommentPayload } from "@slowcook-ai/review-overlay";
import { runPlate, type PlateContext } from "./agent.js";
import { writeVibeFiles } from "../vibe/emit.js";
import { classifyComment, type Classification } from "./classify.js";
import type { PlateFeedback } from "./prompts.js";

const APPROVED_LABEL = "slowcook-mockup-approved";

interface PlateArgs {
  prNumber: number;
  repoRoot: string;
  owner?: string;
  repo?: string;
  model: string;
  reviewCommentId?: number;
}

function parseArgs(argv: string[]): PlateArgs {
  const args: PlateArgs = {
    prNumber: -1,
    repoRoot: process.cwd(),
    model: "claude-opus-4-7",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--pr" && next) { args.prNumber = parseInt(next, 10); i++; }
    else if (a === "--cwd" && next) { args.repoRoot = next; i++; }
    else if (a === "--owner" && next) { args.owner = next; i++; }
    else if (a === "--repo" && next) { args.repo = next; i++; }
    else if (a === "--model" && next) { args.model = next; i++; }
    else if (a === "--review-comment-id" && next) { args.reviewCommentId = parseInt(next, 10); i++; }
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  if (!Number.isFinite(args.prNumber) || args.prNumber <= 0) {
    console.error("--pr <number> is required.");
    printHelp();
    process.exit(64);
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook plate — mockup amendment agent (0.15 plate-pipeline α.3)

Reads PR comments + review comments since the last plate commit on a
slowcook-mockup PR; amends mockup files with minimum diff; force-pushes
the same branch. Triggered by \`/plate <prose>\` PR comments.

Usage:
  slowcook plate --pr <number> [--cwd <path>] [--owner <login>] [--repo <name>]
                               [--model <id>] [--review-comment-id <id>]

Options:
  --pr <number>                The mockup PR number. REQUIRED.
  --cwd <path>                 Repo root (default: cwd).
  --owner <login>              GitHub owner (default: detect from git remote).
  --repo <name>                GitHub repo (default: detect from git remote).
  --model <id>                 Anthropic model (default: claude-opus-4-7).
  --review-comment-id <id>     Reply threaded under this inline comment id.

Environment:
  ANTHROPIC_API_KEY            (required) Anthropic API key.
  GITHUB_TOKEN                 (required) for fetching PR comments + force-push.
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
  } catch { /* not a git repo */ }
  return null;
}

function buildProjectContext(repoRoot: string): string {
  // Same shape as vibe's. Kept inline rather than imported to keep the
  // two commands' coupling at the prompt layer only (project-context
  // construction may diverge between vibe and plate later).
  const sections: string[] = [];
  for (const [path, heading, note] of [
    [
      ".brewing/diagrams/schema.mmd",
      "Existing schema (extracted from `supabase/migrations/*.sql`)",
      "Reuse entity names verbatim.",
    ],
    [
      ".brewing/diagrams/tokens.md",
      "Existing design tokens (extracted from `**/*.css`)",
      "Reuse tokens by exact name; do NOT introduce new hex/rgb.",
    ],
    [
      ".brewing/code-map.md",
      "Code-map (existing components, pages, helpers)",
      "Reuse components by import path; never duplicate primitives.",
    ],
  ] as Array<[string, string, string]>) {
    const fp = join(repoRoot, path);
    if (!existsSync(fp)) continue;
    try {
      const c = readFileSync(fp, "utf8").trim();
      sections.push(`## ${heading}\n\n${c}\n\n${note}`);
    } catch { /* skip */ }
  }
  if (sections.length === 0) {
    return "_(No `.brewing/diagrams/` or `.brewing/code-map.md` extracts found. Plate will run blind.)_";
  }
  return sections.join("\n\n---\n\n");
}

interface MinimalPr {
  number: number;
  headBranch: string;
  baseBranch: string;
  labels: string[];
}

function fetchPrMeta(prNumber: number): MinimalPr {
  const json = execSync(
    `gh pr view ${prNumber} --json number,headRefName,baseRefName,labels`,
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
  );
  const parsed = JSON.parse(json) as {
    number: number;
    headRefName: string;
    baseRefName: string;
    labels: Array<{ name: string }>;
  };
  return {
    number: parsed.number,
    headBranch: parsed.headRefName,
    baseBranch: parsed.baseRefName,
    labels: parsed.labels.map((l) => l.name),
  };
}

interface RawComment {
  author: string;
  body: string;
  createdAt: string;
}

interface RawInlineComment extends RawComment {
  path: string;
  line?: number;
}

function fetchTimelineComments(prNumber: number): RawComment[] {
  const json = execSync(
    `gh api repos/{owner}/{repo}/issues/${prNumber}/comments --paginate`,
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
  );
  const arr = JSON.parse(json) as Array<{
    user: { login: string; type: string };
    body: string;
    created_at: string;
  }>;
  return arr
    .filter((c) => c.user.type !== "Bot")
    .map((c) => ({ author: c.user.login, body: c.body, createdAt: c.created_at }));
}

function fetchInlineComments(prNumber: number): RawInlineComment[] {
  const json = execSync(
    `gh api repos/{owner}/{repo}/pulls/${prNumber}/comments --paginate`,
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
  );
  const arr = JSON.parse(json) as Array<{
    user: { login: string; type: string };
    body: string;
    created_at: string;
    path: string;
    line: number | null;
  }>;
  return arr
    .filter((c) => c.user.type !== "Bot")
    .map((c) => ({
      author: c.user.login,
      body: c.body,
      createdAt: c.created_at,
      path: c.path,
      line: c.line ?? undefined,
    }));
}

function lastPlateCommitDate(repoRoot: string, branch: string): string | null {
  try {
    const out = execSync(
      `git -C ${JSON.stringify(repoRoot)} log -1 --format=%aI --author="slowcook-plate\\[bot\\]" ${JSON.stringify(branch)}`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

function listBranchFiles(repoRoot: string, branch: string): Array<{ path: string; contents: string }> {
  // 0.16.0-α.7 → α.14 — files plate amends now live under mock/, not src/.
  // The 0.16 architecture keeps mock + production in separate
  // filesystems; brew + slowcook port handle the src/ side.
  // Vibe writes: mock/scenarios/story-N.ts (always), mock/src/lib/
  // scenario-registry.ts (extends), mock/src/components/.../*.tsx
  // (rarely — only new primitives). Plate amends any of these.
  //
  // 0.16.0-α.14 fix: list ALL paths in the branch and filter in code.
  // Previous version passed `mock/**/*.tsx` as a git ls-tree pathspec,
  // which doesn't expand `**` globs by default. Result was zero matches
  // (caught on rewo PR #147 dogfood). The fix is mechanical: drop the
  // pathspec, list everything, filter via the existing regex predicates.
  // Negligible perf cost on a per-PR branch with O(thousands) of files.
  const out: Array<{ path: string; contents: string }> = [];
  let lsOut: string;
  try {
    lsOut = execSync(
      `git -C ${JSON.stringify(repoRoot)} ls-tree -r --name-only ${JSON.stringify(branch)}`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
  } catch {
    return out;
  }
  for (const line of lsOut.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Only include files vibe writes / plate may amend.
    const isScenario = /^mock\/scenarios\/story-[\w-]+\.ts$/.test(trimmed);
    const isRegistry = trimmed === "mock/src/lib/scenario-registry.ts";
    const isMockComponent = trimmed.startsWith("mock/src/components/") && /\.tsx$/.test(trimmed);
    const isMockPage = /^mock\/src\/app\/.*page\.tsx$/.test(trimmed);
    const isMockLib = trimmed.startsWith("mock/src/lib/") && /\.tsx?$/.test(trimmed);
    if (!isScenario && !isRegistry && !isMockComponent && !isMockPage && !isMockLib) continue;
    try {
      const contents = execSync(
        `git -C ${JSON.stringify(repoRoot)} show ${JSON.stringify(branch + ":" + trimmed)}`,
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      );
      out.push({ path: trimmed, contents });
    } catch { /* skip files git can't show (binary, deleted) */ }
  }
  return out;
}

export async function plate(argv: string[], cliVersion: string): Promise<void> {
  const args = parseArgs(argv);

  const anthropicApiKey = process.env["ANTHROPIC_API_KEY"];
  const githubToken = process.env["GITHUB_TOKEN"];
  if (!anthropicApiKey || !githubToken) {
    console.error("ANTHROPIC_API_KEY + GITHUB_TOKEN environment variables are required.");
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

  const pr = fetchPrMeta(args.prNumber);
  if (!pr.labels.includes("slowcook-mockup")) {
    console.error(
      `PR #${pr.number} is not labeled \`slowcook-mockup\` (labels: ${pr.labels.join(", ")}). plate only acts on mockup PRs.`
    );
    process.exit(2);
  }
  if (!pr.headBranch.startsWith("slowcook/mockup/story-")) {
    console.error(
      `PR #${pr.number} head branch '${pr.headBranch}' doesn't match slowcook/mockup/story-N convention. Refusing to act.`
    );
    process.exit(2);
  }

  // 0.16.0-α.7 — refuse to amend after the PM applied the
  // slowcook-mockup-approved label. A stray review-overlay comment
  // (or accidental /plate) shouldn't bounce a finalized mockup.
  // PM can remove the label to reopen plate iteration.
  if (pr.labels.includes(APPROVED_LABEL)) {
    console.log(
      `PR #${pr.number} carries label \`${APPROVED_LABEL}\`. Plate refuses to amend approved mockups. ` +
        `Remove the label to reopen iteration.`
    );
    return;
  }

  const storyId = pr.headBranch.replace(/^slowcook\/mockup\/story-/, "");

  // Fetch the spec from main (the source of truth).
  execSync(`git -C ${JSON.stringify(args.repoRoot)} fetch origin main`, {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let specYaml = "";
  try {
    specYaml = execSync(
      `git -C ${JSON.stringify(args.repoRoot)} show origin/main:specs/story-${storyId}.yaml`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
  } catch {
    console.error(`Spec for story-${storyId} not found on origin/main. Did the spec PR merge?`);
    process.exit(2);
  }

  // Project context (brownfield + code-map). For plate we need them
  // current — extract first.
  console.log("Refreshing brownfield extracts + code-map...");
  try {
    execSync(`node ${JSON.stringify(process.argv[1]!)} extract`, {
      cwd: args.repoRoot,
      stdio: "inherit",
    });
    execSync(`node ${JSON.stringify(process.argv[1]!)} map generate`, {
      cwd: args.repoRoot,
      stdio: "inherit",
    });
  } catch (e) {
    console.warn(`extract/map refresh failed (${(e as Error).message}); plate will use stale or empty context.`);
  }
  const projectContext = buildProjectContext(args.repoRoot);

  // Fetch + checkout the mockup branch into the working tree.
  execSync(
    `git -C ${JSON.stringify(args.repoRoot)} fetch origin ${JSON.stringify(pr.headBranch)}`,
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  execSync(
    `git -C ${JSON.stringify(args.repoRoot)} checkout ${JSON.stringify(pr.headBranch)}`,
    { stdio: ["ignore", "ignore", "pipe"] }
  );

  // Read the current mockup files.
  const currentFiles = listBranchFiles(args.repoRoot, pr.headBranch);
  console.log(`Loaded ${currentFiles.length} mockup file(s) from branch ${pr.headBranch}.`);

  // Fetch PM feedback. For α.3 we include EVERYTHING since the PR was
  // opened (no since-last-plate-commit cutoff). Idempotent enough for
  // single iterations; α.3.1 adds the cutoff.
  const cutoffDate = lastPlateCommitDate(args.repoRoot, pr.headBranch);
  if (cutoffDate) {
    console.log(`Filtering feedback to comments newer than last plate commit at ${cutoffDate}.`);
  }
  const filterByDate = (c: { createdAt: string }): boolean =>
    cutoffDate ? c.createdAt > cutoffDate : true;

  const rawTimeline = fetchTimelineComments(pr.number).filter(filterByDate);
  const inlineComments = fetchInlineComments(pr.number).filter(filterByDate);

  // 0.16.0-α.7 — split timeline comments into review-overlay (structured,
  // classified) vs free-prose (unstructured, treated as before).
  const overlayComments: Array<{
    payload: ReviewCommentPayload;
    classification: Classification;
    rationale: string;
    matchedSpecTerms: string[];
    raw: { author: string; body: string; createdAt: string };
  }> = [];
  const proseTimeline: Array<{ author: string; body: string; createdAt: string }> = [];
  for (const c of rawTimeline) {
    const payload = parseReviewComment(c.body);
    if (payload) {
      const cls = classifyComment({ prose: payload.prose, specYaml });
      overlayComments.push({
        payload,
        classification: cls.classification,
        rationale: cls.rationale,
        matchedSpecTerms: cls.matchedSpecTerms,
        raw: c,
      });
    } else {
      proseTimeline.push(c);
    }
  }

  const specAltering = overlayComments.filter((o) => o.classification === "spec-altering");
  const cosmeticOrDivergent = overlayComments.filter(
    (o) => o.classification !== "spec-altering"
  );

  console.log(
    `Feedback to act on: ${proseTimeline.length} prose comment(s), ${overlayComments.length} review-overlay comment(s) ` +
      `(${cosmeticOrDivergent.length} amendable, ${specAltering.length} spec-altering — escalating), ` +
      `${inlineComments.length} inline comment(s).`
  );

  // 0.16.0-α.7 — for each spec-altering comment, post an escalation
  // reply on the PR and EXCLUDE it from the agent's feedback. The PM
  // can confirm via /plate confirm-spec-change (handled in α.7.1)
  // OR via amending the spec PR upstream.
  if (specAltering.length > 0) {
    const githubAdapter = new GitHubAdapter({ owner, repo, token: githubToken });
    for (const sa of specAltering) {
      await githubAdapter.createIssueComment(
        pr.number,
        buildEscalationBody(sa, cliVersion)
      );
    }
    console.log(
      `Posted ${specAltering.length} escalation reply/replies for spec-altering comments. They will NOT influence this plate amendment.`
    );
  }

  // For mock-divergence + cosmetic, render their structured prose into
  // the timeline-comment shape the agent already understands. The
  // classification rationale becomes a hint the agent sees in context.
  const classifiedTimelineForAgent: Array<{ author: string; body: string; createdAt: string }> = [
    ...proseTimeline,
    ...cosmeticOrDivergent.map((o) => ({
      author: o.raw.author,
      body:
        `[${o.classification}] selector \`${o.payload.element.selector}\` (${o.payload.element.tag}` +
        `${o.payload.element.text_hint ? ` · "${o.payload.element.text_hint}"` : ""}):\n\n` +
        o.payload.prose +
        `\n\n_(Plate classifier: ${o.rationale})_`,
      createdAt: o.raw.createdAt,
    })),
  ];

  const feedback: PlateFeedback = {
    timelineComments: classifiedTimelineForAgent,
    inlineComments,
    screenshots: [], // α.3.1 / α.7.x will populate from comment attachments
  };

  if (
    feedback.timelineComments.length === 0 &&
    feedback.inlineComments.length === 0
  ) {
    if (specAltering.length > 0) {
      console.log("Only spec-altering feedback present — escalations posted; no amendment to make.");
    } else {
      console.log("Nothing to amend. Exiting cleanly.");
    }
    return;
  }

  const ctx: PlateContext = {
    repoRoot: args.repoRoot,
    anthropicApiKey,
    model: args.model,
    storyId,
    prNumber: pr.number,
    cliVersion,
    projectContext,
    specYaml,
    currentFiles,
    feedback,
  };

  console.log(`Running plate (model: ${args.model})...`);
  const result = await runPlate(ctx);

  if (result.kind === "format-failure") {
    console.error(`Plate emitted no parseable output. Spend: $${result.spendUsd.toFixed(4)}.`);
    if (process.env["SLOWCOOK_DEBUG"]) {
      console.error("\n--- agent's final text ---\n");
      console.error(result.finalText);
    }
    process.exit(1);
  }

  const forge = new GitHubAdapter({ owner, repo, token: githubToken });

  if (result.kind === "no-op") {
    console.log(`Plate decided not to amend (spend $${result.spendUsd.toFixed(4)}). Posting summary as PR reply.`);
    await forge.createIssueComment(pr.number, plateReplyBody(result.summary, result.spendUsd, cliVersion, []));
    return;
  }

  // Amended: write files + commit + force-push.
  console.log(
    `Plate amended ${result.files.length} file(s) (spend $${result.spendUsd.toFixed(4)}). Writing + committing.`
  );
  const written = writeVibeFiles(args.repoRoot, result.files);

  // Configure git identity.
  try {
    execSync(`git -C ${JSON.stringify(args.repoRoot)} config user.name "slowcook-plate[bot]"`);
    execSync(`git -C ${JSON.stringify(args.repoRoot)} config user.email "slowcook-plate@users.noreply.github.com"`);
  } catch { /* assume parent already configured */ }

  for (const p of written) await forge.git.stage(p);

  if (forge.git.hasStagedChanges) {
    const changed = await forge.git.hasStagedChanges();
    if (!changed) {
      console.log("No-op amendment (re-emitted byte-identical files). Posting note instead of commit.");
      await forge.createIssueComment(
        pr.number,
        plateReplyBody(
          `${result.summary}\n\n_(plate produced byte-identical files — no commit. Re-comment with sharper feedback if you wanted a change.)_`,
          result.spendUsd,
          cliVersion,
          result.changeRequests.map((cr) => ({ component: cr.component, path: cr.path, rationale: cr.rationale }))
        )
      );
      return;
    }
  }

  await forge.git.commit(
    `plate: amend story-${storyId} mockup per PR #${pr.number} feedback\n\nGenerated by slowcook plate@${cliVersion}.\n`
  );
  // Force-push: the mockup branch is plate's working state and may be
  // amended repeatedly across iterations. Same shape as refine's
  // amendment force-push pattern.
  execSync(
    `git -C ${JSON.stringify(args.repoRoot)} push --force-with-lease origin ${JSON.stringify(pr.headBranch)}`,
    { stdio: "inherit" }
  );

  await forge.createIssueComment(
    pr.number,
    plateReplyBody(
      result.summary,
      result.spendUsd,
      cliVersion,
      result.changeRequests.map((cr) => ({ component: cr.component, path: cr.path, rationale: cr.rationale }))
    )
  );
  console.log(`Plate amendment pushed + summary posted on PR #${pr.number}.`);
}

/**
 * 0.16.0-α.7 — build the escalation reply for a spec-altering review-
 * overlay comment. The PM either:
 *   (a) confirms via /plate confirm-spec-change → α.7.1+ (TODO)
 *   (b) amends the spec via /refine on the spec PR upstream
 *   (c) discards via /plate keep-spec
 *
 * Until α.7.1 lands, options (a) + (c) are advisory; option (b) is
 * the working path. The PM must amend the spec, re-merge, and the
 * mockup PR's vibe will get the new spec on next iteration.
 */
function buildEscalationBody(
  sa: {
    payload: { element: { selector: string; tag: string; text_hint: string | null }; prose: string };
    rationale: string;
    matchedSpecTerms: string[];
  },
  cliVersion: string
): string {
  const lines: string[] = [];
  lines.push("### slowcook · plate · spec-altering feedback (escalated)");
  lines.push("");
  lines.push(
    `Plate classified the previous review-overlay comment on \`${sa.payload.element.selector}\` ` +
      `as **spec-altering** and is NOT amending the mock for it. The reasoning:`
  );
  lines.push("");
  lines.push(`> ${sa.rationale}`);
  if (sa.matchedSpecTerms.length > 0) {
    lines.push("");
    lines.push(
      `Matched spec terms: ${sa.matchedSpecTerms.map((t) => `\`${t}\``).join(", ")}`
    );
  }
  lines.push("");
  lines.push("**To proceed, choose one:**");
  lines.push("");
  lines.push(
    `- **Amend the spec** (recommended): \`/refine\` on the spec PR upstream and the next mockup iteration picks up the new contract.`
  );
  lines.push(
    `- **Keep the spec, discard this comment**: comment \`/plate keep-spec\` and plate will skip this on the next iteration.`
  );
  lines.push(
    `- **Confirm the spec change inline**: comment \`/plate confirm-spec-change\` (lands in α.7.1; until then use the spec PR path).`
  );
  lines.push("");
  lines.push(
    `<!-- slowcook:cost agent=plate type=escalation cli=${cliVersion} -->`
  );
  return lines.join("\n");
}

function plateReplyBody(
  summary: string,
  spendUsd: number,
  cliVersion: string,
  changeRequests: Array<{ component: string; path: string; rationale: string }>
): string {
  const parts: string[] = [];
  parts.push("### slowcook · plate amendment");
  parts.push("");
  parts.push(summary);
  if (changeRequests.length > 0) {
    parts.push("");
    parts.push("#### Component-change requests surfaced");
    parts.push("");
    parts.push(
      "These structural changes to existing primitives need PM approval before plate can apply them. Comment / amend the spec to authorize:"
    );
    parts.push("");
    for (const cr of changeRequests) {
      parts.push(`- **\`${cr.component}\`** (\`${cr.path}\`)`);
      parts.push("");
      parts.push(`  ${cr.rationale.replace(/\n/g, "\n  ")}`);
      parts.push("");
    }
  }
  parts.push("");
  parts.push(
    `<!-- slowcook:cost agent=plate usd=${spendUsd.toFixed(4)} model=claude-opus-4-7 cli=${cliVersion} -->`
  );
  return parts.join("\n");
}
