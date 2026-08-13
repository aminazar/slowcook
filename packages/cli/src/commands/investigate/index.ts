/**
 * `slowcook investigate` — bug-flow analogue of refine.
 *
 * Reads a GitHub issue (label: `bug`), uses code tools to find the
 * failure locus, emits `.brewing/bug-profiles/B-<id>.yaml` and opens
 * a PR proposing the profile. The PR's merge triggers
 * `slowcook-recipe-regression.yml` (alpha.3) which kicks off
 * `recipe --regression` to write the failing test.
 *
 * **Status**: alpha.2a — scaffold only. Parses args, prints what it
 * WOULD do. Real LLM agent + PR opening land in alpha.2b. Calling the
 * command today exits with a clear "not yet implemented" notice so
 * accidental wiring (e.g., a workflow trigger) fails fast and visibly.
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { GitHubAdapter } from "@slowcook-ai/forge-github";
import {
  validateBugProfile,
  type BugProfile,
  BUG_PROFILE_SCHEMA_VERSION,
} from "./schema.js";
import { runInvestigation } from "./agent.js";
import { resolveModel } from "../../lib/model-defaults.js";

interface InvestigateArgs {
  issueNumber: number;
  repoRoot: string;
  /** Dry-run: print the would-be profile to stdout, don't write files / open PR. */
  dryRun: boolean;
  /** Skip the LLM agent + emit a stub profile (alpha.2a behaviour, kept for testing). */
  stub: boolean;
  /** LLM model to use. Default opus-4-7 — investigate is one-shot per bug. */
  model: string;
  /** Skip PR opening even on the real path; write profile to disk only. */
  noPr: boolean;
  /** Forge owner/repo (auto-detected from git remote when omitted). */
  owner?: string;
  repo?: string;
}

