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
      # 0.12.13+ — issues:write so testgen can post the audit-trail
      # comment + cost marker on the spec's source_issue. Without it,
      # the comment POST returns 403 and the on-brew-merged rollup
      # silently undercounts pipeline cost (testgen contribution lost).
      issues: write
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

function slowcookAcceptanceWorkflow(): string {
  return `name: slowcook acceptance (tier-2)

# Runs Playwright acceptance tests against a real sandbox. Fires on
# brew PRs + nightly on main. Requires ACCEPTANCE_* secrets to point
# at a STAGING Supabase project (never prod). If those aren't set,
# the job skips with a notice instead of failing — lets consumers
# adopt tier-2 gradually.
#
# Added in slowcook 0.9.0. See docs/plans/0.9-tier-2-acceptance.md.

on:
  pull_request:
    types: [opened, synchronize, reopened, labeled]
  schedule:
    # Nightly against main — catches drift between PR runs
    - cron: "0 7 * * *"
  workflow_dispatch:

concurrency:
  group: slowcook-acceptance-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  acceptance:
    name: tier-2 acceptance
    # Run on every brew PR (label \`slowcook-brew\`), testgen PRs are SKIPPED
    # (their tests are red-by-design). Also runs on the scheduled nightly
    # and on manual dispatch.
    if: >-
      (github.event_name == 'pull_request' && contains(github.event.pull_request.labels.*.name, 'slowcook-brew'))
      || github.event_name == 'schedule'
      || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

${RESOLVE_PIN_STEP}

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Check for acceptance credentials
        id: creds
        env:
          URL: \${{ secrets.ACCEPTANCE_SUPABASE_URL }}
          KEY: \${{ secrets.ACCEPTANCE_SUPABASE_KEY }}
        run: |
          if [ -z "$URL" ] || [ -z "$KEY" ]; then
            echo "::notice::ACCEPTANCE_SUPABASE_URL / ACCEPTANCE_SUPABASE_KEY not set — skipping tier-2. See docs/plans/0.9-tier-2-acceptance.md for setup."
            echo "has_creds=false" >> "$GITHUB_OUTPUT"
          else
            echo "has_creds=true" >> "$GITHUB_OUTPUT"
          fi

      - name: Install consumer deps
        if: steps.creds.outputs.has_creds == 'true'
        run: npm ci

      - name: Install Playwright browsers
        if: steps.creds.outputs.has_creds == 'true'
        run: npx playwright install chromium --with-deps

      - name: Write .env.acceptance from secrets
        if: steps.creds.outputs.has_creds == 'true'
        env:
          URL: \${{ secrets.ACCEPTANCE_SUPABASE_URL }}
          KEY: \${{ secrets.ACCEPTANCE_SUPABASE_KEY }}
          EMAIL: \${{ secrets.ACCEPTANCE_TEST_EMAIL }}
          HANDLE: \${{ secrets.ACCEPTANCE_TEST_HANDLE }}
        run: |
          {
            echo "BASE_URL=http://localhost:3000"
            echo "NEXT_PUBLIC_SUPABASE_URL=$URL"
            echo "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=$KEY"
            echo "ACCEPTANCE_TEST_EMAIL=\${EMAIL:-test-acceptance@example.com}"
            echo "ACCEPTANCE_TEST_HANDLE=\${HANDLE:-acceptance_user}"
          } > .env.acceptance

      - name: Run acceptance tests
        if: steps.creds.outputs.has_creds == 'true'
        env:
          ACCEPTANCE: "1"
        run: npx playwright test

      - name: Upload Playwright artifacts on failure
        if: always() && steps.creds.outputs.has_creds == 'true'
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report-\${{ github.run_id }}
          path: |
            playwright-report/
            test-results/
          if-no-files-found: ignore
          retention-days: 30
`;
}

/**
 * All CI artifacts this forge provides. Init writes each entry; the
 * `executable` flag is respected so hook files are chmod 0755.
 *
 * Ordering is deterministic and stable for snapshot testability.
 */
