// Static and parameterized file contents written by `slowcook init`.
// Version is bumped in lockstep with the CLI package.

export const CLI_VERSION_FOR_TEMPLATES = "0.6.9";

/**
 * Path of the single-source-of-truth CLI pin file. Every workflow reads
 * from this at run time so a version bump is a one-file edit, not
 * N files × sed. Bump deliberately via a PR.
 */
export const SLOWCOOK_CLI_VERSION_FILE = ".brewing/slowcook-cli-version";

export function slowcookCliVersionFile(cliVersion: string): string {
  return cliVersion + "\n";
}

/**
 * Shared GitHub Actions step that resolves the SLOWCOOK_CLI env var from
 * the pin file. Must come AFTER actions/checkout@v4 in every workflow.
 * Emitted as a string so the three workflow templates below can compose
 * it identically and drift-free.
 */
const RESOLVE_PIN_STEP = `      - name: Resolve slowcook CLI pin
        # Single source of truth: .brewing/slowcook-cli-version. Bump by
        # editing that one file; every workflow picks it up at run time.
        run: echo "SLOWCOOK_CLI=@slowcook-ai/cli@$(cat .brewing/slowcook-cli-version | tr -d '[:space:]')" >> $GITHUB_ENV`;

export interface TemplateParams {
  /** CODEOWNERS handle or team (e.g. "@aminazar" or "@acme/frontend"). */
  owner: string;
  /** Whether the project has Playwright installed (affects stack.json comments). */
  hasPlaywright: boolean;
}

export const SLOWCOOK_CODEOWNERS_MARKER_BEGIN = "# --- slowcook:frozen-paths BEGIN ---";
export const SLOWCOOK_CODEOWNERS_MARKER_END = "# --- slowcook:frozen-paths END ---";

// 0.12.4+ — gitignore section markers, same idempotent-append pattern
// as CODEOWNERS. Lets `slowcook init` add (and on --force, replace)
// the slowcook-specific gitignore patterns without trampling other
// patterns the consumer added themselves.
export const SLOWCOOK_GITIGNORE_MARKER_BEGIN = "# --- slowcook:derived-files BEGIN ---";
export const SLOWCOOK_GITIGNORE_MARKER_END = "# --- slowcook:derived-files END ---";

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

## One-time setup per clone

After \`git clone\`, activate the slowcook pre-commit hook so the code map stays in lockstep with \`src/\` on every commit:

\`\`\`bash
git config core.hooksPath .githooks
\`\`\`

Without this, commits touching \`src/**/*.{ts,tsx}\` land with a stale \`.brewing/code-map.*\` and \`slowcook map check\` fails the PR. Bypass with \`git commit --no-verify\` if ever needed.

## Running slowcook locally

\`\`\`bash
npx --yes @slowcook-ai/cli@latest guard --base origin/main --head HEAD
npx --yes @slowcook-ai/cli@latest manifest record
npx --yes @slowcook-ai/cli@latest manifest verify
npx --yes @slowcook-ai/cli@latest map generate    # refresh .brewing/code-map.*
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

/**
 * Committable git pre-commit hook that keeps `.brewing/code-map.*`
 * fresh on disk so brew agents and `slowcook map check` see up-to-date
 * snapshots when they run.
 *
 * 0.12.4+: code-map files are NOT tracked in git (added to .gitignore
 * by `slowcook init`). Earlier versions committed them, which produced
 * merge conflicts on every parallel PR — two brews regenerating the
 * same derived file inevitably diverge. Now the hook regenerates the
 * map locally + brew/CI workflow steps regenerate at workflow start;
 * the file never enters git history.
 *
 * Activation is a one-time per-clone `git config core.hooksPath .githooks`
 * — we can't set it from init because it's a local-clone concern. The
 * generated `.brewing/README.md` documents the one-liner.
 */
export function preCommitHook(): string {
  return `#!/usr/bin/env bash
# slowcook pre-commit hook
#
# Keeps .brewing/code-map.{json,md} fresh on disk so brew agents and
# \`slowcook map check\` see the up-to-date snapshot when they run.
#
# As of 0.12.4: code-map files are NOT tracked in git. Committing them
# produced merge conflicts on every parallel PR (each brew regenerates
# → branches diverge on the same derived file). The hook regenerates
# locally; brew/CI workflows regenerate at workflow start. The file
# never enters git history.
#
# Activate once per clone:
#   git config core.hooksPath .githooks
#
# Bypass temporarily:  git commit --no-verify

set -eu

PIN_FILE=".brewing/slowcook-cli-version"
if [ ! -f "$PIN_FILE" ]; then
  echo "slowcook pre-commit: missing $PIN_FILE, skipping map regen" >&2
  exit 0
fi
CLI_PIN="$(tr -d '[:space:]' < "$PIN_FILE")"

STAGED_SRC=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '^src/.*\\.(ts|tsx)$' || true)
if [ -z "$STAGED_SRC" ]; then
  exit 0
fi

echo "slowcook pre-commit: regenerating code map (staged src/ changes detected)" >&2
if ! npx --yes "@slowcook-ai/cli@$CLI_PIN" map generate >/dev/null 2>&1; then
  echo "slowcook pre-commit: map generate FAILED — commit aborted. Run 'npx slowcook map generate' manually to see the error." >&2
  exit 1
fi

# Map files are gitignored — no \`git add\`. The fresh regen sits on
# disk for tools/agents; the committed state never includes derived data.

exit 0
`;
}

/**
 * 0.12.4+ — gitignore section that slowcook init appends to the
 * consumer's .gitignore (or creates if absent). Wrapped in the
 * SLOWCOOK_GITIGNORE_MARKER_* sentinels so subsequent `slowcook init
 * --force` calls can replace the section without trampling
 * consumer-added patterns elsewhere in the file.
 */
export function gitignoreSection(): string {
  return `${SLOWCOOK_GITIGNORE_MARKER_BEGIN}
# Slowcook-derived data — regenerated from src/ on every brew iter
# and \`slowcook map generate\`. Committing produced merge conflicts
# on every parallel PR (each brew regenerates → branches diverge
# on the same derived file). Pre-commit hook + workflow steps
# regenerate locally as needed.
.brewing/code-map.json
.brewing/code-map.md
${SLOWCOOK_GITIGNORE_MARKER_END}
`;
}
