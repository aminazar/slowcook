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
import { truncatedEmissionError } from "../../lib/emission-guard.js";
import { appendAuthored, triggerFromEnv } from "../../lib/provenance.js";
import { parseStoryBranch } from "../../lib/story-branch.js";

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
export function parseFileBlocks(
  text: string,
  opts?: { allowStubPaths?: string[]; allowRoots?: string[] }
): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  const re = /<file path="([^"]+)">\n?([\s\S]*?)<\/file>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const path = m[1]!.trim();
    if (path.includes("..")) continue;
    // Writes are confined to the tests tree — PLUS the throwing stubs
    // testgen itself authored (marker-verified by the caller), PLUS any
    // declared suite roots (2026-08-23: taste demanded pgTAP tests under
    // supabase/tests/ that this guard forbade — a structural dead-end
    // where the reviewer requires what the author may not write; a human
    // had to author the db suite by hand).
    const allowed =
      path.startsWith("tests/") ||
      (opts?.allowStubPaths ?? []).includes(path) ||
      (opts?.allowRoots ?? []).some((r) => path.startsWith(r));
    if (!allowed) continue;
    out.push({ path, content: (m[2] ?? "").replace(/\n?$/, "\n") });
  }
  return out;
}


/**
 * Directory roots of declared test suites, derived from each suite's
 * discover_command (path-ish tokens containing "/"). Lets resubmit write
 * db-tier tests (e.g. supabase/tests/database/) that its reviewer can
 * demand — writes stay confined to DECLARED suite homes, never src/.
 */
export function suiteWriteRoots(stackJson: unknown): string[] {
  const roots = new Set<string>();
  const test = (stackJson as { test?: Record<string, { discover_command?: string }> } | null)?.test;
  for (const suite of Object.values(test ?? {})) {
    for (const tok of (suite.discover_command ?? "").split(/\s+/)) {
      if (!tok.includes("/") || tok.startsWith("-") || tok.includes("..")) continue;
      const dir = tok.replace(/\/[^/]*[*?][^/]*$/, "/");
      if (dir.includes("*") || dir.includes("?")) continue;
      if (dir.startsWith("/") || dir.startsWith("src/")) continue;
      roots.add(dir.endsWith("/") ? dir : dir.replace(/\/[^/]+$/, "/"));
    }
  }
  return [...roots];
}

const DISCOVERY_GATE_MARKER = "slowcook-discovery-gate";

/** Own chatter is not feedback — EXCEPT discovery-gate errors, which are
 *  written precisely so the next round can fix them (G19: excluding them
 *  made the model repeat the same bare import blind, twice). */
export function isFeedbackComment(body: string): boolean {
  return !body.startsWith("### slowcook ·") || body.includes(DISCOVERY_GATE_MARKER);
}

/** Record the story manifest; returns null on success or the error tail. */
function recordManifest(ctx: TestsResubmitContext, storyId: string): string | null {
  try {
    execSync(
      `${JSON.stringify(process.execPath)} ${JSON.stringify(process.argv[1] ?? "slowcook")} manifest record --story ${storyId} --cwd ${JSON.stringify(ctx.repoRoot)}`,
      { cwd: ctx.repoRoot, stdio: ["ignore", "pipe", "pipe"] }
    );
    return null;
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; message?: string };
    const tail = [err.stdout?.toString() ?? "", err.stderr?.toString() ?? ""]
      .join("\n")
      // eslint-disable-next-line no-control-regex
      .replace(/\[[0-9;]*m/g, "")
      .split("\n")
      .filter((l) => l.trim())
      .slice(-15)
      .join("\n");
    return tail || err.message || "manifest record failed";
  }
}