function slowcookRefineWorkflow(): string {
  return `name: slowcook refine

# Runs the slowcook refinement agent in two modes:
#
# Mode A (original): issues tagged \`needs-refinement\` — each round the
# agent reads the issue + comments and either posts clarifying questions
# or emits a spec + draft PR. Triggered by issue events and issue_comment.
#
# Mode B (0.11.5+): \`/refine <prose>\` comments on a \`slowcook-spec\` labeled
# PR — the agent amends the spec on the same branch and force-pushes.
# Single-shot: no clarifying-question loop at the PR level.

on:
  issues:
    types: [opened, labeled, reopened]
  issue_comment:
    types: [created]
  # 0.11.8+ — PM leaves inline comments on specific spec lines OR submits
  # a batched review. Either fires if the body contains \`/refine\`.
  pull_request_review_comment:
    types: [created]
  pull_request_review:
    types: [submitted]

# Concurrency is keyed on BOTH the target number AND the event name.
# GitHub fires two events for a single inline /refine review comment —
# \`pull_request_review_comment\` AND \`pull_request_review\` (the wrapping
# review, usually with an empty body). If both shared one group the
# wrapping review's run would cancel-in-progress the comment's run, and
# the wrapping review then skipped on the body filter, so neither
# actually ran. Keying on event_name keeps them in separate groups.
concurrency:
  group: slowcook-refine-\${{ github.event.issue.number || github.event.pull_request.number }}-\${{ github.event_name }}
  cancel-in-progress: true

jobs:
  refine:
    if: >-
      (
        github.event_name == 'issues' ||
        (github.event_name == 'issue_comment' && !github.event.issue.pull_request)
      ) &&
      github.event.issue.state == 'open' &&
      contains(github.event.issue.labels.*.name, 'needs-refinement') &&
      (github.event_name != 'issue_comment' ||
       (github.event.comment.user.type != 'Bot' &&
        !startsWith(github.event.comment.body, '### slowcook ·')))
      ||
      (
        github.event_name == 'issue_comment' &&
        github.event.issue.pull_request != null &&
        contains(github.event.issue.labels.*.name, 'slowcook-spec') &&
        startsWith(github.event.comment.body, '/refine') &&
        github.event.comment.user.type != 'Bot'
      )
      ||
      (
        github.event_name == 'pull_request_review_comment' &&
        contains(github.event.pull_request.labels.*.name, 'slowcook-spec') &&
        startsWith(github.event.comment.body, '/refine') &&
        github.event.comment.user.type != 'Bot'
      )
      ||
      (
        github.event_name == 'pull_request_review' &&
        contains(github.event.pull_request.labels.*.name, 'slowcook-spec') &&
        startsWith(github.event.review.body, '/refine') &&
        github.event.review.user.type != 'Bot'
      )
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: write
      pull-requests: write
    steps:
      - name: Detect mode + target number
        id: mode
        env:
          EVENT_NAME: \${{ github.event_name }}
          IS_PR_ISSUE_COMMENT: \${{ github.event.issue.pull_request != null }}
          ISSUE_NUM: \${{ github.event.issue.number }}
          PR_NUM: \${{ github.event.pull_request.number }}
          COMMENT: \${{ github.event.comment.body }}
          REVIEW_BODY: \${{ github.event.review.body }}
        run: |
          # PR number comes from different payloads depending on event:
          #   issue_comment on a PR → github.event.issue.number
          #   pull_request_review_comment / pull_request_review → github.event.pull_request.number
          # Mode is PR when we're on a /refine trigger of any PR flavour.
          case "$EVENT_NAME" in
            pull_request_review_comment)
              echo "mode=pr" >> "$GITHUB_OUTPUT"
              echo "target=$PR_NUM" >> "$GITHUB_OUTPUT"
              # 0.11.10+ — carry the inline comment id through so the agent
              # can reply threaded under the PM's comment instead of posting
              # a disconnected timeline message.
              echo "review_comment_id=\${{ github.event.comment.id }}" >> "$GITHUB_OUTPUT"
              ;;
            pull_request_review)
              echo "mode=pr" >> "$GITHUB_OUTPUT"
              echo "target=$PR_NUM" >> "$GITHUB_OUTPUT"
              ;;
            issue_comment)
              if [ "$IS_PR_ISSUE_COMMENT" = "true" ] && [[ "\${COMMENT:-}" == /refine* ]]; then
                echo "mode=pr" >> "$GITHUB_OUTPUT"
                echo "target=$ISSUE_NUM" >> "$GITHUB_OUTPUT"
              else
                echo "mode=issue" >> "$GITHUB_OUTPUT"
                echo "target=$ISSUE_NUM" >> "$GITHUB_OUTPUT"
              fi
              ;;
            *)
              echo "mode=issue" >> "$GITHUB_OUTPUT"
              echo "target=$ISSUE_NUM" >> "$GITHUB_OUTPUT"
              ;;
          esac

      - name: Fetch PR branch ref
        id: pr-branch
        if: steps.mode.outputs.mode == 'pr'
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: |
          BRANCH=$(gh pr view \${{ steps.mode.outputs.target }} --repo \${{ github.repository }} --json headRefName -q .headRefName)
          echo "branch=$BRANCH" >> "$GITHUB_OUTPUT"

      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: \${{ steps.mode.outputs.mode == 'pr' && steps.pr-branch.outputs.branch || github.ref }}
          token: \${{ secrets.GITHUB_TOKEN }}

      - name: Resolve slowcook CLI pin (from main — latest agent behaviour)
        # The PR branch may have been created when the pin was older. For
        # agent tooling we always want main's latest pin — otherwise a PM
        # commenting /refine on an old spec PR runs the OLD agent, missing
        # bug fixes and new capabilities shipped since the branch was cut.
        # Ref files on branches track per-branch concerns (frozen-paths,
        # manifests); the agent pin is a global concern tracked on main.
        run: |
          git fetch --depth=1 origin main
          VERSION=$(git show origin/main:.brewing/slowcook-cli-version | tr -d '[:space:]')
          echo "SLOWCOOK_CLI=@slowcook-ai/cli@$VERSION" >> $GITHUB_ENV

      - name: Configure git identity for agent commits
        run: |
          git config user.name  "slowcook-refine[bot]"
          git config user.email "slowcook-refine@users.noreply.github.com"

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Brownfield extracts (schema + tokens for refine context)
        # 0.13.5+ — refine reads .brewing/diagrams/schema.mmd + tokens.md
        # to align proposals with existing entities and design tokens.
        # \`extract\` is regex/filesystem-only — no npm ci needed, finishes
        # in ~100ms. Both extracts skip silently when their inputs are
        # missing (greenfield / no Supabase / no .css with :root vars).
        # Outputs are gitignored — regenerated each refine run.
        run: npx --yes "$SLOWCOOK_CLI" extract

      - name: Refine
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          SLOWCOOK_DEBUG: "1"
        run: |
          if [ "\${{ steps.mode.outputs.mode }}" = "pr" ]; then
            EXTRA=""
            # review_comment_id is only set by the pull_request_review_comment
            # branch — for issue_comment + pull_request_review triggers the
            # flag is omitted and refine falls back to a timeline comment.
            if [ -n "\${{ steps.mode.outputs.review_comment_id }}" ]; then
              EXTRA="--review-comment-id \${{ steps.mode.outputs.review_comment_id }}"
            fi
            npx --yes "$SLOWCOOK_CLI" refine --pr \${{ steps.mode.outputs.target }} $EXTRA
          else
            npx --yes "$SLOWCOOK_CLI" refine --issue \${{ steps.mode.outputs.target }}
          fi
`;
}