function parseArgs(argv: string[]): InvestigateArgs {
  const args: InvestigateArgs = {
    issueNumber: 0,
    repoRoot: process.cwd(),
    dryRun: false,
    stub: false,
    model: resolveModel("investigate"),
    noPr: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if ((arg === "--issue" || arg === "-i") && next) {
      args.issueNumber = parseInt(next, 10);
      i++;
    } else if (arg === "--cwd" && next) {
      args.repoRoot = next;
      i++;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--stub") {
      args.stub = true;
    } else if (arg === "--no-pr") {
      args.noPr = true;
    } else if (arg === "--owner" && next) {
      args.owner = next;
      i++;
    } else if (arg === "--repo" && next) {
      args.repo = next;
      i++;
    } else if (arg === "--model" && next) {
      args.model = next;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook investigate — diagnose a bug from a GitHub issue and emit a bug-profile.

Usage:
  slowcook investigate --issue <number> [--cwd <path>] [--model <id>] [--dry-run] [--stub]

Status: alpha.2b — real LLM agent integration. PR opening (auto-branch
+ push + PR open) lands in alpha.2c. Today: writes the bug-profile to
.brewing/bug-profiles/B-<n>.yaml.

What it does:
  1. Fetches issue #<number> body + prior comments via gh
  2. Runs an LLM agent loop with read-only code tools
     (read_file, outline_file, list_directory, find_references,
      find_definition, grep)
  3. Validates the agent's <bug_profile> output against the schema
     (schema_version ${BUG_PROFILE_SCHEMA_VERSION})
  4. Writes .brewing/bug-profiles/B-<n>.yaml

Flags:
  --issue <n>     GitHub issue number (required).
  --cwd <path>    Repo root (default: cwd).
  --model <id>    LLM model. Default: the investigate stage model.
  --dry-run       Print profile + agent stats, don't write to disk.
  --stub          Emit a stub profile without calling the LLM (alpha.2a
                  behaviour; useful for testing the file layout).

Environment:
  ANTHROPIC_API_KEY  Required unless --stub. The agent makes Anthropic
                     API calls; cost varies by model + bug complexity
                     ($0.05–$0.50 typical for opus, $0.01–$0.10 for sonnet).
  GITHUB_TOKEN       Required to fetch the issue body via gh CLI.
                     Falls back to gh's auth if unset.
`);
}

/**
 * Pick the next free bug-id by walking `.brewing/bug-profiles/`
 * (and once branches exist, also \`slowcook/bug-profile/B-*\`). Same
 * race-aware pattern as story-id assignment (slowcook#8 fix).
 *
 * Exposed for use by alpha.2b once the agent emits real profiles.
 */
export function pickNextBugId(repoRoot: string): string {
  const dir = join(repoRoot, ".brewing/bug-profiles");
  let max = 0;
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      const m = entry.match(/^B-(\d+)\.ya?ml$/);
      if (m) {
        const n = parseInt(m[1] ?? "0", 10);
        if (n > max) max = n;
      }
    }
  }
  return `B-${max + 1}`;
}

/**
 * Build a stub bug profile from issue metadata only — no code reading.
 * alpha.2a placeholder. alpha.2b replaces this with an LLM-driven
 * agent that actually investigates.
 */
export function buildStubProfile(args: {
  issueNumber: number;
  issueTitle: string;
  bugId: string;
  cliVersion: string;
  now: Date;
}): BugProfile {
  return {
    schema_version: BUG_PROFILE_SCHEMA_VERSION,
    bug_id: args.bugId,
    title: args.issueTitle,
    source_issue: `#${args.issueNumber}`,
    status: "investigated",
    investigated_by: `slowcook-investigate@${args.cliVersion}-stub`,
    created_at: args.now.toISOString(),
    symptom: ["(not yet investigated — alpha.2a stub)"],
    expected: ["(not yet investigated — alpha.2a stub)"],
    reproduction: ["(not yet investigated — alpha.2a stub)"],
    failure_locus: {
      file: "(unknown)",
      diagnosis: "Stub profile emitted by alpha.2a scaffold. Real investigation lands in alpha.2b.",
    },
    regression_assertion: ["(not yet investigated — alpha.2a stub)"],
    fix_scope: [],
  };
}

export async function investigate(
  argv: string[],
  cliVersion: string
): Promise<void> {
  const args = parseArgs(argv);
  if (!args.issueNumber || isNaN(args.issueNumber)) {
    console.error("slowcook investigate: --issue <number> is required");
    printHelp();
    process.exit(64);
  }

  const bugId = pickNextBugId(args.repoRoot);
  const now = new Date();

  // ---- Stub path (alpha.2a-style; kept for testing without API key) ----
  if (args.stub) {
    console.error(
      `slowcook investigate (${cliVersion}) — --stub mode. No LLM call; emitting placeholder profile.`
    );
    const profile = buildStubProfile({
      issueNumber: args.issueNumber,
      issueTitle: `(issue #${args.issueNumber})`,
      bugId,
      cliVersion,
      now,
    });
    return finaliseProfile(profile, args, bugId, cliVersion);
  }

  // ---- Real agent path (alpha.2b) ----
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    console.error(
      "slowcook investigate: ANTHROPIC_API_KEY is required (or use --stub for placeholder)"
    );
    process.exit(78);
  }

  console.error(
    `slowcook investigate (${cliVersion}) — issue #${args.issueNumber}, model ${args.model}, bug-id ${bugId}.`
  );
  console.error(`Fetching issue from GitHub…`);
  const issue = fetchIssueViaGh(args.issueNumber, args.repoRoot);

  console.error(`Running investigation agent (read-only tools, max 12 rounds)…`);
  const result = await runInvestigation({
    repoRoot: args.repoRoot,
    anthropicApiKey: apiKey,
    model: args.model,
    bugId,
    cliVersion,
    issue,
    now: () => now,
  });

  console.error(
    `Agent done: ${result.rounds} round(s), $${result.spendUsd.toFixed(4)} spent${result.halted ? ` (HALTED: ${result.haltReason})` : ""}.`
  );

  return finaliseProfile(result.profile, args, bugId, cliVersion);
}

async function finaliseProfile(
  profile: BugProfile,
  args: InvestigateArgs,
  bugId: string,
  cliVersion: string
): Promise<void> {
  const validation = validateBugProfile(profile);
  if (!validation.ok) {
    console.error(`slowcook investigate: profile failed validation:`);
    for (const e of validation.errors) console.error(`  - ${e}`);
    process.exit(70);
  }

  if (args.dryRun) {
    console.log(renderProfileAsYaml(validation.profile));
    console.error("\n(dry-run: not writing to disk)");
    process.exit(0);
  }

  const relPath = `.brewing/bug-profiles/${bugId}.yaml`;
  const fullPath = join(args.repoRoot, relPath);
  mkdirSync(join(args.repoRoot, ".brewing/bug-profiles"), { recursive: true });
  writeFileSync(fullPath, renderProfileAsYaml(validation.profile), "utf8");
  console.error(`Wrote ${relPath}.`);

  if (args.noPr) {
    console.error(
      `Next: review the profile, then 'slowcook recipe --regression --bug ${bugId}' (alpha.3) to emit the regression test.`
    );
    process.exit(0);
  }

  // 0.13.0-alpha.5a — open the bug-profile PR. Mirrors the refine
  // pattern: branch off main, commit the YAML, push, open PR.
  await openBugProfilePr({
    repoRoot: args.repoRoot,
    bugId,
    profile: validation.profile,
    relPath,
    owner: args.owner,
    repo: args.repo,
    cliVersion,
  });
}

