/**
 * `slowcook serve mock <verb>` — Phase 2 implementation.
 *
 * The mock profile runs the consumer's `mock/` package as a vite-dev
 * server on a shared box, so the PM + designer + vibe-feedback loop
 * all hit the same artefact at the same URL. Mock-vite runs alongside
 * `serve dev` on the same host with distinct ports + profile-prefixed
 * container names (per design #5).
 *
 * Verbs (Phase 2):
 *   - up      — bring up the mock profile (vite-dev compose overlay)
 *   - sync    — force-push the mock-tracking branch (default `main`) so
 *               the box pulls the latest mockups
 *   - down    — stop the mock services (volumes preserved)
 *   - logs    — pass-through to docker-compose logs
 *   - reset   — no-op (mock has no scenario seed)
 *
 * Auto-skip per Trade-off #4: if the consumer's `mock/package.json`
 * has no `scripts.dev`, slowcook prints a notice + exits 0 instead of
 * trying to bring up an unrunnable vite-dev. Detection runs from
 * `index.ts`'s dispatcher before this module is called.
 */

import { execSync } from "node:child_process";
import type { ProfileConfig, ServeConfig } from "./config.js";
import type { DevVerbResult } from "./dev.js";

export interface MockVerbArgs {
  verb: string;
  branch?: string;
  service?: string;
  follow?: boolean;
  prune?: boolean;
  repoRoot: string;
  dryRun?: boolean;
}

/**
 * Pure planner for the mock profile. Same shape as `planServeDev` so
 * the cli wrapper can render output uniformly.
 */
export function planServeMock(
  args: MockVerbArgs,
  _config: ServeConfig,
  profile: ProfileConfig,
): DevVerbResult {
  switch (args.verb) {
    case "up":
      return planUp(args, profile);
    case "sync":
      return planSync(args, profile);
    case "down":
      return planDown(args, profile);
    case "logs":
      return planLogs(args, profile);
    case "reset":
      return {
        exitCode: 0,
        output: ["[serve mock reset] mock profile has no scenario seed; nothing to reset (only meaningful for staging)."],
      };
    default:
      return {
        exitCode: 64,
        output: [`Unknown verb: ${args.verb}. See \`slowcook serve --help\`.`],
      };
  }
}

function planUp(_args: MockVerbArgs, profile: ProfileConfig): DevVerbResult {
  const overlay = profile.compose_overlay;
  const apps = Object.keys(profile.apps);
  const lines: string[] = [`[serve mock up] bringing up: ${apps.join(", ") || "(no apps configured)"}`];
  if (overlay) {
    lines.push(`  cmd: docker compose -f ${overlay} up -d --build`);
  } else {
    lines.push(
      "  (no compose_overlay set; falling back to `pnpm --filter ./mock dev` if mock/ is vite-runnable)",
    );
  }
  // PM + designer reference URL: surface the vite port if exactly one app.
  if (apps.length === 1) {
    const vitePort = profile.apps[apps[0]!]!.port;
    lines.push(`  vite dev URL (once up): http://<your-box>:${vitePort}`);
  }
  return { exitCode: 0, output: lines };
}

function planSync(args: MockVerbArgs, profile: ProfileConfig): DevVerbResult {
  const sourceBranch = profile.source_branch;
  let localBranch = args.branch;
  if (!localBranch && !args.dryRun) {
    try {
      localBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: args.repoRoot,
        encoding: "utf8",
      }).trim();
    } catch {
      // handled below
    }
  } else if (!localBranch && args.dryRun) {
    localBranch = "<current-branch>";
  }
  if (!localBranch || localBranch === "HEAD") {
    return {
      exitCode: 64,
      output: ["[serve mock sync] couldn't resolve a local branch (detached HEAD?). Pass --branch <name>."],
    };
  }
  const lines = [`[serve mock sync] ${localBranch} → origin/${sourceBranch}`];
  if (args.dryRun) {
    lines.push(`  would run: git push --force origin ${localBranch}:${sourceBranch}`);
    return { exitCode: 0, output: lines };
  }
  try {
    execSync(`git push --force origin ${localBranch}:${sourceBranch}`, {
      cwd: args.repoRoot,
      stdio: "inherit",
    });
  } catch {
    return {
      exitCode: 1,
      output: [...lines, `[serve mock sync] git push failed. Check push permissions on origin/${sourceBranch}.`],
    };
  }
  lines.push(`[serve mock sync] done. The mock-deploy workflow on origin/${sourceBranch} will fire next.`);
  return { exitCode: 0, output: lines };
}

function planDown(args: MockVerbArgs, profile: ProfileConfig): DevVerbResult {
  const overlay = profile.compose_overlay;
  if (!overlay) {
    return { exitCode: 64, output: ["[serve mock down] no compose_overlay set; nothing to stop."] };
  }
  const cmd = args.prune
    ? `docker compose -f ${overlay} down -v`
    : `docker compose -f ${overlay} down`;
  return { exitCode: 0, output: ["[serve mock down]", `  cmd: ${cmd}`] };
}

function planLogs(args: MockVerbArgs, profile: ProfileConfig): DevVerbResult {
  const overlay = profile.compose_overlay;
  if (!overlay) {
    return { exitCode: 64, output: ["[serve mock logs] no compose_overlay set; nothing to tail."] };
  }
  const follow = args.follow ? "-f" : "";
  const service = args.service ?? "";
  return {
    exitCode: 0,
    output: [`  cmd: docker compose -f ${overlay} logs ${follow} ${service}`.replace(/\s+/g, " ").trim()],
  };
}