export function getGitHubCiArtifacts(_params: { cliVersion: string }): CiArtifact[] {
  return [
    { path: ".github/workflows/slowcook.yml", contents: slowcookWorkflow() },
    { path: ".github/workflows/slowcook-refine.yml", contents: slowcookRefineWorkflow() },
    { path: ".github/workflows/slowcook-spec-merged.yml", contents: slowcookSpecMergedWorkflow() },
    { path: ".github/workflows/slowcook-tests-merged.yml", contents: slowcookTestsMergedWorkflow() },
    { path: ".github/workflows/slowcook-brew-merged.yml", contents: slowcookBrewMergedWorkflow() },
    { path: ".github/workflows/slowcook-testgen.yml", contents: slowcookTestgenWorkflow() },
    { path: ".github/workflows/slowcook-brew-auto.yml", contents: slowcookBrewAutoWorkflow() },
    { path: ".github/workflows/slowcook-acceptance.yml", contents: slowcookAcceptanceWorkflow() },
    // 0.13.0-alpha.5 — bug-flow workflows. investigate fires on issues
    // labeled `bug`; sift fires when a bug-profile PR merges.
    { path: ".github/workflows/slowcook-investigate.yml", contents: slowcookInvestigateWorkflow() },
    { path: ".github/workflows/slowcook-sift.yml", contents: slowcookSiftWorkflow() },
    { path: ".github/workflows/slowcook-chef.yml", contents: slowcookChefWorkflow() },
    // 0.15.0-α.2 — vibe agent (mockup generator) workflow.
    { path: ".github/workflows/slowcook-vibe.yml", contents: slowcookVibeWorkflow() },
  ];
}

