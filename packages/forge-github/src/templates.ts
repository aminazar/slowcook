/**
 * GitHub Actions workflow templates consumed by `slowcook init`. These used
 * to live in `@slowcook-ai/cli/src/commands/init/templates.ts`, which meant
 * CLI shipped GitHub-specific YAML despite slowcook's forge-agnostic
 * pledge. 0.7.0 moves them here so CLI stays neutral.
 *
 * Shape: a static function that returns an array of `{ path, contents }`
 * entries. Init calls it with the CLI version it wants pinned in `.brewing/
 * slowcook-cli-version` and writes each entry. No forge credentials
 * required — this is scaffold-time, not runtime.
 *
 * Future forges (GitLab, Gitea, Bitbucket) implement their own
 * equivalent — e.g. `getGitLabCiArtifacts()` returning `.gitlab-ci.yml`.
 */

/** A single file the init step will write to the consumer's repo. */
export interface CiArtifact {
  /** Repo-relative path. */
  path: string;
  /** Full file contents. */
  contents: string;
  /**
   * Optional executable bit hint. Pre-commit hooks and similar scripts
   * need 0o755 to actually run; plain text files don't need a bit set.
   */
  executable?: boolean;
}

const RESOLVE_PIN_STEP = `      - name: Resolve slowcook CLI pin
        # Single source of truth: .brewing/slowcook-cli-version. Bump by
        # editing that one file; every workflow picks it up at run time.
        run: echo "SLOWCOOK_CLI=@slowcook-ai/cli@$(cat .brewing/slowcook-cli-version | tr -d '[:space:]')" >> $GITHUB_ENV`;

function slowcookWorkflow(): string {
  return `name: slowcook

on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]

concurrency:
  group: slowcook-\${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  check:
    name: slowcook checks
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

${RESOLVE_PIN_STEP}

      - uses: actions/setup-node@v4
        with:
          node-version: 20
      # setup-node's \`cache: npm\` used to be set here but was removed
      # in 0.7.18-era (see rewo CI incident 2026-04-23): it captured
      # \`~/.npm/_npx\` along with the npm cache, and the _npx paths
      # restore with relative \`../../..\` prefixes that tar can't mkdir,
      # spamming ~55k log lines per run with zero speedup for the
      # \`npx --yes\` pattern this workflow uses.

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

      - name: Code map — check it's up to date
        # Fails if the committed .brewing/code-map.{json,md} differs from a
        # fresh regeneration. If this fails, run
        # \`npx slowcook map generate\` locally, commit the result, and push.
        run: npx --yes "$SLOWCOOK_CLI" map check

      - name: Run tests
        # Execute the project's test suite on every PR — EXCEPT testgen
        # PRs, whose newly-emitted tests are red-by-design (they import
        # stubs that throw, meant to be brewed green). Gating on the
        # \`slowcook-tests\` label: testgen adds it, brew PRs don't have
        # it, human PRs don't have it, so this only skips where the red
        # is expected. Caught on rewo PR #56 where a 37-UI-test testgen
        # PR legitimately failed this gate by design.
        #
        # Without this step, a broken test file passes the slowcook gate
        # (guard/manifest/map) and goes silently red on main. Observed on
        # rewo story-005: 11 tests sat broken on main between brew-merge
        # and the story-006 diagnosis because no PR-time step ran vitest.
        # The consumer's \`npm test\` script is the contract; projects that
        # gate heavy tests on an env var (ACCEPTANCE=1, INTEGRATION=1, etc.)
        # should \`describe.skipIf\` those so \`npm test\` stays default-fast
        # in CI.
        if: "!contains(github.event.pull_request.labels.*.name, 'slowcook-tests')"
        run: npm test
`;
}

function slowcookSpecMergedWorkflow(): string {
  return `name: slowcook — spec merged

# Transitions source-issue labels from \`spec-submitted\` → \`spec-ready\` when
# a spec PR merges. Detects spec PRs by the \`slowcook-spec\` label.

on:
  pull_request:
    types: [closed]

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

${RESOLVE_PIN_STEP}

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

function slowcookTestsMergedWorkflow(): string {
  return `name: slowcook — tests merged

# Posts an audit-trail comment on each story's source issue when the
# tests PR merges, noting that brew-auto takes over next. Pairs with
# slowcook-spec-merged and slowcook-brew-merged.

on:
  pull_request:
    types: [closed]

jobs:
  comment:
    if: >-
      github.event.pull_request.merged == true &&
      contains(github.event.pull_request.labels.*.name, 'slowcook-tests')
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: read
      pull-requests: read
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.merge_commit_sha }}

