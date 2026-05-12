/**
 * `slowcook garnish` — 0.19.0-α.15.
 *
 * Local commit-gate for human (or other-agent) tweaks layered on top
 * of an agent's work. The PM (or engineer) edits files in the working
 * tree — by hand, via DevTools Workspaces, via any editor — then runs
 * `slowcook garnish`. The cli:
 *
 *   1. Detects uncommitted changes in the working tree.
 *   2. For each changed file, identifies the agent (if any) whose last
 *      commit touched the file. Files last touched by humans get no
 *      trailer entry (no learning signal for an agent).
 *   3. Runs the relevant tests scoped to the changed files (or the
 *      caller-provided test glob via --scope).
 *   4. If tests pass: commits the staged changes with a subject naming
 *      the touched files + `Tweaks-output-of:` trailer lines marking
 *      each agent-authored file the tweak touched. Optionally pushes.
 *   5. If tests fail: prints the failure summary + exits non-zero
 *      without committing.
 *
 * The trailer lines are the load-bearing piece — a future `slowcook
 * reflect` command mines them to surface learning signal for the
 * upstream agent (eval-set fixtures, prompt-amendment candidates).
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  composeCommitMessage,
  agentFromAuthor,
  type UpstreamRef,
} from "./trailer.js";

interface Args {
  repoRoot: string;
  scope: string | null;
  push: boolean;
  message: string | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    repoRoot: process.cwd(),
    scope: null,
    push: false,
    message: null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--cwd" && next) { args.repoRoot = next; i++; }
    else if (a === "--scope" && next) { args.scope = next; i++; }
    else if (a === "--push") { args.push = true; }
    else if (a === "--message" && next) { args.message = next; i++; }
    else if (a === "-m" && next) { args.message = next; i++; }
    else if (a === "--dry-run") { args.dryRun = true; }
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook garnish — commit a human (or other-agent) tweak on top of agent work

Detects uncommitted changes, runs the relevant tests, and (if green) commits
with \`Tweaks-output-of:\` trailers marking which upstream agent's work was
tweaked. A future \`slowcook reflect\` mines these trailers for learning signal.

Usage:
  slowcook garnish [options]

Options:
  --cwd <path>         Repo root (default: cwd).
  --scope <glob>       Pass through to vitest (\`vitest run <glob>\`). Default:
                       run vitest related to the changed files.
  --message <text>     Optional commit body. Default: subject-only.
  -m <text>            Short form of --message.
  --push               Push to origin after committing.
  --dry-run            Print what would happen; do not run tests or commit.

Examples:
  # Edit some files via DevTools Workspaces / by hand, then:
  slowcook garnish

  # Force a specific test scope:
  slowcook garnish --scope 'tests/integration/story-018-*'

  # Commit + push:
  slowcook garnish -m "Tightened the spacing on the Pin button." --push
`);
}

interface ChangedFile {
  path: string;
  status: string; // M / A / R / etc per git --porcelain
}

function gitChangedFiles(repoRoot: string): ChangedFile[] {
  const out = execSync(`git -C "${repoRoot}" status --porcelain`, {
    encoding: "utf8",
  });
  const lines = out.split("\n").filter((l) => l.length > 0);
  return lines
    .map((line) => {
      // Format: "XY path" or "XY path-old -> path-new" for renames.
      // Take the rightmost path; safe enough for our use.
      const status = line.slice(0, 2).trim();
      const rest = line.slice(3).trim();
      const path = rest.includes(" -> ") ? rest.split(" -> ")[1]! : rest;
      return { path, status };
    })
    .filter((f) => f.status !== "??"); // skip untracked-only (user can `git add` first)
}

function lastTouchingCommit(repoRoot: string, file: string): { sha: string; author: string } | null {
  try {
    const sha = execSync(
      `git -C "${repoRoot}" log -n 1 --format=%H -- "${file}"`,
      { encoding: "utf8" },
    ).trim();
    if (!sha) return null;
    const author = execSync(
      `git -C "${repoRoot}" show -s --format=%an "${sha}"`,
      { encoding: "utf8" },
    ).trim();
    return { sha, author };
  } catch {
    return null;
  }
}

function resolveUpstreamRefs(repoRoot: string, files: string[]): {
  refs: UpstreamRef[];
  humanFiles: string[];
} {
  const refs: UpstreamRef[] = [];
  const humanFiles: string[] = [];
  for (const file of files) {
    const upstream = lastTouchingCommit(repoRoot, file);
    if (!upstream) {
      // File doesn't exist in history yet — must be newly-added by this tweak.
      humanFiles.push(file);
      continue;
    }
    const agent = agentFromAuthor(upstream.author);
    if (agent) {
      refs.push({ agent, sha: upstream.sha, file });
    } else {
      humanFiles.push(file);
    }
  }
  return { refs, humanFiles };
}

function runTests(repoRoot: string, files: string[], scopeOverride: string | null): { ok: boolean; output: string } {
  const cmd = scopeOverride
    ? `npx vitest run ${scopeOverride}`
    : `npx vitest related ${files.map((f) => `"${f}"`).join(" ")}`;
  const result = spawnSync(cmd, {
    cwd: repoRoot,
    shell: true,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  const output = (result.stdout || "") + (result.stderr || "");
  const ok = result.status === 0;
  return { ok, output };
}

/**
 * 0.19.0-α.16 — runGarnish, the reusable core. Other commands
 * (run-mock --garnish, for one) call this in-process on debounced
 * file-save batches; doing it as a subprocess invocation would
 * re-pay node startup every time.
 *
 * Returns a structured result; never calls process.exit. Caller
 * decides what to do on each kind.
 */
