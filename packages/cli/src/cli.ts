#!/usr/bin/env node
import { guard } from "./commands/guard.js";
import { manifest } from "./commands/manifest.js";
import { init } from "./commands/init/index.js";

const VERSION = "0.3.0";

const USAGE = `
slowcook — TDD-first agentic development harness

Usage:
  slowcook init [--owner <handle>] [--force] [--dry-run] [--cwd <path>]
  slowcook guard --base <ref> --head <ref> [--override] [--config <path>]
  slowcook manifest record [--stack-config <path>] [--manifest <path>] [--story <id>]
  slowcook manifest verify [--stack-config <path>] [--manifest <path>] [--story <id>]
  slowcook version
  slowcook help

Commands available in ${VERSION}:
  init        Scaffold slowcook configuration in a consumer project.
  guard       Check for frozen-path violations between two git refs.
  manifest    Record or verify the set of discoverable tests.

Coming in later versions:
  refine, testgen, brew, review, dashboard

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
