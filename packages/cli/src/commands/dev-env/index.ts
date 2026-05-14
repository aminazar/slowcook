/**
 * `slowcook dev-env <subcmd>` — manages the consumer's long-lived
 * dev/preview environment. Phase 2 of the dev-env design.
 *
 * Subcommands:
 *
 *   push --story <id> [--branch <name>]
 *     Force-push the current branch (or --branch) to the configured
 *     `source_branch` (default: `dev`). Agents (brew, plate) invoke
 *     this to preview their story-branch on the shared dev URL.
 *     Phase 3 wires this into brew/plate workflows automatically.
 *
 *   switch --story <id>
 *     Locate the PR for story <id>, force-push its HEAD to
 *     `source_branch`. Operator-driven version of `push`.
 *
 *   up | sync | reset
 *     Phase 2 stubs — print the canonical shell-out for the consumer
 *     to wire into their dev-deploy workflow. Phase 2.1 fills in the
 *     SSH-driven runtime path.
 *
 *   init
 *     Phase 2.1 stub — scaffold `.brewing/dev-env.yaml` from detected
 *     apps. Not implemented yet; consumers hand-author for now.
 */

import { execSync } from "node:child_process";
import { loadDevEnvConfig, type DevEnvConfig } from "./config.js";

interface ParsedArgs {
  subcommand: string;
  story?: string;
  branch?: string;
  repoRoot: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    subcommand: argv[0] ?? "help",
    repoRoot: process.cwd(),
  };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--story" && next) {
      args.story = next;
      i++;
    } else if (a === "--branch" && next) {
      args.branch = next;
      i++;
    } else if (a === "--cwd" && next) {
      args.repoRoot = next;
      i++;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook dev-env — manage the long-lived dev/preview environment

Subcommands:
  push --story <id> [--branch <name>]
      Force-push the current branch (or --branch) to the dev env's
      source_branch (default: dev). Agents invoke this to preview a
      story-branch on the shared dev URL.

  switch --story <id>
      Look up the PR for story <id> and push its HEAD to source_branch.

  up | sync | reset
      Phase 2 stubs — print the canonical shell-out for the consumer
      to wire into their dev-deploy workflow.

Config:
  .brewing/dev-env.yaml describes apps, modes, ports, ssh target, seed
  script. See slowcook's docs/dev-env.md for the schema.

Examples:
  slowcook dev-env push --story 001
  slowcook dev-env switch --story 001
`);
}

export async function devEnv(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  // help has no config dependency — render before anything else
  if (
    args.subcommand === "help" ||
    args.subcommand === "--help" ||
    args.subcommand === "-h"
  ) {
    printHelp();
    return;
  }

  let config: DevEnvConfig;
  try {
    config = loadDevEnvConfig(args.repoRoot);
  } catch (e) {
    console.error(`slowcook dev-env: ${(e as Error).message}`);
    process.exit(64);
  }

  switch (args.subcommand) {
    case "push":
      return runPush(args, config);
    case "switch":
      return runSwitch(args, config);
    case "up":
    case "sync":
    case "reset":
      return printStubShell(args.subcommand, config);
    default:
      console.error(`Unknown subcommand: ${args.subcommand}`);
      printHelp();
      process.exit(64);
  }
}

/**
 * Force-push the local branch to source_branch on origin. The git
 * mechanics are the load-bearing part of Phase 3's auto-preview flow.
 */
function runPush(args: ParsedArgs, config: DevEnvConfig): void {
  const sourceBranch = config.source_branch;
  const localBranch =
    args.branch ??
    execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: args.repoRoot,
      encoding: "utf8",
    }).trim();
  if (!localBranch || localBranch === "HEAD") {
    console.error(
      "slowcook dev-env push: couldn't resolve a local branch (detached HEAD?). Pass --branch <name>.",
    );
    process.exit(64);
  }
  console.log(
    `[dev-env push] ${localBranch} → origin/${sourceBranch}${args.story ? ` (story-${args.story})` : ""}`,
  );
  try {
    execSync(`git push --force origin ${localBranch}:${sourceBranch}`, {
      cwd: args.repoRoot,
      stdio: "inherit",
    });
  } catch {
    console.error(
      `slowcook dev-env push: git push failed. Check your push permissions on origin/${sourceBranch}.`,
    );
    process.exit(1);
  }
  console.log(
    `[dev-env push] done. dev-deploy workflow will fire on origin/${sourceBranch}.`,
  );
}

/**
 * Look up a PR by story id (via the gh CLI) and push its HEAD to
 * source_branch. For operator-driven "show me story X on the dev URL"
 * without checking out the branch locally.
 */
function runSwitch(args: ParsedArgs, config: DevEnvConfig): void {
  if (!args.story) {
    console.error("slowcook dev-env switch: --story <id> required.");
    process.exit(64);
  }
  const sourceBranch = config.source_branch;
  // Use the GitHub CLI to find the open PR for the story. gh is part
  // of slowcook's hard dependencies (already used by every other
  // command); fail clearly if missing.
  let prRef: string;
  try {
    const out = execSync(
      `gh pr list --search "story-${args.story} in:title" --json headRefName,number --limit 1 --jq '.[0].headRefName'`,
      { cwd: args.repoRoot, encoding: "utf8" },
    ).trim();
    if (!out) {
      console.error(
        `slowcook dev-env switch: no open PR found with "story-${args.story}" in the title.`,
      );
      process.exit(1);
    }
    prRef = out;
  } catch (e) {
    console.error(
      `slowcook dev-env switch: gh CLI failed — ${(e as Error).message.slice(0, 200)}`,
    );
    process.exit(1);
  }
  console.log(
    `[dev-env switch] story-${args.story} → ${prRef} → origin/${sourceBranch}`,
  );
  // Fetch the PR's branch + push it to source_branch.
  execSync(`git fetch origin ${prRef}`, {
    cwd: args.repoRoot,
    stdio: "inherit",
  });
  execSync(`git push --force origin origin/${prRef}:${sourceBranch}`, {
    cwd: args.repoRoot,
    stdio: "inherit",
  });
  console.log(`[dev-env switch] done.`);
}

/**
 * Stub for up / sync / reset — emits the canonical shell command the
 * consumer wires into their dev-deploy workflow. Phase 2.1 will fill
 * in the SSH-driven runtime path that respects ssh_target + apps[*].mode.
 */
function printStubShell(subcommand: string, config: DevEnvConfig): void {
  const apps = Object.keys(config.apps).join(", ");
  console.log(
    `slowcook dev-env ${subcommand}: phase-2 stub. Apps configured: ${apps}.`,
  );
  console.log("");
  switch (subcommand) {
    case "up":
      console.log("Wire this into your dev-deploy workflow:");
      console.log("  docker compose -f compose.dev.yml up -d --build");
      if (config.seed_script) {
        console.log(`  pnpm exec ts-node ${config.seed_script}`);
      }
      break;
    case "sync":
      console.log("Wire this into your dev-deploy workflow:");
      console.log(`  git fetch origin && git reset --hard origin/${config.source_branch}`);
      console.log("  pnpm install --prefer-frozen-lockfile && pnpm build");
      console.log("  docker compose -f compose.dev.yml up -d --build");
      break;
    case "reset":
      console.log("Wire this into your dev-deploy workflow:");
      if (config.seed_script) {
        console.log(`  pnpm exec ts-node ${config.seed_script} --reset`);
      } else {
        console.log("  (no seed_script configured — nothing to reset)");
      }
      break;
  }
}