export interface RunGarnishOptions {
  repoRoot: string;
  scope?: string | null;
  message?: string | null;
  push?: boolean;
  silent?: boolean;
}

export type RunGarnishResult =
  | { kind: "no-changes" }
  | { kind: "tests-failed"; touchedFiles: string[]; outputTail: string }
  | {
      kind: "committed";
      sha: string;
      touchedFiles: string[];
      agentRefCount: number;
      pushed: boolean;
    };

export async function runGarnish(opts: RunGarnishOptions): Promise<RunGarnishResult> {
  const repoRoot = opts.repoRoot;
  const scope = opts.scope ?? null;
  const log = opts.silent ? () => undefined : (msg: string) => console.log(msg);
  const warn = opts.silent ? () => undefined : (msg: string) => console.warn(msg);

  const changed = gitChangedFiles(repoRoot);
  if (changed.length === 0) {
    return { kind: "no-changes" };
  }

  const touchedFiles = changed.map((c) => c.path);
  const { refs, humanFiles } = resolveUpstreamRefs(repoRoot, touchedFiles);

  if (!opts.silent) {
    log(`  ${touchedFiles.length} file(s) with uncommitted changes:`);
    for (const f of touchedFiles) log(`    ${f}`);
    log(`  upstream: ${refs.length} agent-authored, ${humanFiles.length} human/new`);
    if (refs.length > 0) {
      const byAgent: Record<string, number> = {};
      for (const r of refs) byAgent[r.agent] = (byAgent[r.agent] ?? 0) + 1;
      const summary = Object.entries(byAgent).map(([a, n]) => `${a}=${n}`).join(", ");
      log(`    (${summary})`);
    }
    log("\n  running tests" + (scope ? ` (--scope ${scope})` : " (vitest related)") + "...");
  }

  const tests = runTests(repoRoot, touchedFiles, scope);
  if (!tests.ok) {
    const tail = tests.output.split("\n").slice(-40).join("\n");
    return { kind: "tests-failed", touchedFiles, outputTail: tail };
  }
  log("  ✓ tests passed.");

  const message = composeCommitMessage({
    touchedFiles,
    upstreamRefs: refs,
    userMessage: opts.message ?? undefined,
  });
  const msgFile = join(repoRoot, ".brewing/.garnish-commit-msg.tmp");
  if (!existsSync(join(repoRoot, ".brewing"))) {
    execSync(`mkdir -p "${join(repoRoot, ".brewing")}"`);
  }
  writeFileSync(msgFile, message, "utf8");
  for (const f of touchedFiles) {
    try { execSync(`git -C "${repoRoot}" add -- "${f}"`, { stdio: "ignore" }); }
    catch { /* deleted file; ignore */ }
  }
  try {
    execSync(`git -C "${repoRoot}" commit -F "${msgFile}"`, {
      stdio: opts.silent ? "ignore" : "inherit",
    });
  } catch (e) {
    warn(`  garnish commit failed: ${(e as Error).message.slice(0, 200)}`);
    return { kind: "tests-failed", touchedFiles, outputTail: (e as Error).message };
  }
  const sha = execSync(`git -C "${repoRoot}" rev-parse HEAD`, { encoding: "utf8" }).trim();
  let pushed = false;
  if (opts.push) {
    try {
      execSync(`git -C "${repoRoot}" push`, { stdio: opts.silent ? "ignore" : "inherit" });
      pushed = true;
    } catch (e) {
      warn(`  warn: push failed: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  return { kind: "committed", sha, touchedFiles, agentRefCount: refs.length, pushed };
}

export async function garnish(argv: string[], _cliVersion: string): Promise<void> {
  const args = parseArgs(argv);

  console.log(`slowcook garnish · cwd: ${args.repoRoot.replace(process.cwd() + "/", ".")}`);

  if (args.dryRun) {
    const changed = gitChangedFiles(args.repoRoot);
    if (changed.length === 0) {
      console.log("  no uncommitted changes; nothing to garnish.");
      return;
    }
    const touchedFiles = changed.map((c) => c.path);
    const { refs, humanFiles } = resolveUpstreamRefs(args.repoRoot, touchedFiles);
    console.log(`  ${touchedFiles.length} file(s) with uncommitted changes:`);
    for (const f of touchedFiles) console.log(`    ${f}`);
    console.log(`  upstream: ${refs.length} agent-authored, ${humanFiles.length} human/new`);
    if (refs.length > 0) {
      const byAgent: Record<string, number> = {};
      for (const r of refs) byAgent[r.agent] = (byAgent[r.agent] ?? 0) + 1;
      const summary = Object.entries(byAgent).map(([a, n]) => `${a}=${n}`).join(", ");
      console.log(`    (${summary})`);
    }
    console.log("\n  [dry-run] would run tests + commit; skipping.");
    const message = composeCommitMessage({
      touchedFiles,
      upstreamRefs: refs,
      userMessage: args.message ?? undefined,
    });
    console.log("\n  commit message would be:\n");
    for (const line of message.split("\n")) console.log(`    ${line}`);
    return;
  }

  const result = await runGarnish({
    repoRoot: args.repoRoot,
    scope: args.scope,
    message: args.message,
    push: args.push,
  });
  if (result.kind === "no-changes") {
    console.log("  no uncommitted changes; nothing to garnish.");
    return;
  }
  if (result.kind === "tests-failed") {
    console.error("\n  ✗ tests failed. Garnish blocked; working tree unchanged.\n");
    console.error(result.outputTail);
    process.exit(1);
  }
  console.log(`\n  ✓ garnished: ${result.sha.slice(0, 7)} (${result.agentRefCount} agent ref(s) recorded)${result.pushed ? " · pushed" : ""}`);
}