interface OpenBugProfilePrArgs {
  repoRoot: string;
  bugId: string;
  profile: BugProfile;
  relPath: string;
  owner?: string;
  repo?: string;
  cliVersion: string;
}

async function openBugProfilePr(args: OpenBugProfilePrArgs): Promise<void> {
  const githubToken = process.env["GITHUB_TOKEN"];
  if (!githubToken) {
    console.error(
      "GITHUB_TOKEN not set — bug profile written to disk but PR not opened. Re-run with --no-pr to suppress this notice, or set the token."
    );
    process.exit(0);
  }

  const detected = detectOwnerRepo(args.repoRoot);
  const owner = args.owner ?? detected?.owner;
  const repo = args.repo ?? detected?.repo;
  if (!owner || !repo) {
    console.error(
      "Could not detect owner/repo from git remote — pass --owner + --repo explicitly."
    );
    process.exit(2);
  }

  const branch = `slowcook/bug-profile/${args.bugId}`;
  const forge = new GitHubAdapter({ owner, repo, token: githubToken });

  try {
    await forge.git.createBranch(branch);
    await forge.git.stage(args.relPath);
    // forge git op author identity is configured by the caller (workflow
    // step) — see slowcook-investigate.yml's `git config user.*` step.
    await forge.git.commit(
      `slowcook: bug profile ${args.bugId} (from issue ${args.profile.source_issue})`
    );
    await forge.git.push(branch);
  } catch (e) {
    console.error(
      `Failed to push branch ${branch}: ${(e as Error).message}\n  Profile is at ${args.relPath} on disk; open the PR manually if you'd like.`
    );
    process.exit(0);
  }

  try {
    const pr = await forge.createPullRequest({
      title: `bug profile: ${args.bugId} — ${args.profile.title}`,
      body: buildBugProfilePrBody(args.profile, args.cliVersion),
      base: "main",
      head: branch,
      draft: false,
      labels: ["slowcook-bug-profile", "bug"],
    });
    console.error(`Opened PR ${pr.url}.`);
    console.error(
      `Next: review the bug-profile PR, merge to trigger 'slowcook recipe --regression' on this bug.`
    );
  } catch (e) {
    console.error(
      `Pushed branch ${branch} but couldn't open PR: ${(e as Error).message}\n  Open it manually at https://github.com/${owner}/${repo}/pull/new/${branch}`
    );
    process.exit(0);
  }
}