/**
 * 0.13.0-alpha.5c — chef workflow. Fires when a check_suite completes
 * with a non-success conclusion on a slowcook-bot PR (head ref starts
 * with \`slowcook/\`). Chef reads the PR + check status, classifies the
 * failure, and acts (rebase / retry / escalate).
 */
function slowcookChefWorkflow(): string {
  return `name: slowcook chef

# 0.13.0-alpha.5c — pipeline orchestrator. Fires automatically when
# check_suite completes with a non-success conclusion on a slowcook-bot
# PR (head ref starts with \`slowcook/\`). Chef reads the PR + check
# status, classifies the failure (self-conflict / self-fail /
# external-fail / infra-fail), and acts.

on:
  check_suite:
    types: [completed]
  workflow_dispatch:
    inputs:
      pr:
        description: "PR number to process (manual override)"
        required: true
        type: string

concurrency:
  group: slowcook-chef-\${{ github.event.check_suite.pull_requests[0].number || github.event.inputs.pr }}
  cancel-in-progress: false

jobs:
  chef:
    if: >-
      github.event_name == 'workflow_dispatch' ||
      (
        github.event.check_suite.conclusion != 'success' &&
        github.event.check_suite.conclusion != null &&
        github.event.check_suite.pull_requests[0] != null &&
        startsWith(github.event.check_suite.head_branch, 'slowcook/')
      )
    runs-on: ubuntu-latest
    permissions:
      actions: write
      issues: write
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

${RESOLVE_PIN_STEP}

      - name: Configure git identity for chef commits
        run: |
          git config user.name  "slowcook-chef[bot]"
          git config user.email "slowcook-chef@users.noreply.github.com"

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Run chef
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: \${{ github.event.check_suite.pull_requests[0].number || github.event.inputs.pr }}
        run: |
          set -eu
          npx --yes "$SLOWCOOK_CLI" chef --pr "$PR_NUMBER"
`;
}

/**
 * 0.13.0-alpha.5b — sift workflow. Fires manually (workflow_dispatch)
 * for now; auto-trigger on regression-recipe PR merge lands in
 * alpha.5c alongside chef. Requires the bug profile + regression test
 * to already be on main.
 */
function slowcookSiftWorkflow(): string {
  return `name: slowcook sift

# 0.13.0-alpha.5b — bug-flow analogue of slowcook-brew. Runs the sift
# agent: reads a bug-profile + the matching regression test, runs a
# narrow red→green ratchet bounded by the bug-profile's fix_scope.
#
# Manual trigger only today. Auto-trigger on regression-recipe PR
# merge ships in alpha.5c (chef will own that dispatch).

on:
  workflow_dispatch:
    inputs:
      bug_id:
        description: "Bug id to sift (B-N or just N)"
        required: true
        type: string
      max_iterations:
        description: "Max iterations (default 3)"
        required: false
        default: "3"
        type: string
      budget_usd:
        description: "Spend cap USD (default 0.5)"
        required: false
        default: "0.5"
        type: string
      model:
        description: "LLM model (default sonnet-4-6)"
        required: false
        default: "claude-sonnet-4-6"
        type: string

concurrency:
  group: slowcook-sift-\${{ github.event.inputs.bug_id }}
  cancel-in-progress: false

jobs:
  sift:
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

${RESOLVE_PIN_STEP}

      - name: Configure git identity for agent commits
        run: |
          git config user.name  "slowcook-sift[bot]"
          git config user.email "slowcook-sift@users.noreply.github.com"

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install consumer deps
        run: npm ci

      - name: Sift
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          SLOWCOOK_DEBUG: "1"
        run: |
          set -eu
          npx --yes "$SLOWCOOK_CLI" sift \\
            --bug "\${{ github.event.inputs.bug_id }}" \\
            --max-iterations "\${{ github.event.inputs.max_iterations }}" \\
            --budget-usd "\${{ github.event.inputs.budget_usd }}" \\
            --model "\${{ github.event.inputs.model }}"
`;
}

