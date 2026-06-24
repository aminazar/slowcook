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
  /**
   * 0.19.0-α.16 — garnish mode (DevTools Workspaces flow).
   *
   * Replaces the remote-PM review-overlay channel with a local-developer
   * channel: print DevTools Workspaces pairing instructions, watch
   * `mock/src/` for file saves (typically saved by Chrome via Workspaces,
   * but any editor works), debounce + run tests + auto-commit via the
   * shared runGarnish core when green.
   *
   * The overlay is intentionally disabled in this mode (we don't set
   * NEXT_PUBLIC_SLOWCOOK_REVIEW). PM uses DevTools instead.
   */
  garnish: boolean;
  /**
   * 0.6.0 — bind the reviewer auth-helper on 0.0.0.0 (not 127.0.0.1) so a
   * co-worker's browser can reach it for LCR review hosted on a remote box.
   * Safe: the helper carries no host secret. Only meaningful in lcr mode.
   */
  expose: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    story: "",
    repoRoot: process.cwd(),
    pollSeconds: 15,
    skipInstall: false,
    branchOverride: null,
    garnish: false,
    expose: false,
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
    else if (a === "--garnish") { args.garnish = true; }
    else if (a === "--expose") { args.expose = true; }
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
  --expose                 (0.6.0) Bind the LCR reviewer sign-in helper on
                           0.0.0.0 so a co-worker on another machine can reach
                           it. Use when hosting LCR review on a remote box.
  --garnish                (0.19.0-α.16) DevTools Workspaces mode. Disables
                           the review-overlay; instead prints Chrome
                           Workspaces pairing instructions + watches
                           mock/src/ for file saves. Each debounced batch
                           runs vitest related + auto-commits via garnish
                           on green (Tweaks-output-of: trailers recorded
                           for learning signal).

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
  //
  // 0.19.0+ (sc#82) — detect mock shape so the log message is honest.
  // `npm run dev` works for both shapes (Next.js: `next dev`; Vite:
  // `vite`) — only the cosmetic label here needs branching.
  // 0.6.0 — also read review_mode so an LCR mock gets the free-nav
  // overlay (shows on every route + per-route comment capture).
  const { loadMockShapeConfig } = await import("../../lib/mock-shape.js");
  const mockConfig = loadMockShapeConfig(args.repoRoot);
  const mockShape = mockConfig.shape;
  const isLcr = mockConfig.review_mode === "lcr";

  // Host the comment-submission helpers. Two distinct identity models:
  //  - scenarios mode → gh-proxy: substitutes the HOST's `gh auth token` so
  //    the solo PM never pastes a PAT. Must stay on 127.0.0.1 (it carries a
  //    privileged token).
  //  - lcr mode → reviewer auth-helper: device-flow endpoints so EACH reviewer
  //    signs in as themselves (per-person attribution). Carries no host secret,
  //    so it's safe to expose off-host with --expose for the remote-box case.
  // 0.6.0 — in --garnish mode the overlay is disabled, so we skip both.
  let proxy: ProxyHandle | null = null;
  let authServer: { url: string; close: () => void } | null = null;
  let reviewClientId = "";
  const bindHost = args.expose ? "0.0.0.0" : "127.0.0.1";
  if (!args.garnish && isLcr) {
    const { GitHubReviewerAuth, SLOWCOOK_REVIEW_OAUTH_CLIENT_ID } = await import("@slowcook-ai/forge-github");
    const { startReviewerAuthServer } = await import("./reviewer-auth-server.js");
    reviewClientId = mockConfig.review_oauth_client_id ?? SLOWCOOK_REVIEW_OAUTH_CLIENT_ID;
    try {
      const auth = new GitHubReviewerAuth({ clientId: reviewClientId, scope: mockConfig.review_oauth_scope });
      authServer = await startReviewerAuthServer(auth, { clientId: reviewClientId, host: bindHost });
      console.log(`  auth   reviewer sign-in helper on ${authServer.url} (device flow; each reviewer signs in as themselves)${args.expose ? " — exposed on 0.0.0.0" : ""}`);
    } catch (e) {
      console.warn(`  auth   reviewer auth-helper failed to start (${(e as Error).message}); overlay will fall back to PAT prompt.`);
    }
  } else if (!args.garnish) {
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
  } else {
    console.log(`  proxy  skipped (--garnish mode; overlay disabled)`);
  }

  // Step 4: spawn next dev with env vars. Set BOTH NEXT_PUBLIC_* (Next.js
  // inlines these) and VITE_* (Vite only exposes VITE_-prefixed vars to
  // import.meta.env) so the overlay mount reads the same values in either
  // mock shape.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!args.garnish) {
    const overlayEnv: Record<string, string> = {
      REVIEW: "1",
      OWNER: detected.owner,
      REPO: detected.repo,
      PR_NUMBER: prNumber ? String(prNumber) : "0",
      STORY_ID: args.story,
      REVIEW_MODE: mockConfig.review_mode,
    };
    if (proxy) overlayEnv["GH_PROXY"] = proxy.url;
    if (authServer) {
      overlayEnv["AUTH_BASE"] = authServer.url;
      overlayEnv["REVIEW_CLIENT_ID"] = reviewClientId;
    }
    for (const [k, v] of Object.entries(overlayEnv)) {
      env[`NEXT_PUBLIC_SLOWCOOK_${k}`] = v;
      env[`VITE_SLOWCOOK_${k}`] = v;
    }
  }

  const devLabel = mockShape === "vite" ? "vite :3100" : "next dev :3100";
  console.log(`  npm    run dev (${devLabel})`);
  if (!args.garnish) {
    console.log(`         overlay env: REVIEW=1 MODE=${mockConfig.review_mode} OWNER=${detected.owner} REPO=${detected.repo} PR=${prNumber ?? "?"} STORY=${args.story}${proxy ? ` GH_PROXY=${proxy.url}` : ""}${authServer ? ` AUTH_BASE=${authServer.url}` : ""}`);
    if (!prNumber) {
      console.warn(`         (no open mockup PR found for branch ${branch}; overlay submits will fail until one exists)`);
    }
  } else {
    const srcDir = join(mockDir, "src");
    console.log(`         (--garnish mode: overlay disabled; DevTools Workspaces pairing instructions below)`);
    console.log(``);
    console.log(`  ─── Chrome DevTools Workspaces ─────────────────────────────────────`);
    console.log(`  Once-only setup (Chrome saves the workspace mapping after this):`);
    console.log(`    1. Open the mock at  http://localhost:3100`);
    console.log(`    2. F12 → Sources panel → Filesystem (left sidebar) → "+ Add folder"`);
    console.log(`    3. Paste this path:  ${srcDir}`);
    console.log(`    4. Approve the permission dialog Chrome shows`);
    console.log(``);
    console.log(`  After that, your DevTools Sources-panel edits save directly to`);
    console.log(`  the mock app's source files. slowcook watches them + auto-commits.`);
    console.log(`  ─────────────────────────────────────────────────────────────────────`);
    console.log(``);
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

  // Step 5b: --garnish mode — watch mock/src/ for file saves +
  // auto-commit via the shared runGarnish core. Debounced so a flurry
  // of saves (Chrome DevTools sometimes saves twice in quick succession;
  // editors can too) collapses to one commit.
  let watcher: ReturnType<typeof import("node:fs").watch> | null = null;
  let watcherDebounceTimer: NodeJS.Timeout | null = null;
  let garnishInFlight = false;
  if (args.garnish) {
    const { watch } = await import("node:fs");
    const { runGarnish } = await import("../garnish/index.js");
    const watchTarget = join(mockDir, "src");
    console.log(`[run-mock] watching ${watchTarget.replace(args.repoRoot + "/", "")} for file saves (debounce 1.5s)`);
    const onSaveBatch = async () => {
      if (garnishInFlight) return; // skip overlapping runs
      garnishInFlight = true;
      try {
        console.log(`\n[run-mock] file save detected; running tests + garnishing...`);
        const result = await runGarnish({
          repoRoot: args.repoRoot,
          push: false,
        });
        if (result.kind === "no-changes") {
          console.log(`[run-mock] no committable changes (test files or transient saves).`);
        } else if (result.kind === "tests-failed") {
          console.log(`[run-mock] ✗ tests failed; not committing. Leave the file as-is + fix, slowcook will re-test on next save.`);
          const tail = result.outputTail.split("\n").slice(-12).join("\n");
          console.log(`  ${tail.replace(/\n/g, "\n  ")}`);
        } else {
          console.log(`[run-mock] ✓ garnished ${result.sha.slice(0, 7)} (${result.touchedFiles.length} file(s), ${result.agentRefCount} agent ref(s))`);
        }
      } finally {
        garnishInFlight = false;
      }
    };
    try {
      watcher = watch(watchTarget, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        const f = filename.toString();
        if (f.startsWith("node_modules/")) return;
        if (f.startsWith(".next/")) return;
        if (f.startsWith("scenarios/")) return; // vibe's output; tweaking these by hand is unusual
        if (!/\.(tsx?|css|json)$/.test(f)) return;
        if (watcherDebounceTimer) clearTimeout(watcherDebounceTimer);
        watcherDebounceTimer = setTimeout(() => { void onSaveBatch(); }, 1500);
      });
    } catch (e) {
      console.warn(`[run-mock] could not start file watcher (${(e as Error).message}); --garnish mode disabled.`);
    }
  }

  // Step 6: clean shutdown on Ctrl-C / dev exit. Pop any stash we
  // pushed in step 1 so the user's working tree is restored to its
  // pre-run-mock state — same UX guarantee as `git stash pop` after
  // their own manual stash dance.
  const cleanup = (signal?: string) => {
    if (pollTimer) clearInterval(pollTimer);
    if (watcher) { try { watcher.close(); } catch { /* ignore */ } }
    if (watcherDebounceTimer) { clearTimeout(watcherDebounceTimer); watcherDebounceTimer = null; }
    if (proxy) { try { proxy.close(); } catch { /* ignore */ } }
    if (authServer) { try { authServer.close(); } catch { /* ignore */ } }
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