function detectOwnerRepo(repoRoot: string): { owner: string; repo: string } | null {
  try {
    const url = execSync("git remote get-url origin", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (m && m[1] && m[2]) return { owner: m[1], repo: m[2] };
  } catch {
    /* not a git repo */
  }
  return null;
}

function buildBugProfilePrBody(profile: BugProfile, cliVersion: string): string {
  const lines: string[] = [];
  lines.push(`Auto-emitted bug profile from \`slowcook investigate\` (${cliVersion}).`);
  lines.push("");
  lines.push(`Closes related: ${profile.source_issue}`);
  lines.push("");
  lines.push(`## Symptom`);
  for (const s of profile.symptom) lines.push(`- ${s}`);
  lines.push("");
  lines.push(`## Expected`);
  for (const s of profile.expected) lines.push(`- ${s}`);
  lines.push("");
  lines.push(`## Failure locus`);
  lines.push(
    `\`${profile.failure_locus.file}${profile.failure_locus.line ? `:${profile.failure_locus.line}` : ""}\`${profile.failure_locus.function ? ` · \`${profile.failure_locus.function}\`` : ""}`
  );
  lines.push("");
  lines.push(`> ${profile.failure_locus.diagnosis.split("\n").join("\n> ")}`);
  lines.push("");
  lines.push(`## Regression assertion`);
  for (const a of profile.regression_assertion) lines.push(`- ${a}`);
  lines.push("");
  lines.push(`## Fix scope`);
  for (const s of profile.fix_scope) lines.push(`- \`${s}\``);
  lines.push("");
  lines.push(
    `Merging this PR triggers \`slowcook recipe --regression --bug ${profile.bug_id}\` to emit the failing test under \`tests/regression/\`. Sift takes it from there.`
  );
  return lines.join("\n");
}

interface IssuePayload {
  number: number;
  title: string;
  body: string;
  priorComments: string[];
}

/**
 * Fetch issue body + prior comments via the gh CLI. We invoke gh
 * rather than the REST API directly so the existing GITHUB_TOKEN /
 * gh-auth flow Just Works in CI + on dev machines.
 *
 * Falls back to throwing on failure — investigate without an issue
 * body has nothing to work with.
 */
function fetchIssueViaGh(
  issueNumber: number,
  repoRoot: string
): IssuePayload {
  let payload: {
    title: string;
    body: string;
    comments: Array<{ author: { login: string }; body: string }>;
  };
  try {
    const json = execSync(
      `gh issue view ${issueNumber} --json title,body,comments`,
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 1024 * 1024 }
    );
    payload = JSON.parse(json);
  } catch (e) {
    throw new Error(
      `gh issue view ${issueNumber} failed: ${(e as Error).message}. ` +
        `Make sure GITHUB_TOKEN is set or 'gh auth status' is healthy.`
    );
  }
  const priorComments = (payload.comments ?? [])
    .filter(
      (c) =>
        // Drop slowcook-bot's own audit-trail messages — they're noise
        // for an LLM trying to read the *human* conversation.
        !c.body.startsWith("### slowcook ·") &&
        c.author.login !== "github-actions" &&
        c.author.login !== "slowcook-refine[bot]" &&
        c.author.login !== "slowcook-brew[bot]"
    )
    .map((c) => `(${c.author.login}) ${c.body}`);
  return {
    number: issueNumber,
    title: payload.title,
    body: payload.body,
    priorComments,
  };
}

/**
 * Render a BugProfile as YAML. Hand-rolled because we don't want to
 * pull a YAML lib dep just for emission. The schema is small enough
 * that this is fine.
 */
export function renderProfileAsYaml(profile: BugProfile): string {
  const lines: string[] = [];
  lines.push(`$schema: ./bug-profile.schema.json`);
  lines.push(`schema_version: ${profile.schema_version}`);
  lines.push(`bug_id: ${profile.bug_id}`);
  lines.push(`title: ${yamlString(profile.title)}`);
  lines.push(`source_issue: "${profile.source_issue}"`);
  lines.push(`status: ${profile.status}`);
  lines.push(`investigated_by: ${profile.investigated_by}`);
  lines.push(`created_at: ${profile.created_at}`);
  lines.push("");
  lines.push("symptom:");
  for (const s of profile.symptom) lines.push(`  - ${yamlString(s)}`);
  lines.push("expected:");
  for (const s of profile.expected) lines.push(`  - ${yamlString(s)}`);
  lines.push("reproduction:");
  for (const s of profile.reproduction) lines.push(`  - ${yamlString(s)}`);
  lines.push("failure_locus:");
  lines.push(`  file: ${yamlString(profile.failure_locus.file)}`);
  if (profile.failure_locus.line !== undefined) {
    lines.push(`  line: ${profile.failure_locus.line}`);
  }
  if (profile.failure_locus.function !== undefined) {
    lines.push(`  function: ${yamlString(profile.failure_locus.function)}`);
  }
  lines.push(`  diagnosis: ${yamlMultiline(profile.failure_locus.diagnosis)}`);
  lines.push("regression_assertion:");
  for (const s of profile.regression_assertion) lines.push(`  - ${yamlString(s)}`);
  lines.push("fix_scope:");
  for (const s of profile.fix_scope) lines.push(`  - ${yamlString(s)}`);
  if (profile.related_specs && profile.related_specs.length > 0) {
    lines.push("related_specs:");
    for (const r of profile.related_specs) {
      lines.push(`  - id: ${yamlString(r.id)}`);
      lines.push(`    relationship: ${r.relationship}`);
      if (r.note) lines.push(`    note: ${yamlString(r.note)}`);
    }
  }
  return lines.join("\n") + "\n";
}

function yamlString(s: string): string {
  // Always quote — keeps things simple. Escape backslashes + quotes.
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function yamlMultiline(s: string): string {
  if (!s.includes("\n")) return yamlString(s);
  return "|\n    " + s.split("\n").map((l) => l.trimEnd()).join("\n    ");
}
