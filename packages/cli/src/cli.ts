#!/usr/bin/env node
import { guard } from "./commands/guard.js";

const VERSION = "0.1.0";

const USAGE = `
slowcook — TDD-first agentic development harness

Usage:
  slowcook guard --base <ref> --head <ref> [--override] [--config <path>]
  slowcook version
  slowcook help

Commands available in ${VERSION}:
  guard       Check for frozen-path violations between two git refs.

Coming in later versions:
  init, manifest, refine, testgen, brew, review, dashboard

Docs: https://github.com/aminazar/slowcook
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "guard":
      await guard(args.slice(1));
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
