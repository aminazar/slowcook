/**
 * `slowcook serve staging <verb>` — Phase 3 implementation.
 *
 * The staging profile runs a built-image deployment for PM walkthroughs +
 * manual QA. Distinct from `dev` (bind-mount source) and `mock` (vite-dev):
 *
 *   - mode: built-image (Trade-off #3 — slowcook ships zero image-build;
 *     consumer's `bringup_cmd` does the heavy lifting).
 *   - reset: named-scenario re-seed via `seed.scenarios: {demo: ..., ...}`
 *     (Trade-off #5 — map shape from day 1; no single-value form).
 *
 * Verbs (Phase 3):
 *   - up      — bring up the staging profile via consumer's bringup_cmd
 *   - sync    — push the staging-tracking branch (default `main`); the
 *               box's CI/deploy chain picks it up + rebuilds the image
 *   - down    — stop the profile's services (volumes preserved)
 *   - logs    — pass-through to docker-compose logs
 *   - reset --scenario <name> — re-run the named scenario's seed scripts;
 *               protected by the optional `seed.guard_env` env-var sentinel
 *               to prevent accidental wipes from interactive sessions.
 *
 * Per design #5 "Additional decisions" — the staging seed is idempotent;
 * each scenario's scripts MUST be re-runnable. Slowcook just invokes them
 * via `ts-node` (Trade-off #2) inside the container.
 */

import { execSync } from "node:child_process";
import type { ProfileConfig, ServeConfig } from "./config.js";
import type { DevVerbResult } from "./dev.js";

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
      return {
        exitCode: 64,
        output: [`Unknown verb: ${args.verb}. See \`slowcook serve --help\`.`],
      };
  }
}

function planUp(_args: StagingVerbArgs, profile: ProfileConfig): DevVerbResult {
  const lines: string[] = [`[serve staging up] mode: ${profile.mode}`];
  if (profile.bringup_cmd) {
    // Trade-off #3 — consumer's bring-up runs the show. Slowcook just shells out.
    lines.push(`  cmd: ${profile.bringup_cmd}`);
    return { exitCode: 0, output: lines };
  }
  if (profile.compose_overlay) {
    lines.push(`  cmd: docker compose -f ${profile.compose_overlay} up -d`);
    return { exitCode: 0, output: lines };
  }
  return {
    exitCode: 64,
    output: ["[serve staging up] neither bringup_cmd nor compose_overlay set; nothing to bring up."],
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
  const lines = [`[serve staging sync] ${localBranch} → origin/${sourceBranch} (staging-deploy CI rebuilds)`];
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
      output: [...lines, `[serve staging sync] git push failed. Check push permissions on origin/${sourceBranch}.`],
    };
  }
  lines.push(`[serve staging sync] done.`);
  return { exitCode: 0, output: lines };
}

function planDown(args: StagingVerbArgs, profile: ProfileConfig): DevVerbResult {
  if (!profile.compose_overlay) {
    return { exitCode: 64, output: ["[serve staging down] no compose_overlay set; nothing to stop."] };
  }
  const cmd = args.prune
    ? `docker compose -f ${profile.compose_overlay} down -v`
    : `docker compose -f ${profile.compose_overlay} down`;
  return { exitCode: 0, output: ["[serve staging down]", `  cmd: ${cmd}`] };
}

function planLogs(args: StagingVerbArgs, profile: ProfileConfig): DevVerbResult {
  if (!profile.compose_overlay) {
    return { exitCode: 64, output: ["[serve staging logs] no compose_overlay set; nothing to tail."] };
  }
  const follow = args.follow ? "-f" : "";
  const service = args.service ?? "";
  return {
    exitCode: 0,
    output: [`  cmd: docker compose -f ${profile.compose_overlay} logs ${follow} ${service}`.replace(/\s+/g, " ").trim()],
  };
}

/**
 * `serve staging reset --scenario <name>` — re-run the named scenario's
 * seed scripts. Idempotency is the seed-script author's job; slowcook
 * just invokes them via ts-node (Trade-off #2 — runtime model locked).
 *
 * Guard: if `seed.guard_env` is set in the profile, the named env var
 * must be non-empty in the caller's environment. Prevents accidental
 * wipes from an interactive `serve staging reset`.
 */
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
  const lines: string[] = [`[serve staging reset] scenario=${args.scenario}`];
  for (const script of scenario.scripts) {
    lines.push(`  ts-node ${script}`);
  }
  if (args.dryRun || scenario.scripts.length === 0) {
    return { exitCode: 0, output: lines };
  }
  // Real reset: shell out to ts-node for each script. Idempotency is the
  // seed-script author's contract; slowcook bails on any non-zero exit.
  for (const script of scenario.scripts) {
    try {
      execSync(`pnpm exec ts-node ${script}`, { cwd: args.repoRoot, stdio: "inherit" });
    } catch {
      lines.push(`[serve staging reset] script ${script} failed; aborting.`);
      return { exitCode: 1, output: lines };
    }
  }
  lines.push(`[serve staging reset] scenario=${args.scenario} complete.`);
  return { exitCode: 0, output: lines };
}
