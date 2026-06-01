/**
 * `slowcook serve <profile> <verb>` — multi-mode dev/mock/staging.
 *
 * See `docs/plans/0.20-design-discussions.md` design #5.
 *
 * Phase 1 (this cut): `serve dev` is implemented end-to-end. `serve
 * mock` and `serve staging` parse config + print a "Phase 2/3 stub"
 * notice; the runtime implementation lands in tasks #20 / #21.
 *
 * Backward-compat: `slowcook dev-env <verb>` continues to work as an
 * alias for `slowcook serve dev <verb>` (wired in cli.ts).
 */

import { loadServeConfig, getProfile, type ServeConfig } from "./config.js";
import { planServeDev, type DevVerbArgs, type DevVerbResult } from "./dev.js";

export interface ServeArgs {
  profile?: string;
  verb?: string;
  branch?: string;
  story?: string;
  service?: string;
  follow?: boolean;
  prune?: boolean;
  repoRoot: string;
  dryRun?: boolean;
}

export function parseServeArgs(argv: string[]): ServeArgs {
  const args: ServeArgs = { repoRoot: process.cwd() };
  // First two positionals (if present + not flags) are profile + verb.
  let positionalIdx = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (a.startsWith("-")) {
      const next = argv[i + 1];
      if (a === "--branch" && next) { args.branch = next; i++; }
      else if (a === "--story" && next) { args.story = next; i++; }
      else if (a === "--service" && next) { args.service = next; i++; }
      else if (a === "--cwd" && next) { args.repoRoot = next; i++; }
      else if (a === "--follow" || a === "-f") { args.follow = true; }
      else if (a === "--prune") { args.prune = true; }
      else if (a === "--dry-run") { args.dryRun = true; }
      else if (a === "--help" || a === "-h") { args.verb = "--help"; }
      continue;
    }
    if (positionalIdx === 0) { args.profile = a; positionalIdx++; }
    else if (positionalIdx === 1) { args.verb = a; positionalIdx++; }
  }
  return args;
}

export function printHelp(): void {
  console.log(`
slowcook serve — multi-mode dev / mock / staging on a shared box

Usage:
  slowcook serve <profile> <verb> [options]

Profiles:
  dev      — Phase 1 (this release). Bind-mount source for fast UI iteration.
  mock     — Phase 2 (coming soon). Vite-dev mock app for vibe feedback loops.
  staging  — Phase 3 (coming soon). Built-image staging + named-scenario seed reset.

Verbs:
  up                 Bring up the profile's compose overlay.
  sync [--branch X]  Force-push branch X (or current HEAD) to the profile's source_branch.
  down [--prune]     Stop the profile's services. --prune also drops volumes.
  logs [--service]   Tail logs (optionally one service). --follow / -f for tail -f.
  reset              No-op for dev/mock; seed-scenario reset for staging (Phase 3).

Backward-compat:
  slowcook dev-env push  ≡  slowcook serve dev sync
  slowcook dev-env up    ≡  slowcook serve dev up
  slowcook dev-env reset ≡  slowcook serve dev reset

Config:
  .brewing/serve.yaml (new, optional) OR .brewing/dev-env.yaml (legacy).
  See \`docs/plans/0.20-design-discussions.md\` design #5 for the schema.

Examples:
  slowcook serve dev up
  slowcook serve dev sync --story 042
  slowcook serve dev logs --service patient --follow
  slowcook serve dev down --prune
`);
}

export async function serve(argv: string[]): Promise<void> {
  const args = parseServeArgs(argv);
  if (args.verb === "--help" || (!args.profile && !args.verb)) {
    printHelp();
    return;
  }
  if (!args.profile) {
    console.error("slowcook serve: missing <profile>. Try `slowcook serve --help`.");
    process.exit(64);
  }
  if (!args.verb) {
    console.error(`slowcook serve ${args.profile}: missing <verb>. Try \`slowcook serve --help\`.`);
    process.exit(64);
  }

  let config: ServeConfig;
  try {
    config = loadServeConfig(args.repoRoot);
  } catch (e) {
    console.error(`slowcook serve: ${(e as Error).message}`);
    process.exit(64);
  }

  const profile = getProfile(config, args.profile);
  if (!profile) {
    const available = Object.keys(config.profiles).join(", ") || "(none)";
    console.error(`slowcook serve: profile "${args.profile}" not found in config. Available: ${available}.`);
    process.exit(64);
  }

  switch (args.profile) {
    case "dev": {
      const result = runDevVerb(args, config, profile);
      for (const line of result.output) console.log(line);
      if (result.exitCode !== 0) process.exit(result.exitCode);
      return;
    }
    case "mock":
      console.log(
        `[serve mock] Phase 2 stub. Compose overlay would target: ${profile.compose_overlay ?? "(unset)"}.`,
      );
      console.log("Phase 2 implementation tracked at task #20 in the 0.20 cut.");
      return;
    case "staging":
      console.log(
        `[serve staging] Phase 3 stub. Mode: ${profile.mode}; scenarios: ${
          profile.seed?.scenarios ? Object.keys(profile.seed.scenarios).join(", ") || "(none)" : "(none)"
        }.`,
      );
      console.log("Phase 3 implementation tracked at task #21 in the 0.20 cut.");
      return;
    default:
      console.error(`slowcook serve: profile "${args.profile}" has no runtime in this release.`);
      process.exit(64);
  }
}

function runDevVerb(args: ServeArgs, config: ServeConfig, profile: ReturnType<typeof getProfile>): DevVerbResult {
  if (!profile) throw new Error("unreachable");
  const devArgs: DevVerbArgs = {
    verb: args.verb!,
    branch: args.branch,
    story: args.story,
    service: args.service,
    follow: args.follow,
    prune: args.prune,
    repoRoot: args.repoRoot,
    dryRun: args.dryRun,
  };
  return planServeDev(devArgs, config, profile);
}
