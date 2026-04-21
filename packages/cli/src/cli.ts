#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { guard } from "./commands/guard.js";
import { manifest } from "./commands/manifest.js";
import { init } from "./commands/init/index.js";
import { refine } from "./commands/refine/index.js";
import { onSpecMerged } from "./commands/on-spec-merged/index.js";
import { testgen } from "./commands/testgen/index.js";
import { catchup } from "./commands/catchup/index.js";
import { brew } from "./commands/brew/index.js";
import { map } from "./commands/map/index.js";

// Read VERSION from package.json at runtime so the CLI's self-reported
// version, the spec's `refined_by` field, and the init template's workflow
// pin all stay in lockstep with the package version. Prevents the silent
// drift seen in 0.4.0–0.4.4 (cli.ts stayed at 0.4.0 while package.json
// bumped through 0.4.4).
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(__dirname, "..", "package.json");
const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0-unknown";
  } catch {
    return "0.0.0-unknown";
  }
})();

const USAGE = `
slowcook — TDD-first agentic development harness

Usage:
  slowcook init [--owner <handle>] [--force] [--dry-run] [--cwd <path>]
  slowcook guard --base <ref> --head <ref> [--override] [--config <path>]
  slowcook manifest record [--stack-config <path>] [--manifest <path>] [--story <id>]
  slowcook manifest verify [--stack-config <path>] [--manifest <path>] [--story <id>]
  slowcook refine --issue <number> [--cwd <path>] [--owner <login>] [--repo <name>]
  slowcook on-spec-merged --pr <number> [--cwd <path>]
  slowcook testgen [--spec <id>] [--all] [--cwd <path>]
  slowcook catchup [--dry-run] [--cwd <path>]
  slowcook brew --story <id> [--budget-usd <n>] [--max-iterations <n>] [--model <id>]
  slowcook map (generate|check) [--cwd <path>] [--out <path>] [--md <path>]
  slowcook version
  slowcook help

Commands available in ${VERSION}:
  init               Scaffold slowcook configuration in a consumer project.
  guard              Check for frozen-path violations between two git refs.
  manifest           Record or verify the set of discoverable tests.
  refine             Drive a GitHub issue toward a frozen spec (refinement agent).
  on-spec-merged     Transition source-issue labels after a spec PR merges.
  testgen            Generate Vitest integration tests from merged specs.
  catchup            Detect + run pipeline steps that should have triggered but didn't.
  brew               Ratcheted implementation loop: flip red tests to green for one story.
  map                Generate / check the repo-wide code map (APIs, pages, components, helpers, types).

Coming in later versions:
  review, dashboard

Docs: https://github.com/aminazar/slowcook
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "init":
      await init(args.slice(1), VERSION);
      return;
    case "guard":
      await guard(args.slice(1));
      return;
    case "manifest":
      await manifest(args.slice(1));
      return;
    case "refine":
      await refine(args.slice(1), VERSION);
      return;
    case "on-spec-merged":
      await onSpecMerged(args.slice(1));
      return;
    case "testgen":
      await testgen(args.slice(1), VERSION);
      return;
    case "catchup":
      await catchup(args.slice(1), VERSION);
      return;
    case "brew":
      await brew(args.slice(1), VERSION);
      return;
    case "map":
      await map(args.slice(1), VERSION);
      return;
    case "version":
    case "--version":
    case "-v":
      console.log(`slowcook ${VERSION}`);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    default:
      console.error(`Unknown command: ${command}\n${USAGE}`);
      process.exit(64); // EX_USAGE
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