/**
 * 0.13.0-alpha.5a — slowcook-investigate workflow. Fires on issues
 * labeled \`bug\` (auto-trigger) OR via workflow_dispatch (manual).
 * The investigate agent reads the issue body, runs read-only repo
 * tools, emits a bug-profile YAML, and opens a PR labeled
 * \`slowcook-bug-profile\`. Merging that PR triggers the next stage
 * of the bug-flow.
 */
function slowcookInvestigateWorkflow(): string {
  return `name: slowcook investigate

# 0.13.0-alpha.5a — bug-flow analogue of slowcook-refine. Fires on
# issues labeled \`bug\` and runs the investigate agent: reads the
# issue body, uses read-only repo tools to find the failure locus,
# emits a bug-profile YAML, and opens a PR proposing it.

on:
  issues:
    types: [opened, labeled, reopened]
  workflow_dispatch:
    inputs:
      issue:
        description: "Issue number to investigate (must have \`bug\` label)"
        required: true
        type: string

concurrency:
  group: slowcook-investigate-\${{ github.event.issue.number || github.event.inputs.issue }}
  cancel-in-progress: true

jobs:
  investigate:
    # Auto-trigger: only when an issue gains the \`bug\` label, OR when
    # a comment fires on an already-\`bug\`-labeled issue. Manual
    # dispatch always runs (gated by the input).
    if: >-
      (
        github.event_name == 'issues' &&
        contains(github.event.issue.labels.*.name, 'bug') &&
        github.event.issue.state == 'open'
      ) ||
      github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    permissions:
      issues: write
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

${RESOLVE_PIN_STEP}

      - name: Configure git identity for agent commits
        run: |
          git config user.name  "slowcook-investigate[bot]"
          git config user.email "slowcook-investigate@users.noreply.github.com"

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Brownfield extracts (schema + tokens for investigate context)
        # 0.13.5+ — investigate's read-only tools also benefit from
        # knowing the existing schema + design tokens (e.g. when a bug
        # report mentions "the coral button", investigate can locate
        # the var(--coral) usages instead of grep-guessing). Fast, no
        # npm ci needed; skips silently on greenfield.
        run: npx --yes "$SLOWCOOK_CLI" extract

      - name: Investigate
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          SLOWCOOK_DEBUG: "1"
          ISSUE_NUMBER: \${{ github.event.issue.number || github.event.inputs.issue }}
        run: |
          set -eu
          npx --yes "$SLOWCOOK_CLI" investigate --issue "$ISSUE_NUMBER"
`;
}

/**
 * 0.15.0-alpha.2 — slowcook-vibe workflow. Fires automatically when a
 * spec PR (label \`slowcook-spec\`) merges; vibe reads the merged spec
 * + brownfield extracts + code-map and emits a runnable mockup to a
 * \`slowcook/mockup/story-N\` branch with a draft PR labeled
 * \`slowcook-mockup\`. The vibe command itself does the eligibility
 * check (skips when proposals.fixtures is absent or a mockup branch
 * already exists), so this workflow can fire wide.
 *
 * Also exposes workflow_dispatch for manual retry.
 */
