/**
 * `slowcook serve dev <verb>` — Phase 1 implementation.
 *
 * Verbs (Phase 1):
 *   - up      — bring up the dev profile (compose overlay or fallback)
 *   - sync    — push source-branch + restart bind-mount targets
 *   - down    — stop the profile's services (volumes preserved)
 *   - logs    — pass-through to docker-compose logs
 *   - reset   — no-op for dev profile (only meaningful for staging)
 *
 * Backward-compat aliases preserved on the cli switch:
 *   - `slowcook dev-env push --branch X` ≡ `slowcook serve dev sync --branch X`
 *   - `slowcook dev-env up` ≡ `slowcook serve dev up`
 *   - `slowcook dev-env reset` ≡ `slowcook serve dev reset` (no-op + notice)
 *
 * 0.19.7 (sc#173 fixes):
 *   - Planner populates `commands[]` (structured ShellCommand records).
 *     The cli wrapper invokes runCommands() to actually execute (or
 *     dry-run); previously `up`/`down`/`logs` were planners only.
 *   - Compose-file layering: respects `profile.compose_files` (multi-`-f`)
 *     OR `compose_overlay` (single). Real consumers need base+overlay.
 *   - `--build` flag is suppressed for `bind-mount-source` mode (the
 *     mode's whole point is skipping the build loop).
 */

import { execSync } from "node:child_process";
import type { ProfileConfig, ServeConfig } from "./config.js";
import { composeFiles, shouldBuildOnUp } from "./config.js";
import { planWatchdog } from "./watchdog.js";
import type { ShellCommand } from "./runner.js";

export interface DevVerbArgs {
  verb: string;
  branch?: string;
  story?: string;
  service?: string;
  follow?: boolean;
  prune?: boolean;
  repoRoot: string;
  /** Test seam: report the plan but skip actual git rev-parse. */
  dryRun?: boolean;
}

export interface DevVerbResult {
  exitCode: number;
  /** Human narrative emitted by the planner. */
  output: string[];
  /** Shell commands the cli wrapper should execute (in order). */
  commands?: ShellCommand[];
}

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
    case "watchdog":
    case "watchdog-once":
      return planWatchdog(args, profile);
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
  const files = composeFiles(profile);
  const apps = Object.keys(profile.apps);
  const output: string[] = [`[serve dev up] bringing up: ${apps.join(", ") || "(no apps configured)"}`];

  if (files.length === 0) {
    output.push("  (no compose_files / compose_overlay set; declare one in serve.yaml)");
    return { exitCode: 64, output };
  }

  const fileFlags = files.map((f) => `-f ${f}`).join(" ");
  const buildFlag = shouldBuildOnUp(profile) ? " --build" : "";
  const commands: ShellCommand[] = [
    { cmd: `docker compose ${fileFlags} up -d${buildFlag}`, remote: true, label: "bring up" },
  ];
  if (profile.seed_script) {
    commands.push({ cmd: `pnpm exec ts-node ${profile.seed_script}`, remote: true, label: "seed" });
  }
  return { exitCode: 0, output, commands };
}

function planSync(args: DevVerbArgs, profile: ProfileConfig): DevVerbResult {
  const sourceBranch = profile.source_branch;
  let localBranch = args.branch;
  if (!localBranch && !args.dryRun) {
    try {
      localBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: args.repoRoot, encoding: "utf8" }).trim();
    } catch {
      // handled below
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
  const output: string[] = [
    `[serve dev sync] ${localBranch} → origin/${sourceBranch}${args.story ? ` (story-${args.story})` : ""}`,
  ];
  const commands: ShellCommand[] = [
    { cmd: `git push --force origin ${localBranch}:${sourceBranch}`, remote: false, label: "git push" },
  ];
  return { exitCode: 0, output, commands };
}

function planDown(args: DevVerbArgs, profile: ProfileConfig): DevVerbResult {
  const files = composeFiles(profile);
  if (files.length === 0) {
    return { exitCode: 64, output: ["[serve dev down] no compose_files / compose_overlay set; nothing to stop."] };
  }
  const fileFlags = files.map((f) => `-f ${f}`).join(" ");
  const cmd = args.prune
    ? `docker compose ${fileFlags} down -v`
    : `docker compose ${fileFlags} down`;
  return {
    exitCode: 0,
    output: ["[serve dev down]"],
    commands: [{ cmd, remote: true, label: "compose down" }],
  };
}

function planLogs(args: DevVerbArgs, profile: ProfileConfig): DevVerbResult {
  const files = composeFiles(profile);
  if (files.length === 0) {
    return { exitCode: 64, output: ["[serve dev logs] no compose_files / compose_overlay set; nothing to tail."] };
  }
  const fileFlags = files.map((f) => `-f ${f}`).join(" ");
  const follow = args.follow ? "-f" : "";
  const service = args.service ?? "";
  const cmd = `docker compose ${fileFlags} logs ${follow} ${service}`.replace(/\s+/g, " ").trim();
  return {
    exitCode: 0,
    output: ["[serve dev logs]"],
    commands: [{ cmd, remote: true, label: "compose logs" }],
  };
}
