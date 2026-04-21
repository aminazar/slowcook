// Static and parameterized file contents written by `slowcook init`.
// Version is bumped in lockstep with the CLI package.

export const CLI_VERSION_FOR_TEMPLATES = "0.6.0";

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
          ".brewing/context.md",
          ".github/workflows/slowcook.yml",
          ".github/workflows/slowcook-spec-merged.yml",
          ".github/workflows/slowcook-testgen.yml",
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

export function contextMdTemplate(): string {
  return `# Project context for slowcook agents

Agents (refinement, test-gen, brewing) read this file every run to anchor their vocabulary and invariants — so the PM doesn't have to re-explain "what is a rewo" on every issue.

Keep it:
- **Distilled**, not a full PRD. ~1 page, ~1–2k tokens.
- **Grounded**, with actual code-path references where helpful.
- **Updated** alongside significant product pivots (commit changes with the code that changes).

This file is consumed as-is by the refinement agent. Contents below are a template — replace with your project's real context.

---

## Domain vocabulary

Define the key nouns and verbs your product uses. Agents should prefer these terms over generic software vocabulary.

- **Example**: an *entity-name* is a short definition. What's special about it in this product?
- **Example**: a *verb* (action) means... and results in...

## Product-level invariants

Rules that apply across stories — the things the product always does, regardless of which capability a story touches.

- **Example**: all write actions require authentication.
- **Example**: feed ordering is reverse-chronological; no algorithmic re-ranking.

## Architectural must-knows

- **Stack**: (e.g., Next.js 14 App Router, TypeScript, Supabase, Tailwind)
- **Where the API lives**: (e.g., \`src/app/api/*/route.ts\`)
- **Auth model**: (e.g., Supabase Auth sessions, cookie-based for web, JWT-in-header for native)
- **DB access**: (e.g., Supabase client SDK, RLS is the primary access-control layer)
- **Testing conventions**: (e.g., Vitest for unit + integration, Playwright for e2e)

## Known constraints / non-goals at project level

Things the product explicitly does NOT do — so agents don't propose them.

- **Example**: no algorithmic feed ranking.
- **Example**: no organizations / multi-tenancy.

## Pointers to deeper docs

If you maintain separate product / architecture docs, list paths here so reviewers can dig deeper. Agents do NOT auto-read these; include only what they directly need above.

- **PRD**: \`docs/PRD.md\`
- **Architecture**: \`docs/ARCHITECTURE.md\`
- **User stories**: \`docs/USER_STORIES.md\`
`;
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

export function slowcookTestgenWorkflow(cliVersion: string): string {
  return `name: slowcook testgen

# Generates Vitest integration tests whenever a new spec lands on main
# (specs/story-*.yaml touched in the push). Idempotent — skips specs that
# already have tests. Output is a draft PR containing the new test files,
# per-story manifests, and (if the spec supersedes others) removal of
# the superseded stories' tests.

on:
  push:
    branches: [main]
    paths:
      - 'specs/story-*.yaml'
      - 'specs/_index.yaml'

concurrency:
  group: slowcook-testgen-main
  cancel-in-progress: false

env:
  SLOWCOOK_CLI: "@slowcook-ai/cli@${cliVersion}"

jobs:
  testgen:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Configure git identity for agent commits
        run: |
          git config user.name  "slowcook-testgen[bot]"
          git config user.email "slowcook-testgen@users.noreply.github.com"

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Generate tests
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          SLOWCOOK_DEBUG: "1"
        run: |
          npx --yes "$SLOWCOOK_CLI" testgen --all
`;
}

export function slowcookSpecMergedWorkflow(cliVersion: string): string {
  return `name: slowcook — spec merged

# Transitions source-issue labels from \`spec-submitted\` → \`spec-ready\` when
# a spec PR merges. Detects spec PRs by the \`slowcook-spec\` label.

on:
  pull_request:
    types: [closed]

env:
  SLOWCOOK_CLI: "@slowcook-ai/cli@${cliVersion}"

jobs:
  transition:
    if: >-
      github.event.pull_request.merged == true &&
      contains(github.event.pull_request.labels.*.name, 'slowcook-spec')
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: read
      pull-requests: read
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.merge_commit_sha }}

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Transition labels
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          npx --yes "$SLOWCOOK_CLI" on-spec-merged --pr \${{ github.event.pull_request.number }}
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
/.brewing/                                  ${params.owner}
/.github/workflows/slowcook.yml             ${params.owner}
/.github/workflows/slowcook-spec-merged.yml ${params.owner}
/CODEOWNERS                                 ${params.owner}
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
