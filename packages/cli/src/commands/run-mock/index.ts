/**
 * `slowcook run-mock <story>` — 0.16.0-α.17.
 *
 * One-command launch of the mock app + auto-pull when plate force-
 * pushes the mockup branch. Removes the manual cycle of:
 *   git fetch + git checkout + cd mock + npm install + npm run dev
 *   ...wait for plate...
 *   git pull
 *
 * What it does:
 *   1. Resolves story id → mockup branch (`slowcook/mockup/story-N`).
 *   2. `git fetch origin <branch>` then `git checkout <branch>`.
 *   3. `cd mock && npm install` (skipped if package-lock.json is up-to-date).
 *   4. Spawns `npm run dev` in `mock/` (Next dev on :3100).
 *   5. Background poll: every 15s `git fetch origin <branch>`; if origin
 *      moved, `git pull --ff-only`. Next-dev's filesystem watcher
 *      hot-reloads automatically when the files change.
 *   6. Ctrl-C kills the dev server + the poll loop.
 *
 * Out of scope (queued for follow-up alpha):
 *   - Worktree isolation (don't change the user's branch state)
 *
 * 0.18.0-α.2 — gh-proxy. Spawns a localhost http proxy that signs every
 * request with the local `gh auth token`; overlay reads NEXT_PUBLIC_
 * SLOWCOOK_GH_PROXY and skips the PAT prompt entirely. Falls back to
 * the prompt if gh isn't installed or not authed.
 *
 * Env vars exported into the dev-server child process so the overlay
 * activates without manual setup:
 *   NEXT_PUBLIC_SLOWCOOK_REVIEW=1
 *   NEXT_PUBLIC_SLOWCOOK_OWNER=<detected from git remote>
 *   NEXT_PUBLIC_SLOWCOOK_REPO=<detected from git remote>
 *   NEXT_PUBLIC_SLOWCOOK_PR_NUMBER=<looked up via gh pr list>
 *   NEXT_PUBLIC_SLOWCOOK_STORY_ID=<from arg>
 *   NEXT_PUBLIC_SLOWCOOK_GH_PROXY=http://localhost:<port>  (when gh authed)
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { readGhToken, startGhProxy, type ProxyHandle } from "./gh-proxy.js";

interface Args {
  story: string;
  repoRoot: string;
  /** Poll interval in seconds; defaults to 15. Set 0 to disable polling. */
  pollSeconds: number;
  /** Skip `npm install` even when lockfile drift is detected. */
  skipInstall: boolean;
  /** Override branch name; default is `slowcook/mockup/story-<id>`. */
  branchOverride: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    story: "",
    repoRoot: process.cwd(),
    pollSeconds: 15,
    skipInstall: false,
    branchOverride: null,
  };
  // Positional first arg is story id (consumer convenience).
  if (argv.length > 0 && argv[0] && !argv[0].startsWith("-")) {
    args.story = argv[0];
    argv = argv.slice(1);
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--story" && next) { args.story = next; i++; }
    else if (a === "--cwd" && next) { args.repoRoot = next; i++; }
    else if (a === "--branch" && next) { args.branchOverride = next; i++; }
    else if (a === "--poll-seconds" && next) { args.pollSeconds = parseInt(next, 10); i++; }
    else if (a === "--no-poll") { args.pollSeconds = 0; }
    else if (a === "--skip-install") { args.skipInstall = true; }
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  if (!args.story) {
    console.error("story id is required (positional or --story <id>).");
    printHelp();
    process.exit(64);
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook run-mock — one-command mock launch + auto-pull (0.16-α.17)

Usage:
  slowcook run-mock <story-id> [options]
  slowcook run-mock --story <story-id> [options]

Examples:
  slowcook run-mock 017                # checkout mockup branch + launch dev
  slowcook run-mock 017 --no-poll      # disable auto-pull
  slowcook run-mock 017 --poll-seconds 30
  slowcook run-mock 017 --branch slowcook/mockup/story-017-fix

Options:
  --story <id>             Story id (positional alternative).
  --cwd <path>             Repo root (default: cwd).
  --branch <ref>           Override mockup branch name.
  --poll-seconds <n>       Auto-pull interval (default 15; 0 disables).
  --no-poll                Disable auto-pull.
  --skip-install           Skip npm install even on lockfile drift.

What it does:
  1. git fetch + git checkout the mockup branch
  2. npm install in mock/ (skipped when lockfile is up-to-date)
  3. Spawn next dev on :3100 with overlay env vars set
  4. Background-poll origin every <poll-seconds> for new commits
     (e.g. plate amendments) and auto-pull. next-dev hot-reloads.
  5. Ctrl-C cleans up both the dev server + the poll loop.

Env auto-exported to the dev process:
  NEXT_PUBLIC_SLOWCOOK_REVIEW=1
  NEXT_PUBLIC_SLOWCOOK_OWNER, _REPO, _PR_NUMBER, _STORY_ID
  NEXT_PUBLIC_SLOWCOOK_GH_PROXY (set when gh is authed; lets overlay
                                 skip the PAT prompt)

Exit codes:
  0  clean shutdown via Ctrl-C
  2  setup error (missing branch / missing mock dir / etc.)
`);
}

interface DetectedRepo { owner: string; repo: string }

function detectOwnerRepo(repoRoot: string): DetectedRepo | null {
  try {
    const url = execSync("git remote get-url origin", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (m && m[1] && m[2]) return { owner: m[1], repo: m[2] };
  } catch { /* ignore */ }
  return null;
}

function detectPrNumber(repoRoot: string, branch: string): number | null {
  try {
    const out = execSync(
      `gh pr list --repo "$(git -C ${JSON.stringify(repoRoot)} remote get-url origin | sed -E 's|^.*github\\.com[:/]||; s|\\.git$||')" --head ${JSON.stringify(branch)} --state open --json number --jq '.[0].number'`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    const n = parseInt(out, 10);
    return Number.isNaN(n) ? null : n;
  } catch { return null; }
}

function gitRevParse(repoRoot: string, ref: string): string | null {
  try {
    return execSync(
      `git -C ${JSON.stringify(repoRoot)} rev-parse ${JSON.stringify(ref)}`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
  } catch { return null; }
}

export async function runMock(argv: string[], _cliVersion: string): Promise<void> {
  const args = parseArgs(argv);
  const branch = args.branchOverride ?? `slowcook/mockup/story-${args.story}`;
  const mockDir = join(args.repoRoot, "mock");

  if (!existsSync(mockDir) || !statSync(mockDir).isDirectory()) {
    console.error(`No mock/ directory at ${mockDir}. Run \`slowcook init mock\` first.`);
    process.exit(2);
  }

  const detected = detectOwnerRepo(args.repoRoot);
  if (!detected) {
    console.error("Could not detect owner/repo from git remote. Cannot proceed.");
    process.exit(2);
  }

  console.log(`slowcook run-mock · story-${args.story} on branch ${branch}`);

  // Step 1: git fetch + checkout.
  // 0.16.0-α.21 — auto-stash any dirty working tree before the
  // checkout. Real consumers always have some incidental dirt
  // (Next reformats tsconfig.json, lock files differ, etc.); failing
  // the checkout on those is hostile UX. Stash gets popped on exit.
  let stashedRef: string | null = null;
  try {
    const dirty = execSync(`git -C ${JSON.stringify(args.repoRoot)} status --porcelain`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (dirty.length > 0) {
      console.log(`  git    auto-stash dirty working tree (will pop on exit)`);
      execSync(
        `git -C ${JSON.stringify(args.repoRoot)} stash push -u -m "slowcook-run-mock auto-stash"`,
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      stashedRef = "stash@{0}";
    }
  } catch (e) {
    console.warn(`  git    auto-stash failed (${(e as Error).message}); checkout may fail`);
  }

  console.log(`  git    fetch + checkout ${branch}`);
  try {
    execSync(`git -C ${JSON.stringify(args.repoRoot)} fetch origin ${JSON.stringify(branch)}`, { stdio: ["ignore", "ignore", "pipe"] });
    execSync(`git -C ${JSON.stringify(args.repoRoot)} checkout ${JSON.stringify(branch)}`, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    console.error(`Failed to fetch + checkout ${branch}: ${(e as Error).message}`);
    if (stashedRef) {
      try {
        execSync(`git -C ${JSON.stringify(args.repoRoot)} stash pop`, { stdio: ["ignore", "ignore", "pipe"] });
      } catch { /* ignore */ }
    }
    process.exit(2);
  }

  // Step 2: npm install in mock/ (only if lockfile changed since last install).
  // 0.16.0-α.22 — also `npm update` the slowcook-ai deps so the lockfile
  // doesn't pin a stale review-overlay / mock-runtime forever. Without
  // this, consumers would only get new features after a manual `npm
  // update` — exactly the wall caught in dogfood iter 8.
  if (!args.skipInstall) {
    console.log(`  npm    install in mock/`);
    try {
      execSync(`npm install --silent`, { cwd: mockDir, stdio: ["ignore", "inherit", "inherit"] });
    } catch (e) {
      console.error(`npm install failed: ${(e as Error).message}`);
      process.exit(2);
    }
    console.log(`  npm    update @slowcook-ai/* (refresh lockfile against latest)`);
    try {
      execSync(`npm update --silent @slowcook-ai/mock-runtime @slowcook-ai/review-overlay`, {
        cwd: mockDir,
        stdio: ["ignore", "inherit", "inherit"],
      });
    } catch {
      // Best-effort; old lockfile still works. Don't fail the run.
      console.warn(`  npm    update failed (non-fatal); using whatever's in the lockfile.`);
    }
  }

  // Step 3: detect PR number for the overlay env vars.
  const prNumber = detectPrNumber(args.repoRoot, branch);

  // Step 3b: start the gh-proxy so the overlay can submit comments
  // without prompting the PM for a PAT. Uses `gh auth token` from the
  // local gh CLI; falls back silently when gh isn't installed or the
  // user hasn't logged in (overlay then uses its old PAT-prompt path).
  let proxy: ProxyHandle | null = null;
  const ghToken = readGhToken();
  if (ghToken) {
    try {
      proxy = await startGhProxy(ghToken);
      console.log(`  proxy  gh-proxy on ${proxy.url} (no PAT prompt — uses 'gh auth token')`);
    } catch (e) {
      console.warn(`  proxy  gh-proxy failed to start (${(e as Error).message}); overlay will fall back to PAT prompt.`);
    }
  } else {
    console.warn(`  proxy  gh CLI not authenticated ('gh auth token' returned empty). Overlay will prompt for a PAT instead.`);
  }

  // Step 4: spawn next dev with env vars.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NEXT_PUBLIC_SLOWCOOK_REVIEW: "1",
    NEXT_PUBLIC_SLOWCOOK_OWNER: detected.owner,
    NEXT_PUBLIC_SLOWCOOK_REPO: detected.repo,
    NEXT_PUBLIC_SLOWCOOK_PR_NUMBER: prNumber ? String(prNumber) : "0",
    NEXT_PUBLIC_SLOWCOOK_STORY_ID: args.story,
  };
  if (proxy) env["NEXT_PUBLIC_SLOWCOOK_GH_PROXY"] = proxy.url;

  console.log(`  npm    run dev (next dev :3100)`);
  console.log(`         overlay env: REVIEW=1 OWNER=${detected.owner} REPO=${detected.repo} PR=${prNumber ?? "?"} STORY=${args.story}${proxy ? ` GH_PROXY=${proxy.url}` : ""}`);
  if (!prNumber) {
    console.warn(`         (no open mockup PR found for branch ${branch}; overlay submits will fail until one exists)`);
  }

  const dev: ChildProcess = spawn("npm", ["run", "dev"], { cwd: mockDir, env, stdio: "inherit" });

  // Step 5: background poll for branch updates.
  let pollTimer: NodeJS.Timeout | null = null;
  if (args.pollSeconds > 0) {
    let lastSha = gitRevParse(args.repoRoot, "HEAD");
    console.log(`  poll   every ${args.pollSeconds}s for new commits on origin/${branch} (HEAD=${lastSha?.slice(0, 7) ?? "?"})`);
    pollTimer = setInterval(() => {
      try {
        execSync(`git -C ${JSON.stringify(args.repoRoot)} fetch origin ${JSON.stringify(branch)}`, { stdio: ["ignore", "ignore", "pipe"] });
        const remoteSha = gitRevParse(args.repoRoot, `origin/${branch}`);
        if (remoteSha && remoteSha !== lastSha) {
          console.log(`\n[run-mock] origin/${branch} moved: ${lastSha?.slice(0, 7)} → ${remoteSha.slice(0, 7)}`);
          try {
            execSync(`git -C ${JSON.stringify(args.repoRoot)} pull --ff-only origin ${JSON.stringify(branch)}`, { stdio: ["ignore", "inherit", "inherit"] });
            lastSha = remoteSha;
            console.log(`[run-mock] pulled. next-dev should hot-reload.`);
          } catch (e) {
            console.error(`[run-mock] pull failed (non-ff?): ${(e as Error).message}`);
          }
        }
      } catch {
        // Network blip / rate limit — keep polling silently.
      }
    }, args.pollSeconds * 1000);
  }

  // Step 6: clean shutdown on Ctrl-C / dev exit. Pop any stash we
  // pushed in step 1 so the user's working tree is restored to its
  // pre-run-mock state — same UX guarantee as `git stash pop` after
  // their own manual stash dance.
  const cleanup = (signal?: string) => {
    if (pollTimer) clearInterval(pollTimer);
    if (proxy) { try { proxy.close(); } catch { /* ignore */ } }
    if (dev && !dev.killed) {
      try { dev.kill(signal as NodeJS.Signals ?? "SIGTERM"); } catch { /* ignore */ }
    }
    if (stashedRef) {
      try {
        execSync(`git -C ${JSON.stringify(args.repoRoot)} stash pop ${JSON.stringify(stashedRef)}`, { stdio: ["ignore", "inherit", "inherit"] });
        console.log(`[run-mock] popped auto-stash; working tree restored.`);
      } catch (e) {
        console.warn(`[run-mock] could not pop auto-stash (${(e as Error).message}). Run \`git stash pop ${stashedRef}\` manually.`);
      }
    }
  };
  process.on("SIGINT", () => { cleanup("SIGINT"); process.exit(0); });
  process.on("SIGTERM", () => { cleanup("SIGTERM"); process.exit(0); });

  await new Promise<void>((resolve) => {
    dev.on("exit", (code) => {
      cleanup();
      console.log(`\n[run-mock] dev server exited with code ${code ?? 0}`);
      resolve();
    });
  });
}
