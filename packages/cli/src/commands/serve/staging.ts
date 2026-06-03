/**
 * `slowcook serve staging <verb>` — Phase 3 implementation.
 *
 * The staging profile runs a built-image deployment for PM walkthroughs.
 *
 * 0.19.7 (sc#173): same refactor as dev.ts / mock.ts — emit
 * ShellCommand[] for the cli wrapper to execute via runCommands(),
 * supporting ssh-wrap when `ssh_target` is set; honour `compose_files`
 * multi-`-f`; pass `--build` (staging IS built-image).
 *
 * `reset --scenario <name>` re-runs the named scenario's seed scripts.
 * Idempotency is the seed-script author's contract; slowcook bails on
 * any non-zero exit. Optional `seed.guard_env` blocks accidental wipes.
 */

import { execSync } from "node:child_process";
import type { ProfileConfig, ServeConfig } from "./config.js";
import { composeFiles, shouldBuildOnUp } from "./config.js";
import type { DevVerbResult } from "./dev.js";
import type { ShellCommand } from "./runner.js";

export interface StagingVerbArgs {
  verb: string;
  branch?: string;
  scenario?: string;
  service?: string;
  follow?: boolean;
  prune?: boolean;
  repoRoot: string;
  dryRun?: boolean;
}

export function planServeStaging(
  args: StagingVerbArgs,
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
      return planReset(args, profile);
    default:
      return { exitCode: 64, output: [`Unknown verb: ${args.verb}. See \`slowcook serve --help\`.`] };
  }
}

function planUp(_args: StagingVerbArgs, profile: ProfileConfig): DevVerbResult {
  const output: string[] = [`[serve staging up] mode: ${profile.mode}`];

  // Trade-off #3: when consumer's bringup_cmd is set, slowcook just shells it out.
  if (profile.bringup_cmd) {
    return {
      exitCode: 0,
      output,
      commands: [{ cmd: profile.bringup_cmd, remote: true, label: "bring up" }],
    };
  }

  const files = composeFiles(profile);
  if (files.length === 0) {
    return {
      exitCode: 64,
      output: ["[serve staging up] neither bringup_cmd nor compose_files / compose_overlay set; nothing to bring up."],
    };
  }
  const fileFlags = files.map((f) => `-f ${f}`).join(" ");
  const buildFlag = shouldBuildOnUp(profile) ? " --build" : "";
  return {
    exitCode: 0,
    output,
    commands: [{ cmd: `docker compose ${fileFlags} up -d${buildFlag}`, remote: true, label: "bring up" }],
  };
}

function planSync(args: StagingVerbArgs, profile: ProfileConfig): DevVerbResult {
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
      output: ["[serve staging sync] couldn't resolve a local branch (detached HEAD?). Pass --branch <name>."],
    };
  }
  return {
    exitCode: 0,
    output: [`[serve staging sync] ${localBranch} → origin/${sourceBranch} (staging-deploy CI rebuilds)`],
    commands: [{ cmd: `git push --force origin ${localBranch}:${sourceBranch}`, remote: false, label: "git push" }],
  };
}

function planDown(args: StagingVerbArgs, profile: ProfileConfig): DevVerbResult {
  const files = composeFiles(profile);
  if (files.length === 0) {
    return { exitCode: 64, output: ["[serve staging down] no compose_files / compose_overlay set; nothing to stop."] };
  }
  const fileFlags = files.map((f) => `-f ${f}`).join(" ");
  const cmd = args.prune
    ? `docker compose ${fileFlags} down -v`
    : `docker compose ${fileFlags} down`;
  return { exitCode: 0, output: ["[serve staging down]"], commands: [{ cmd, remote: true, label: "compose down" }] };
}

function planLogs(args: StagingVerbArgs, profile: ProfileConfig): DevVerbResult {
  const files = composeFiles(profile);
  if (files.length === 0) {
    return { exitCode: 64, output: ["[serve staging logs] no compose_files / compose_overlay set; nothing to tail."] };
  }
  const fileFlags = files.map((f) => `-f ${f}`).join(" ");
  const follow = args.follow ? "-f" : "";
  const service = args.service ?? "";
  const cmd = `docker compose ${fileFlags} logs ${follow} ${service}`.replace(/\s+/g, " ").trim();
  return { exitCode: 0, output: ["[serve staging logs]"], commands: [{ cmd, remote: true, label: "compose logs" }] };
}

function planReset(args: StagingVerbArgs, profile: ProfileConfig): DevVerbResult {
  if (!args.scenario) {
    const available = profile.seed?.scenarios ? Object.keys(profile.seed.scenarios) : [];
    return {
      exitCode: 64,
      output: [
        "[serve staging reset] --scenario <name> required.",
        `  available scenarios: ${available.length ? available.join(", ") : "(none — declare seed.scenarios in serve.yaml)"}`,
      ],
    };
  }
  const scenario = profile.seed?.scenarios[args.scenario];
  if (!scenario) {
    const available = profile.seed?.scenarios ? Object.keys(profile.seed.scenarios) : [];
    return {
      exitCode: 64,
      output: [
        `[serve staging reset] scenario "${args.scenario}" not found in seed.scenarios.`,
        `  available: ${available.length ? available.join(", ") : "(none)"}`,
      ],
    };
  }
  if (profile.seed?.guard_env) {
    const guard = profile.seed.guard_env;
    const value = process.env[guard];
    if (!value) {
      return {
        exitCode: 1,
        output: [
          `[serve staging reset] blocked — guard env \`${guard}\` is not set.`,
          `  set ${guard}=1 in this shell to authorise a reset.`,
        ],
      };
    }
  }
  const output: string[] = [`[serve staging reset] scenario=${args.scenario}`];
  const commands: ShellCommand[] = scenario.scripts.map((script) => ({
    cmd: `pnpm exec ts-node ${script}`,
    remote: true,
    label: `seed ${script}`,
  }));
  return { exitCode: 0, output, commands };
}
