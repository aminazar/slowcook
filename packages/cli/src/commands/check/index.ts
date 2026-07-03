/**
 * `slowcook check <subcommand>` — 0.16.0-α.13.
 *
 * Static structural checks slowcook offers.
 *
 * Subcommands:
 *   - `mock-isolation`  — every mock/ import resolves inside mock/
 *   - `spec`            — re-run spec content validators on PRs touching
 *                          specs/story-*.yaml (0.19.4-α / sc#146 #2)
 *
 * More to come (e.g. `mock-runtime-exports` to whitelist hooks vibe
 * may import; `port-provenance` to verify src/ files copied via port
 * carry the marker).
 */

import { runMockIsolationCheck } from "./mock-isolation.js";
import { runSpecValidateCli } from "./spec-validate.js";
import { runProdHonestyCli } from "./prod-honesty.js";
import { runProdBundleCli } from "./prod-bundle.js";

export async function check(argv: string[], _cliVersion: string): Promise<void> {
  const sub = argv[0];
  switch (sub) {
    case "mock-isolation":
      return runMockIsolationCli(argv.slice(1));
    case "spec":
      return runSpecValidateCli(argv.slice(1));
    case "prod-honesty":
      return runProdHonestyCli(argv.slice(1));
    case "prod-bundle":
      return runProdBundleCli(argv.slice(1));
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      console.error(`Unknown check: ${sub}`);
      printHelp();
      process.exit(64);
  }
}

function printHelp(): void {
  console.log(`
slowcook check — static structural checks (0.16-α.13)

Usage:
  slowcook check mock-isolation [--cwd <path>]
  slowcook check prod-honesty [--cwd <path>] [--dir <src>]
  slowcook check prod-bundle [--cwd <path>] [--dist <dist>]
  slowcook check spec [file...] [--cwd <path>]

Subcommands:
  mock-isolation   Verify every import in mock/ stays inside mock/.
                   Catches vibe-prompt slippage where a mock component
                   tries to import from the consumer's production src/.
  spec             Re-run spec content validators on one or more spec
                   files. Catches drift on amendment commits that
                   bypass refine's in-process lint.

Exit codes:
  0  no violations
  1  violations reported
`);
}

function runMockIsolationCli(argv: string[]): void {
  let cwd = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cwd" && argv[i + 1]) {
      cwd = argv[i + 1]!;
      i++;
    }
  }
  const result = runMockIsolationCheck(cwd);
  if (result.filesChecked === 0) {
    console.log(`slowcook check mock-isolation: no mock/ directory at ${cwd}; nothing to check.`);
    return;
  }
  if (result.violations.length === 0) {
    console.log(`slowcook check mock-isolation: ${result.filesChecked} file(s) clean.`);
    return;
  }
  console.error(
    `slowcook check mock-isolation: ${result.violations.length} violation(s) across ${result.filesChecked} file(s).\n`
  );
  for (const v of result.violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    import: ${JSON.stringify(v.importPath)}`);
    console.error(`    reason: ${v.reason}\n`);
  }
  console.error(
    `Vibe + plate must keep mock/ self-contained: no imports outside mock/. ` +
      `Inline what you need OR write the dependency at mock/src/...`
  );
  process.exit(1);
}
