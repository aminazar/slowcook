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

Agents (refinement, test-gen, brewing) read this file every run to anchor their vocabulary and invariants — so the PM doesn't have to re-explain core domain terms on every issue.

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
/**
 * 0.12.12+ (Phase 2C) — README inside `.brewing/patterns/`. The
 * directory itself is the contract; this README documents how to
 * write a pattern that brew will index. Patterns are *team-authored*
 * (slowcook never auto-emits them); they live in git, are stable
 * across brews, and serve as project-specific recipes.
 */
export function patternsReadme(): string {
  return `# Patterns directory

Hand-written reusable code recipes for this project. The brew agent
loads the *index* of this directory (title + one-line summary per
file) into every iteration's cached prefix; the agent reads any
specific pattern via \`read_file('.brewing/patterns/<name>.md')\` when
relevant.

Patterns are about **how this codebase does X** — stuff that's
non-obvious from reading any single file but that recurs across the
project. Examples worth capturing:

- "How cursor pagination works in our handlers"
- "The shape of a tier-1 test against mockSupabase"
- "How RLS is enforced on writes"
- "Migration patterns: when to use ALTER TABLE vs DO blocks"

Patterns are NOT for:

- Per-feature documentation (use spec.yaml).
- Architectural decisions / ADRs (use docs/).
- Per-story brew context (use \`.brewing/context.md\`).

## File convention

Each pattern is a Markdown file named \`<slug>.md\`. Required structure:

\`\`\`markdown
# <Title>

> <One-line summary, used as the index entry.>

## When to use
...

## Example
\`\`\`ts
// concrete code
\`\`\`
\`\`\`

The first \`# Title\` line and the first \`> Summary\` line are what
brew indexes. Anything else is for the agent's eyes when it loads the
full pattern.

## Adding a pattern

1. Write the markdown file in this directory.
2. Commit it. The next brew iteration sees the new pattern in its
   index and can read it on-demand.

No registry, no metadata, no slowcook-side change required.
`;
}

/**
 * 0.19.x+ — generic agent-bootstrap preflight script.
 *
 * Run this from any new agent session's first action. Prints PASS/FAIL
 * for each prerequisite the agent needs to do real work in this
 * consumer's environment:
 *
 *   - SSH client (often needed for remote dev servers, gh-via-ssh, etc.)
 *   - git (writing branches)
 *   - gh CLI (opening PRs — the slowcook branch-discipline rule depends
 *     on `gh pr create`)
 *   - jq (parsing JSON from gh/api calls)
 *   - gh auth status (logged in)
 *
 * Consumer-specific checks (SSH key on disk for a remote dev box, etc.)
 * go in a separate `scripts/agent-preflight.local.sh` that this script
 * sources when present. Keeps the slowcook-shipped template generic.
 *
 * Why this exists: GitHub Actions mounts secrets for workflows; agents
 * running OUTSIDE workflows (long-lived Claude Code sessions, Managed
 * Agents, etc.) have no programmatic path to GH secrets and need
 * out-of-band provisioning by the PM. Without a preflight, the agent
 * flails on its first action and burns a turn debugging its own
 * environment.
 *
 * Surfaced from a delgoosh bijan-agent triage 2026-05-30: the agent
 * lacked `gh`, had no path to obtain its SSH key, and the PM-facing
 * server-setup doc was being handed to the agent as if it were
 * agent-facing.
 */