function slowcookVibeWorkflow(): string {
  return `name: slowcook vibe

# 0.15.0-alpha.2 — design-first mockup generator. Fires on spec-merged.
# vibe reads the merged spec YAML + brownfield extracts + code-map;
# emits a runnable React mockup to slowcook/mockup/story-<id> branch +
# opens a draft PR labeled slowcook-mockup. The PM reviews the preview
# deploy + comments \`/plate <prose>\` on the mockup PR to iterate
# (handled by slowcook-plate.yml — α.3, not in this version).

on:
  pull_request:
    types: [closed]
  workflow_dispatch:
    inputs:
      spec:
        description: "Story id to vibe a mockup for (e.g. 017)"
        required: true
        type: string

concurrency:
  group: slowcook-vibe-\${{ github.event.inputs.spec || github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  vibe:
    if: >-
      (
        github.event_name == 'pull_request' &&
        github.event.pull_request.merged == true &&
        contains(github.event.pull_request.labels.*.name, 'slowcook-spec')
      ) ||
      github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          ref: \${{ github.event.pull_request.merge_commit_sha || github.ref }}

${RESOLVE_PIN_STEP}

      - name: Configure git identity for agent commits
        run: |
          git config user.name  "slowcook-vibe[bot]"
          git config user.email "slowcook-vibe@users.noreply.github.com"

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Brownfield extracts (schema + tokens for vibe context)
        # vibe's whole point is REUSE existing components + tokens. The
        # extracts are the canonical inventory — without them vibe
        # regresses to inventing tokens + components, exactly the
        # failure mode 0.15 prevents. Skips silently on greenfield.
        run: npx --yes "$SLOWCOOK_CLI" extract

      - name: Code map (component vocabulary for vibe context)
        # vibe reads .brewing/code-map.md to know which components
        # already exist (so it imports them by real path instead of
        # creating new ones at testgen-stub paths — the rewo PR #117 +
        # PR #142 failure mode). Costs ~5s of ts-morph; cheap.
        run: |
          set -eu
          if [ -f package.json ]; then
            npm ci --silent || true
          fi
          npx --yes "$SLOWCOOK_CLI" map generate

      - name: Detect spec id
        id: spec
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          INPUT_SPEC: \${{ github.event.inputs.spec }}
          PR_NUM: \${{ github.event.pull_request.number }}
        run: |
          set -eu
          if [ -n "\${INPUT_SPEC:-}" ]; then
            echo "story_id=\${INPUT_SPEC}" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          # Auto path: derive from PR's branch name (slowcook/spec/story-N).
          BRANCH=$(gh pr view "$PR_NUM" --repo "\${{ github.repository }}" --json headRefName -q .headRefName)
          STORY_ID=$(echo "$BRANCH" | sed -nE 's|^slowcook/spec/story-([a-zA-Z0-9_-]+)$|\\1|p')
          if [ -z "$STORY_ID" ]; then
            echo "Could not derive story id from branch '$BRANCH'. Skipping vibe."
            exit 0
          fi
          echo "story_id=$STORY_ID" >> "$GITHUB_OUTPUT"

      - name: Skip if mockup branch already exists
        if: steps.spec.outputs.story_id != ''
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          STORY_ID: \${{ steps.spec.outputs.story_id }}
        id: existing
        run: |
          set -eu
          MOCKUP_BRANCH="slowcook/mockup/story-\${STORY_ID}"
          if gh api "repos/\${{ github.repository }}/branches/\${MOCKUP_BRANCH}" >/dev/null 2>&1; then
            echo "Mockup branch \${MOCKUP_BRANCH} already exists — skipping vibe (use workflow_dispatch with --regenerate to override, not yet implemented)."
            echo "skip=true" >> "$GITHUB_OUTPUT"
          else
            echo "skip=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Vibe
        if: steps.spec.outputs.story_id != '' && steps.existing.outputs.skip != 'true'
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          SLOWCOOK_DEBUG: "1"
          STORY_ID: \${{ steps.spec.outputs.story_id }}
        run: |
          set -eu
          npx --yes "$SLOWCOOK_CLI" vibe --spec "$STORY_ID"
`;
}

/** Stable identifier for this forge. */
export const FORGE_ID = "github" as const;