${RESOLVE_PIN_STEP}

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Post audit-trail comment
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          npx --yes "$SLOWCOOK_CLI" on-tests-merged --pr \${{ github.event.pull_request.number }}
`;
}

function slowcookBrewMergedWorkflow(): string {
  return `name: slowcook — brew merged

# Posts the final "shipped" audit-trail comment on each story's source
# issue when the brew PR merges. Completes the pipeline trail:
# refine → spec-merged → testgen → tests-merged → brew → HERE.

on:
  pull_request:
    types: [closed]

jobs:
  comment:
    if: >-
      github.event.pull_request.merged == true &&
      contains(github.event.pull_request.labels.*.name, 'slowcook-brew')
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: read
      pull-requests: read
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.merge_commit_sha }}

${RESOLVE_PIN_STEP}

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Post audit-trail comment
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          npx --yes "$SLOWCOOK_CLI" on-brew-merged --pr \${{ github.event.pull_request.number }}
`;
}

function slowcookTestgenWorkflow(): string {
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
  # Manual trigger for ad-hoc re-runs (retry after transient failure, or
  # target a single story while siblings are intentionally handler-only).
  # Empty input = \`testgen --all\`; a non-empty value runs \`--spec <id>\`.
  # Accepts either the bare id ("005") or the prefixed form ("story-005") —
  # the CLI normalises a leading "story-" since 0.7.17.
  workflow_dispatch:
    inputs:
      spec:
        description: "Story id to target (e.g. 005 or story-005). Empty = all active specs."
        required: false
        default: ""

concurrency:
  group: slowcook-testgen-main
  cancel-in-progress: false

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

${RESOLVE_PIN_STEP}

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
          SPEC_INPUT: \${{ inputs.spec }}
        run: |
          if [ -n "$SPEC_INPUT" ]; then
            npx --yes "$SLOWCOOK_CLI" testgen --spec "$SPEC_INPUT"
          else
            npx --yes "$SLOWCOOK_CLI" testgen --all
          fi
`;
}

function slowcookBrewAutoWorkflow(): string {
  return `name: slowcook brew — auto on tests merged

# Auto-triggers the \`slowcook-brew\` workflow when a tests PR (label
# \`slowcook-tests\`) merges to main. Extracts the story id(s) from the
# PR title and fires one brew run per story. Sonnet 4.6 default keeps
# cost around $0.05–$0.50 per story; \`slowcook-brew.yml\`'s concurrency
# rules serialize runs per story.

on:
  pull_request:
    types: [closed]

jobs:
  trigger:
    if: >-
      github.event.pull_request.merged == true &&
      contains(github.event.pull_request.labels.*.name, 'slowcook-tests')
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: read
    steps:
      - name: Extract story ids from PR title
        id: parse
        env:
          TITLE: \${{ github.event.pull_request.title }}
        run: |
          set -eu
          IDS=$(printf '%s\\n' "$TITLE" | grep -oE 'story-[0-9]+' | sed 's/story-//' | sort -u | tr '\\n' ' ' || true)
          if [ -z "$IDS" ]; then
            echo "::notice::No story ids found in PR title '$TITLE' — skipping auto-brew."
          fi
          echo "story_ids=$IDS" >> "$GITHUB_OUTPUT"

      - name: Dispatch brew per story
        if: steps.parse.outputs.story_ids != ''
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          set -eu
          for id in \${{ steps.parse.outputs.story_ids }}; do
            echo "Dispatching slowcook-brew.yml for story-$id"
            gh workflow run slowcook-brew.yml \\
              --repo \${{ github.repository }} \\
              -f story_id=$id \\
              -f budget_usd=10 \\
              -f max_iterations=10 \\
              -f model=claude-sonnet-4-6
          done
`;
}

/**
 * All CI artifacts this forge provides. Init writes each entry; the
 * `executable` flag is respected so hook files are chmod 0755.
 *
 * Ordering is deterministic and stable for snapshot testability.
 */
export function getGitHubCiArtifacts(_params: { cliVersion: string }): CiArtifact[] {
  return [
    { path: ".github/workflows/slowcook.yml", contents: slowcookWorkflow() },
    { path: ".github/workflows/slowcook-spec-merged.yml", contents: slowcookSpecMergedWorkflow() },
    { path: ".github/workflows/slowcook-tests-merged.yml", contents: slowcookTestsMergedWorkflow() },
    { path: ".github/workflows/slowcook-brew-merged.yml", contents: slowcookBrewMergedWorkflow() },
    { path: ".github/workflows/slowcook-testgen.yml", contents: slowcookTestgenWorkflow() },
    { path: ".github/workflows/slowcook-brew-auto.yml", contents: slowcookBrewAutoWorkflow() },
  ];
}

/** Stable identifier for this forge. */
export const FORGE_ID = "github" as const;
