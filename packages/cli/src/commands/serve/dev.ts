/**
 * `slowcook serve dev <verb>` — Phase 1 implementation.
 *
 * Verbs (Phase 1):
 *   - up      — bring up the dev profile (compose overlay or fallback)
 *   - sync    — rsync source to the box + restart the bind-mount targets
 *   - down    — stop the profile's services (volumes preserved)
 *   - logs    — pass-through to docker-compose logs
 *   - reset   — no-op for dev profile (only meaningful for staging)
 *
 * Backward-compat aliases preserved on the cli switch:
 *   - `slowcook dev-env push --branch X` ≡ `slowcook serve dev sync --branch X`
 *   - `slowcook dev-env up` ≡ `slowcook serve dev up`
 *   - `slowcook dev-env reset` ≡ `slowcook serve dev reset` (no-op + notice)
 *
 * `bind-mount-source` mode (the DECIDED choice for dev profile) uses
 * rsync to push source + an anonymous-volume node_modules in the
 * compose overlay. Avoids node_modules collision on macOS + chmod
 * surprises. See `docs/plans/0.20-design-discussions.md` design #5
 * "Additional decisions" for the rationale.
 */

import { execSync } from "node:child_process";
import type { ProfileConfig, ServeConfig } from "./config.js";

export interface DevVerbArgs {
  verb: string;
  /** Branch to push (sync verb). Resolved from HEAD if undefined. */
  branch?: string;
  /** Story id, included in the push log line for audit. */
  story?: string;
  /** Filter logs to one app (logs verb). */
  service?: string;
  /** Follow logs (logs verb). */
  follow?: boolean;
  /** Drop volumes too (down verb). */
  prune?: boolean;
  repoRoot: string;
  /** Test seam: skip actual git/docker calls; emit a plan only. */
  dryRun?: boolean;
}

export interface DevVerbResult {
  exitCode: number;
  /** Lines emitted to stdout / "what would have run" under dryRun. */
  output: string[];
}

/**
 * Pure dispatcher for the dev profile. Returns a DevVerbResult so the
 * caller (cli) can render output + set the exit code. Splitting the
 * pure planner from the IO wrapper lets the tests assert on the plan
 * without spawning docker.
 */
export function planServeDev(
  args: DevVerbArgs,
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
        output: ["[serve dev reset] dev profile has no scenario seed; nothing to reset (only meaningful for staging)."],
      };
    default:
      return { exitCode: 64, output: [`Unknown verb: ${args.verb}. See \`slowcook serve dev --help\`.`] };
  }
}

function planUp(_args: DevVerbArgs, profile: ProfileConfig): DevVerbResult {
  const overlay = profile.compose_overlay;
  const apps = Object.keys(profile.apps);
  const lines: string[] = [`[serve dev up] bringing up: ${apps.join(", ") || "(no apps configured)"}`];
  if (overlay) {
    lines.push(`  cmd: docker compose -f ${overlay} up -d --build`);
  } else {
    lines.push("  (no compose_overlay set; consumer must wire its own up command)");
  }
  if (profile.seed_script) {
    lines.push(`  seed: pnpm exec ts-node ${profile.seed_script}`);
  }
  return { exitCode: 0, output: lines };
}

function planSync(args: DevVerbArgs, profile: ProfileConfig): DevVerbResult {
  const sourceBranch = profile.source_branch;
  let localBranch = args.branch;
  if (!localBranch && !args.dryRun) {
    try {
      localBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: args.repoRoot, encoding: "utf8" }).trim();
    } catch {
      // fall through; handled below
    }
  } else if (!localBranch && args.dryRun) {
    localBranch = "<current-branch>";
  }
  if (!localBranch || localBranch === "HEAD") {
    return {
      exitCode: 64,
      output: ["[serve dev sync] couldn't resolve a local branch (detached HEAD?). Pass --branch <name>."],
    };
  }
  const lines: string[] = [
    `[serve dev sync] ${localBranch} → origin/${sourceBranch}${args.story ? ` (story-${args.story})` : ""}`,
  ];
  if (args.dryRun) {
    lines.push(`  would run: git push --force origin ${localBranch}:${sourceBranch}`);
    return { exitCode: 0, output: lines };
  }
  try {
    execSync(`git push --force origin ${localBranch}:${sourceBranch}`, { cwd: args.repoRoot, stdio: "inherit" });
  } catch {
    return {
      exitCode: 1,
      output: [...lines, `[serve dev sync] git push failed. Check push permissions on origin/${sourceBranch}.`],
    };
  }
  lines.push(`[serve dev sync] done. The dev-deploy workflow on origin/${sourceBranch} will fire next.`);
  return { exitCode: 0, output: lines };
}

function planDown(args: DevVerbArgs, profile: ProfileConfig): DevVerbResult {
  const overlay = profile.compose_overlay;
  const lines: string[] = ["[serve dev down]"];
  if (!overlay) {
    return { exitCode: 64, output: ["[serve dev down] no compose_overlay set; nothing to stop."] };
  }
  const cmd = args.prune
    ? `docker compose -f ${overlay} down -v`
    : `docker compose -f ${overlay} down`;
  lines.push(`  cmd: ${cmd}`);
  return { exitCode: 0, output: lines };
}

function planLogs(args: DevVerbArgs, profile: ProfileConfig): DevVerbResult {
  const overlay = profile.compose_overlay;
  if (!overlay) {
    return { exitCode: 64, output: ["[serve dev logs] no compose_overlay set; nothing to tail."] };
  }
  const follow = args.follow ? "-f" : "";
  const service = args.service ?? "";
  return {
    exitCode: 0,
    output: [`  cmd: docker compose -f ${overlay} logs ${follow} ${service}`.replace(/\s+/g, " ").trim()],
  };
}
