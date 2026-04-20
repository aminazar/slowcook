// Static and parameterized file contents written by `slowcook init`.
// Version is bumped in lockstep with the CLI package.

export const CLI_VERSION_FOR_TEMPLATES = "0.4.4";

export interface TemplateParams {
  /** CODEOWNERS handle or team (e.g. "@aminazar" or "@acme/frontend"). */
  owner: string;
  /** Whether the project has Playwright installed (affects stack.json comments). */
  hasPlaywright: boolean;
}

export const SLOWCOOK_CODEOWNERS_MARKER_BEGIN = "# --- slowcook:frozen-paths BEGIN ---";
export const SLOWCOOK_CODEOWNERS_MARKER_END = "# --- slowcook:frozen-paths END ---";

export function frozenPathsJson(): string {
  return (
    JSON.stringify(
      {
        $schema: "./frozen-paths.schema.json",
        $doc:
          "Paths frozen by slowcook. See https://github.com/aminazar/slowcook for the design. " +
          "To modify any of these: either get CODEOWNERS approval, or add the 'override-freeze' label " +
          "to the PR (guard runs in advisory mode, audit trail preserved).",
        directories: [
          "tests/",
          "tests-fixtures/",
          "tests-helpers/",
          ".brewing/manifests/",
        ],
        files: [
          "vitest.config.ts",
          "vitest.config.mjs",
          "vitest.config.js",
          ".brewing/frozen-paths.json",
          ".brewing/stack.json",
          ".github/workflows/slowcook.yml",
        ],
        partial: {
          "package.json": {
            frozen_key_paths: ["scripts.test", "scripts.test:watch"],
          },
        },
      },
      null,
      2
    ) + "\n"
  );
}

export function stackJson(params: TemplateParams): string {
  const doc =
    "Project-level stack configuration consumed by slowcook (@slowcook-ai/stack-ts). " +
    "Tells the harness how to discover and run tests. Only include suites that are " +
    "actually runnable — slowcook refuses to record an incomplete manifest." +
    (params.hasPlaywright
      ? " (Playwright detected in package.json; slowcook's playwright discovery is not yet " +
        "implemented, so the e2e suite is intentionally omitted. Add it back post-upgrade.)"
      : "");

  return (
    JSON.stringify(
      {
        $schema: "./stack.schema.json",
        $doc: doc,
        language: "typescript",
        package_manager: "npm",
        test: {
          backend: {
            runner: "vitest",
            run_command: "npx vitest run",
            discover_command: "npx vitest list",
            reporter_format: "vitest-list-lines",
          },
        },
        lint: {
          lint_command: "npm run lint",
          typecheck_command: "npm run typecheck",
        },
      },
      null,
      2
    ) + "\n"
  );
}

export function brewingReadme(): string {
  return `# \`.brewing/\`

Consumer-side configuration for [slowcook](https://github.com/aminazar/slowcook), a TDD-first agentic development harness.

## Contents

| Path | Purpose |
|---|---|
| \`frozen-paths.json\` | What's immutable during brewing (tests, configs, manifests) |
| \`stack.json\` | How slowcook invokes tests / coverage / lint for this project |
| \`manifests/\` | Per-story test manifests; populated by \`slowcook manifest record\` |

## Running slowcook locally

\`\`\`bash
npx --yes @slowcook-ai/cli@latest guard --base origin/main --head HEAD
npx --yes @slowcook-ai/cli@latest manifest record
npx --yes @slowcook-ai/cli@latest manifest verify
\`\`\`

## When you legitimately need to modify a frozen path

1. Open a PR with the change.
2. Add the \`override-freeze\` label to the PR.
3. Guard runs in advisory mode (surfaces violations but doesn't fail).
4. CODEOWNERS still requires explicit approval.
5. Merge audit trail: PR number + \`override-freeze\` label + approval.

Deliberately slightly inconvenient. Frozen-path changes are rare events that deserve a reviewer's eyes.
`;
}

export function slowcookWorkflow(cliVersion: string): string {
  return `name: slowcook

on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]

concurrency:
  group: slowcook-\${{ github.event.pull_request.number }}
  cancel-in-progress: true

# Pin CLI version for reproducibility; bump deliberately via a PR.
env:
  SLOWCOOK_CLI: "@slowcook-ai/cli@${cliVersion}"

jobs:
  check:
    name: slowcook checks
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install consumer deps
        # \`manifest verify\` shells out to the consumer's own test runner
        # (e.g. \`npx vitest list\`) which loads the project's test config.
        # Installing node_modules ensures that config can resolve its imports.
        run: npm ci

      - name: Guard — frozen paths
        env:
          HAS_OVERRIDE: \${{ contains(github.event.pull_request.labels.*.name, 'override-freeze') }}
        run: |
          set -eu
          ARGS="--base origin/\${{ github.base_ref }} --head HEAD"
          if [ "$HAS_OVERRIDE" = "true" ]; then
            ARGS="$ARGS --override"
            echo "::notice::'override-freeze' label present — guard runs in advisory mode."
          fi
          npx --yes "$SLOWCOOK_CLI" guard $ARGS

      - name: Manifest — verify discoverable tests
        run: npx --yes "$SLOWCOOK_CLI" manifest verify
`;
}

export function codeownersSection(params: TemplateParams): string {
  return `${SLOWCOOK_CODEOWNERS_MARKER_BEGIN}
# Paths frozen by slowcook. Agent-authored PRs cannot modify them;
# human edits must be reviewed. See https://github.com/aminazar/slowcook.

/tests/                         ${params.owner}
/tests-fixtures/                ${params.owner}
/tests-helpers/                 ${params.owner}
/vitest.config.*                ${params.owner}
/.brewing/                      ${params.owner}
/.github/workflows/slowcook.yml ${params.owner}
/CODEOWNERS                     ${params.owner}
${SLOWCOOK_CODEOWNERS_MARKER_END}
`;
}

export function codeownersFullFile(params: TemplateParams): string {
  // For repos that don't have CODEOWNERS yet — prepend a short header.
  return `# CODEOWNERS
#
# Generated by \`slowcook init\`. The slowcook-managed section is between
# the marker comments; edit outside those markers freely.

${codeownersSection(params)}`;
}

export function gitkeep(): string {
  return "";
}
