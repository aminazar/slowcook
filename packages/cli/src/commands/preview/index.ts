/**
 * `slowcook preview <subcommand>` dispatch — 0.16.0-α.5.
 *
 * Subcommands:
 *   - `slowcook preview deploy --pr <n>`   — build + run + post URL
 *   - `slowcook preview teardown --pr <n>` — stop + remove + mark
 */

import { deploy } from "./deploy.js";
import { teardown } from "./teardown.js";

export async function preview(argv: string[], cliVersion: string): Promise<void> {
  const sub = argv[0];
  switch (sub) {
    case "deploy":
      await deploy(argv.slice(1), cliVersion);
      return;
    case "teardown":
      await teardown(argv.slice(1), cliVersion);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      console.error(`Unknown preview subcommand: ${sub}`);
      printHelp();
      process.exit(64);
  }
}

function printHelp(): void {
  console.log(`
slowcook preview — SSH preview deploy for the consumer's mock app (0.16-α.5)

Usage:
  slowcook preview deploy   --pr <n> [--ssh-key <path>] [--cwd <path>] [--owner <login>] [--repo <name>] [--dry-run]
  slowcook preview teardown --pr <n> [--ssh-key <path>] [--cwd <path>] [--owner <login>] [--repo <name>] [--prune-image] [--dry-run]

Reads .brewing/preview.yaml for SSH host / user / port range / URL
template / remote root. See docs/operating-guide.md for the schema +
box setup steps.

Common options:
  --pr <n>             PR number to deploy/teardown for. REQUIRED.
  --ssh-key <path>     Path to the SSH private key file. Defaults to
                       SLOWCOOK_PREVIEW_SSH_KEY_PATH.
  --cwd <path>         Repo root (default: cwd).
  --owner <login>      GitHub owner (default: detect from git remote).
  --repo <name>        GitHub repo  (default: detect from git remote).
  --dry-run            Print planned actions, don't ssh/scp/docker.

deploy-only:
  (none)

teardown-only:
  --prune-image        Also \`docker rmi\` the per-PR image (frees disk).

Environment:
  GITHUB_TOKEN                       For PR-comment upsert (otherwise skipped).
  SLOWCOOK_PREVIEW_SSH_KEY_PATH      Default for --ssh-key.

Workflow templates installed by \`slowcook init\`:
  .github/workflows/slowcook-preview-deploy.yml    fires on PR opened/synchronized with the slowcook-mockup label
  .github/workflows/slowcook-preview-teardown.yml  fires on PR closed
`);
}