export function agentPreflightScript(): string {
  return `#!/usr/bin/env bash
# Slowcook agent preflight — run this from your first action of any
# new session. Checks that the tools + auth + secrets you need are in
# place. Edit this file to add consumer-specific checks (e.g. SSH key
# at \`~/.ssh/<your-name>-key\`, env vars, etc.) — keep the generic
# slowcook checks intact.
#
# Exit 0 = all green, agent may proceed.
# Exit 1 = at least one FAIL. Ask the PM to fix; do NOT self-heal.
#
# Convention: each check prints \`PASS <name>\` or \`FAIL <name> — <hint>\`
# in two columns so the agent can grep \`^FAIL\` for the bad list.

set -u

exit_code=0
ok()   { printf 'PASS  %s\\n' "$1"; }
fail() { printf 'FAIL  %s — %s\\n' "$1" "$2"; exit_code=1; }

# --- Tools ----------------------------------------------------------
command -v ssh >/dev/null  && ok "ssh installed"  || fail "ssh installed"  "apt install -y openssh-client / brew install openssh"
command -v git >/dev/null  && ok "git installed"  || fail "git installed"  "apt install -y git / brew install git"
command -v gh  >/dev/null  && ok "gh installed"   || fail "gh installed"   "https://cli.github.com — slowcook's branch-discipline rule depends on \\\`gh pr create\\\`"
command -v jq  >/dev/null  && ok "jq installed"   || fail "jq installed"   "apt install -y jq / brew install jq"
command -v node >/dev/null && ok "node installed" || fail "node installed" "install Node 20 via nvm or system"

# --- Auth -----------------------------------------------------------
if command -v gh >/dev/null; then
  gh auth status >/dev/null 2>&1 \\
    && ok "gh authenticated" \\
    || fail "gh authenticated" "run \\\`gh auth login\\\` with a PAT scoped to repo,read:org,workflow (ask PM if you don't have one)"
fi

# --- Repo write access ---------------------------------------------
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  REMOTE_URL=\$(git config --get remote.origin.url 2>/dev/null || echo "")
  if [ -n "\$REMOTE_URL" ]; then
    REPO_NWO=\$(printf '%s' "\$REMOTE_URL" | sed -E 's#(git@github.com:|https://github.com/)([^/]+/[^/.]+)(\\.git)?#\\2#')
    if [ -n "\$REPO_NWO" ]; then
      PERM=\$(gh api "repos/\$REPO_NWO" --jq '.permissions.push // false' 2>/dev/null || echo "false")
      if [ "\$PERM" = "true" ]; then
        ok "push access to \$REPO_NWO"
      else
        fail "push access to \$REPO_NWO" "your gh user has no push permission — ask PM to invite you"
      fi
    fi
  fi
fi

# --- Consumer-specific hook ----------------------------------------
# Put your project's per-agent checks (SSH key on disk for a remote
# dev box, env vars, deploy-key bootstrap, etc.) into the .local.sh
# sibling. Gitignore'd by convention so it doesn't leak per-machine
# state into the repo.
LOCAL_HOOK="\$(dirname "\$0")/agent-preflight.local.sh"
if [ -f "\$LOCAL_HOOK" ]; then
  # shellcheck disable=SC1090
  source "\$LOCAL_HOOK"
fi

exit "\$exit_code"
`;
}

/**
 * 0.19.x+ — agent-bootstrap doc. Describes what the PM provisions
 * out-of-band for each agent (per-agent SSH keys, gh auth, env vars,
 * etc.) so the agent's preflight passes.
 *
 * Lives at \`ops/agent-bootstrap.md\` — under \`ops/\` so it's clearly
 * PM-facing (agents should consult AGENTS.md for their operating
 * manual; \`ops/\` files are server-side / per-agent setup runbooks
 * for the PM).
 */