export async function runTestsResubmit(ctx: TestsResubmitContext): Promise<void> {
  const octokit = new Octokit({ auth: ctx.token, userAgent: "slowcook-ai/cli recipe-resubmit" });
  const { data: pr } = await octokit.pulls.get({
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: ctx.prNumber,
  });
  const branch = pr.head?.ref ?? "";
  const storyId = parseStoryBranch(branch)?.kind === "tests" ? parseStoryBranch(branch)!.storyId : undefined;
  if (!storyId) {
    console.log(`Noop: PR #${ctx.prNumber} head "${branch}" is not a slowcook tests branch.`);
    return;
  }

  // Checkout must MATCH the PR (G9) — fail closed on dirt.
  // Modified tracked files = real uncommitted work → hard stop. Untracked
  // files are branch-switch residue (G11) — reset --hard below handles the
  // tracked tree, and residue never enters our commits (we add tests/ and
  // manifests only).
  const dirty = execSync("git status --porcelain", { cwd: ctx.repoRoot, encoding: "utf8" })
    .split("\n")
    .filter(
      (l) => l.trim() && !l.startsWith("??") && !l.includes(".brewing/history-index") && !l.includes(".brewing/local/")
    );
  if (dirty.length > 0) {
    console.error(`slowcook recipe: checkout has uncommitted changes — refusing.`);
    process.exit(2);
  }
  execSync(`git fetch origin ${branch}`, { cwd: ctx.repoRoot });
  execSync(`git checkout ${branch}`, { cwd: ctx.repoRoot, stdio: ["ignore", "ignore", "pipe"] });
  execSync(`git reset --hard origin/${branch}`, { cwd: ctx.repoRoot });

  // Feedback: timeline comments (taste findings live here) + human inline.
  const [{ data: comments }, { data: files }, { data: inline }, { data: reviews }] =
    await Promise.all([
      octokit.issues.listComments({ owner: ctx.owner, repo: ctx.repo, issue_number: ctx.prNumber, per_page: 100 }),
      octokit.pulls.listFiles({ owner: ctx.owner, repo: ctx.repo, pull_number: ctx.prNumber, per_page: 100 }),
      octokit.pulls.listReviewComments({ owner: ctx.owner, repo: ctx.repo, pull_number: ctx.prNumber, per_page: 100 }),
      octokit.pulls.listReviews({ owner: ctx.owner, repo: ctx.repo, pull_number: ctx.prNumber, per_page: 100 }),
    ]);
  const feedback = [
    // Review BODIES are feedback too (taste's verdicts live here) —
    // exclude drafts (author-only) and this agent's own replies.
    ...reviews
      .filter(
        (r) =>
          r.state !== "PENDING" &&
          (r.body ?? "").trim() &&
          !(r.body ?? "").startsWith("### slowcook · recipe")
      )
      .slice(-4)
      .map((r) => `## Review by @${r.user?.login} (${r.state}) at ${r.submitted_at}\n${r.body}`),
    ...comments
      .filter((c) => isFeedbackComment(c.body ?? ""))
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

  const testPaths = files
    .map((f) => f.filename)
    .filter(
      (f) =>
        f.startsWith("tests/") ||
        (f.startsWith("src/") &&
          (() => {
            try {
              return readFileSync(join(ctx.repoRoot, f), "utf8")
                .split("\n")[0]!
                .includes("@slowcook-stub");
            } catch {
              return false;
            }
          })())
    );
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
    // From origin/<base>, NEVER the branch worktree (ledger G26 family):
    // this checkout is on the PR branch, whose spec predates amendments —
    // the author would argue from a fossil constitution while the
    // reviewer (fixed in G26) reads the real one.
    const baseRef = pr.base?.ref ?? "main";
    specYaml = execSync(`git show origin/${baseRef}:specs/story-${storyId}.yaml`, {
      cwd: ctx.repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    try {
      specYaml = readFileSync(join(ctx.repoRoot, "specs", `story-${storyId}.yaml`), "utf8");
    } catch {
      /* spec context best-effort */
    }
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
  {
    const cut = truncatedEmissionError(response, `recipe resubmit story-${storyId}`);
    if (cut) {
      console.error(cut);
      process.exit(2);
    }
  }

  const noChange = response.text.match(/^NO_CHANGES\s+(.*)$/m)?.[1];
  if (noChange) {
    // Even with no test-file change, the MANIFEST may be the stale artifact
    // (G12's second face: the model can only emit test files, and correctly
    // says so). Re-record it; a resulting diff is a manifest-only amendment.
    const noChangeDiscoveryError = recordManifest(ctx, storyId);
    if (noChangeDiscoveryError) {
      const priorGate = comments.some((c) => (c.body ?? "").includes(DISCOVERY_GATE_MARKER));
      await octokit.issues.createComment({
        owner: ctx.owner,
        repo: ctx.repo,
        issue_number: ctx.prNumber,
        body:
          `### slowcook · recipe resubmit <!-- ${DISCOVERY_GATE_MARKER} -->\n\n` +
          `🛑 Test discovery fails on this branch:\n\n\`\`\`\n${noChangeDiscoveryError}\n\`\`\`` +
          (priorGate ? `\n\nSecond consecutive discovery failure — stopping; a human should look.` : ""),
      });
      if (priorGate) {
        console.error("slowcook recipe: second consecutive discovery failure — terminal.");
        process.exit(2);
      }
      console.log("Noop: discovery fails on the branch — error posted as feedback.");
      return;
    }
    const manifestDirty = execSync("git status --porcelain -- .brewing/manifests", {
      cwd: ctx.repoRoot,
      encoding: "utf8",
    }).trim();
    if (manifestDirty) {
      execSync(`git add .brewing/manifests/`, { cwd: ctx.repoRoot });
      execSync(
        `git -c user.name="slowcook" -c user.email="agents@slowcook.dev" commit -m "recipe: re-record story-${storyId} manifest per PR #${ctx.prNumber} review"`,
        { cwd: ctx.repoRoot }
      );
      execSync(`git push origin ${branch}`, { cwd: ctx.repoRoot });
      await octokit.issues.createComment({
        owner: ctx.owner,
        repo: ctx.repo,
        issue_number: ctx.prNumber,
        body: `### slowcook · recipe resubmit\n\nNo test-file change warranted (${noChange}) — but the manifest was stale; re-recorded and pushed so every test file is part of the green gate.`,
      });
      console.log(`Tests amended: manifest-only`);
      console.log(`Pushed to branch ${branch}.`);
      return;
    }
    await octokit.issues.createComment({
      owner: ctx.owner,
      repo: ctx.repo,
      issue_number: ctx.prNumber,
      body: `### slowcook · recipe resubmit\n\nReviewed the feedback; no test change warranted: ${noChange}`,
    });
    console.log(`Noop: model judged no change warranted (${noChange}).`);
    return;
  }
  // Stub files this PR carries (testgen's own artifacts): src/ files whose
  // first line bears the @slowcook-stub marker are amendable too.
  const stubPaths = files
    .map((f) => f.filename)
    .filter((f) => f.startsWith("src/"))
    .filter((f) => {
      try {
        return readFileSync(join(ctx.repoRoot, f), "utf8").split("\n")[0]!.includes("@slowcook-stub");
      } catch {
        return false;
      }
    });
  let allowRoots: string[] = [];
  try {
    allowRoots = suiteWriteRoots(
      JSON.parse(readFileSync(join(ctx.repoRoot, ".brewing", "stack.json"), "utf8"))
    );
  } catch { /* no stack.json → tests/ only, as before */ }
  const blocks = parseFileBlocks(response.text, { allowStubPaths: stubPaths, allowRoots });
  if (blocks.length === 0) {
    console.error("slowcook recipe: no parseable file blocks in the amendment — failing closed.");
    process.exit(2);
  }
  for (const b of blocks) {
    const abs = join(ctx.repoRoot, b.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, b.content, "utf8");
  }
  // The manifest IS the green gate (ledger G12): an amendment that adds or
  // renames tests without re-recording the manifest leaves those tests
  // unenforced by the ratchet — taste rightly blocks the merge. Re-record
  // as part of every amendment so the commit carries file+manifest together.
  // A DISCOVERY failure means the amendment itself is broken (e.g. a bare
  // import of a not-yet-implemented module): revert it, feed the exact
  // error back to the PR, and hard-stop on the second consecutive failure
  // — never crash-loop, never push undiscoverable tests.
  const discoveryError = recordManifest(ctx, storyId);
  if (discoveryError) {
    execSync(`git checkout -- tests/ .brewing/manifests/ 2>/dev/null || true`, {
      cwd: ctx.repoRoot,
      shell: "/bin/bash",
    });
    const priorGate = comments.some((c) => (c.body ?? "").includes(DISCOVERY_GATE_MARKER));
    await octokit.issues.createComment({
      owner: ctx.owner,
      repo: ctx.repo,
      issue_number: ctx.prNumber,
      body:
        `### slowcook · recipe resubmit <!-- ${DISCOVERY_GATE_MARKER} -->\n\n` +
        `🛑 The amendment failed **test discovery** and was reverted — undiscoverable tests can gate nothing:\n\n` +
        `\`\`\`\n${discoveryError}\n\`\`\`\n\n` +
        (priorGate
          ? `This is the second consecutive discovery failure — stopping; a human should look.`
          : `The next amendment round sees this error and must fix the discovery break (use the committed throwing-stub pattern, never a bare import of a module brew hasn't created).`),
    });
    if (priorGate) {
      console.error("slowcook recipe: second consecutive discovery failure — terminal.");
      process.exit(2);
    }
    console.log(`Noop: amendment failed discovery — reverted; error posted as feedback.`);
    return;
  }
  // Provenance: review-derived amendment — the entry rides the same
  // commit as the amended tests (ratchet-adoption "producers").
  try {
    const ledgerRel = appendAuthored(ctx.repoRoot, {
      agent: "recipe",
      files: blocks.map((b) => b.path),
      derived: triggerFromEnv() ?? {
        reason: "(derived) tests-pr-review",
        evidence: `feedback on PR #${ctx.prNumber}`,
      },
    });
    execSync(`git add ${ledgerRel}`, { cwd: ctx.repoRoot });
  } catch (e) {
    console.warn(`[recipe resubmit] provenance entry not written: ${(e as Error).message}`);
  }
  execSync(`git add tests/ .brewing/manifests/`, { cwd: ctx.repoRoot });
  // Amended stub files must ride the same commit (G26c: they were
  // written but never staged — the fix silently stayed in the worktree).
  for (const sp of blocks.map((b) => b.path).filter((p2) => p2.startsWith("src/"))) {
    execSync(`git add ${JSON.stringify(sp)}`, { cwd: ctx.repoRoot });
  }
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
