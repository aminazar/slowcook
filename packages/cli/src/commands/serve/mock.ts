/**
 * `slowcook serve mock <verb>` — Phase 2 implementation.
 *
 * The mock profile runs the consumer's `mock/` package as a vite-dev
 * server on a shared box. See `dev.ts` header for the broader pattern.
 *
 * 0.19.7 (sc#173): same refactor as dev.ts — emit ShellCommand[] so
 * runCommands() can actually execute (including ssh-wrapping for the
 * remote case); support `compose_files` multi-`-f`; suppress `--build`
 * for `bind-mount-source`.
 */

import { execSync } from "node:child_process";
import type { ProfileConfig, ServeConfig } from "./config.js";
import { composeFiles, shouldBuildOnUp } from "./config.js";
import type { DevVerbResult } from "./dev.js";
import type { ShellCommand } from "./runner.js";

export interface MockVerbArgs {
  verb: string;
  branch?: string;
  service?: string;
  follow?: boolean;
  prune?: boolean;
  repoRoot: string;
  dryRun?: boolean;
}

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
      return { exitCode: 64, output: [`Unknown verb: ${args.verb}. See \`slowcook serve --help\`.`] };
  }
}

function planUp(_args: MockVerbArgs, profile: ProfileConfig): DevVerbResult {
  const files = composeFiles(profile);
  const apps = Object.keys(profile.apps);
  const output: string[] = [`[serve mock up] bringing up: ${apps.join(", ") || "(no apps configured)"}`];

  if (files.length === 0) {
    // Fallback: no compose, run `pnpm --filter ./mock dev` locally. Used on
    // a dev's laptop without a docker box.
    output.push("  (no compose_files / compose_overlay set; falling back to local pnpm filter)");
    return {
      exitCode: 0,
      output,
      commands: [{ cmd: "pnpm --filter ./mock dev", remote: false, label: "vite dev" }],
    };
  }

  // PM + designer reference URL: surface the vite port if exactly one app.
  if (apps.length === 1) {
    const vitePort = profile.apps[apps[0]!]!.port;
    output.push(`  vite dev URL (once up): http://<your-box>:${vitePort}`);
  }
  const fileFlags = files.map((f) => `-f ${f}`).join(" ");
  const buildFlag = shouldBuildOnUp(profile) ? " --build" : "";
  return {
    exitCode: 0,
    output,
    commands: [{ cmd: `docker compose ${fileFlags} up -d${buildFlag}`, remote: true, label: "bring up" }],
  };
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
  return {
    exitCode: 0,
    output: [`[serve mock sync] ${localBranch} → origin/${sourceBranch}`],
    commands: [{ cmd: `git push --force origin ${localBranch}:${sourceBranch}`, remote: false, label: "git push" }],
  };
}

function planDown(args: MockVerbArgs, profile: ProfileConfig): DevVerbResult {
  const files = composeFiles(profile);
  if (files.length === 0) {
    return { exitCode: 64, output: ["[serve mock down] no compose_files / compose_overlay set; nothing to stop."] };
  }
  const fileFlags = files.map((f) => `-f ${f}`).join(" ");
  const cmd = args.prune
    ? `docker compose ${fileFlags} down -v`
    : `docker compose ${fileFlags} down`;
  return { exitCode: 0, output: ["[serve mock down]"], commands: [{ cmd, remote: true, label: "compose down" }] };
}

function planLogs(args: MockVerbArgs, profile: ProfileConfig): DevVerbResult {
  const files = composeFiles(profile);
  if (files.length === 0) {
    return { exitCode: 64, output: ["[serve mock logs] no compose_files / compose_overlay set; nothing to tail."] };
  }
  const fileFlags = files.map((f) => `-f ${f}`).join(" ");
  const follow = args.follow ? "-f" : "";
  const service = args.service ?? "";
  const cmd = `docker compose ${fileFlags} logs ${follow} ${service}`.replace(/\s+/g, " ").trim();
  return { exitCode: 0, output: ["[serve mock logs]"], commands: [{ cmd, remote: true, label: "compose logs" }] };
}