export function agentBootstrapDoc(): string {
  return `# Agent bootstrap — per-agent provisioning (PM-facing)

> **Audience: PM.** This doc is for whoever runs the project; agents
> should not consult it. Agents read \`AGENTS.md\` and run
> \`scripts/agent-preflight.sh\` instead. (See the slowcook managed
> block in AGENTS.md for the audience convention.)

When you onboard a new agent (Claude Code session, Codex, Cursor,
etc.) into this repo, you need to provision a few things out-of-band
so its first \`scripts/agent-preflight.sh\` passes:

## 1. \`gh\` CLI authentication

Agents need \`gh\` to open PRs (slowcook's branch-discipline rule
depends on it). Pre-install the binary in the agent's container/image
and authenticate one of these ways:

- **PAT** (simplest): \`gh auth login --with-token < ~/.pat\`. Scopes:
  \`repo, read:org, workflow\`. Per-agent token so revocation is
  surgical.
- **GitHub App installation token**: cleaner for org-policy reasons;
  more setup.
- **OAuth web flow**: only if the agent's environment can pop a
  browser, which most managed contexts can't.

## 2. SSH keys for remote services (if you have a dev box)

If your project has a remote dev/staging box that agents need to SSH
into (e.g., delgoosh-box for the rotating-URL dev-server pattern):

- Generate a per-agent SSH keypair locally (not on the box).
- **Public half** → install in the box's \`/home/<agent-user>/.ssh/authorized_keys\`.
  See server-side setup runbook (e.g., \`ops/box/<agent>-agent-setup.md\`).
- **Private half** → install in the agent's environment at
  \`~/.ssh/<agent-name>-key\` with \`chmod 600\`. ALSO upload to GitHub
  Secrets as \`<PROJECT>_<AGENT>_SSH_KEY\` for any workflow agents.

**Why two places**: GitHub secrets are workflow-mounted only — they
cannot be read by agents running outside Actions (long-lived Claude
Code, Managed Agents, etc.). For those, the private key must already
be on disk before the agent's first action.

## 3. SSH config + known_hosts

For convenience, add a stanza in the agent's \`~/.ssh/config\`:

\`\`\`
Host <project>-box
  HostName <ip-or-hostname>
  Port 22
  User <agent-user>
  IdentityFile ~/.ssh/<agent-name>-key
  IdentitiesOnly yes
  ServerAliveInterval 30
\`\`\`

Pre-populate \`~/.ssh/known_hosts\` so the first SSH doesn't prompt:

\`\`\`bash
ssh-keyscan -t ed25519 <ip-or-hostname> >> ~/.ssh/known_hosts
ssh-keyscan -t ed25519 github.com      >> ~/.ssh/known_hosts
\`\`\`

## 4. Project-specific preflight (\`agent-preflight.local.sh\`)

The generic \`scripts/agent-preflight.sh\` shipped by slowcook init
sources \`scripts/agent-preflight.local.sh\` if present. Put your
project's per-agent checks there. Example:

\`\`\`bash
# scripts/agent-preflight.local.sh — gitignored
[ -f ~/.ssh/<agent-name>-key ] \\
  && ok "ssh key present" \\
  || fail "ssh key present" "PM must install per ops/agent-bootstrap.md §2"

[ "\$(stat -c %a ~/.ssh/<agent-name>-key 2>/dev/null)" = 600 ] \\
  && ok "ssh key chmod 600" \\
  || fail "ssh key chmod 600" "chmod 600 ~/.ssh/<agent-name>-key"

ssh -o BatchMode=yes -o ConnectTimeout=5 <project>-box 'whoami' 2>/dev/null | grep -qx "<agent-user>" \\
  && ok "ssh to <project>-box as <agent-user>" \\
  || fail "ssh to <project>-box as <agent-user>" "key or known_hosts misconfigured"
\`\`\`

The \`.local.sh\` form is gitignored — add it to \`.gitignore\` so
per-agent quirks don't leak into the repo.

## Tear-down

When you retire an agent:

1. Revoke the GH PAT (or GitHub App installation token).
2. Revoke the SSH key on the dev box (remove from
   \`~/<agent-user>/.ssh/authorized_keys\`).
3. Delete the GitHub secret (\`gh secret delete <PROJECT>_<AGENT>_SSH_KEY\`).
4. Optionally delete the OS user on the dev box (\`userdel -r <agent-user>\`).

Per-agent scoping is the point — each step is independent of every
other agent.
`;
}

export function gitignoreSection(): string {
  return `${SLOWCOOK_GITIGNORE_MARKER_BEGIN}
# Slowcook-derived data — regenerated from src/ on every brew iter
# and \`slowcook map generate\`. Committing produced merge conflicts
# on every parallel PR (each brew regenerates → branches diverge
# on the same derived file). Pre-commit hook + workflow steps
# regenerate locally as needed.
.brewing/code-map.json
.brewing/code-map.md
.brewing/code-map.target.md
# 0.13.5+ — brownfield extracts under .brewing/diagrams/. Ephemeral
# files (schema.mmd, tokens.md) are regenerated each refine/investigate
# workflow run via \`slowcook extract\` and SHOULD NOT be committed.
# Hand-curated artifacts (entities.md, architecture.md, etc.) are
# source-of-truth and SHOULD be tracked — \`!\` exceptions below
# whitelist them. The \`/*\` form (vs trailing slash) is required for
# the !-overrides to take effect.
.brewing/diagrams/*
!.brewing/diagrams/entities.md
!.brewing/diagrams/architecture.md
!.brewing/diagrams/sequence-*.md
!.brewing/diagrams/.gitkeep
${SLOWCOOK_GITIGNORE_MARKER_END}
`;
}
