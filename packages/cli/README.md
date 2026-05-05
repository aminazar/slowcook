# @slowcook-ai/cli

CLI for the slowcook brewing harness. Installs the `slowcook` binary.

> ⚠️ **Active development — expect breaking changes.** Slowcook is pre-1.0 and the architecture itself is iterating in public. The 0.15 line was scrapped mid-cut and replaced by today's 0.16 mock-app architecture. CLI commands, file layouts, prompt contracts, and the package surface can and will change between alpha versions.
>
> If you're adopting slowcook today: pin exact versions in your consumer (`.brewing/slowcook-cli-version`), read each release entry in [the changelog](https://github.com/aminazar/slowcook/blob/main/CHANGELOG.md) before bumping, and treat it as a partnership — feedback from real consumers is what drives the next cut.

## Install

```bash
# Stable line (0.13.x today; story-flow + bug-flow + chef orchestrator)
npm i -D @slowcook-ai/cli

# 0.16 alpha track (singular mock app + element-anchored review)
npm i -D @slowcook-ai/cli@alpha @slowcook-ai/mock-runtime@latest
```

The `latest` tag points at the most recent stable cut; the `alpha` tag points at the in-progress 0.16 architecture. The two are NOT installable together — pick one per consumer.

## Commands (v0.4)

### `slowcook refine` (first agent)

Drives a GitHub issue through a clarifying-question loop until a frozen spec is emitted as a draft PR. Enforces the issue-level ratchet: new issues must not silently duplicate or contradict earlier decisions.

```bash
npx slowcook refine --issue <number> [options]
```

**Required environment:**

- `ANTHROPIC_API_KEY` — for the refinement and relationship-analysis LLM calls
- `GITHUB_TOKEN` — with `contents: write`, `issues: write`, `pull-requests: write`

**Options:**

| Flag | Default | Description |
|---|---|---|
| `--issue <number>` | required | GitHub issue number |
| `--cwd <path>` | `.` | Repo working directory |
| `--owner <login>` | parsed from git remote | Repo owner |
| `--repo <name>` | parsed from git remote | Repo name |
| `--base <branch>` | `main` | Base branch for the draft spec PR |
| `--refine-model <id>` | `claude-opus-4-7` | Model for the refinement loop |
| `--relationship-model <id>` | `claude-sonnet-4-5` | Model for relationship analysis |

**Behaviour per invocation:**

1. Reads the issue (body + labels + comments) and all currently-active specs.
2. Runs a relationship analysis: `new_or_independent | overlap | contradiction`.
3. Acts on the verdict:
   - **overlap** — posts a comment naming the overlapping spec ids, applies `blocked-overlap` label, exits.
   - **contradiction** without `change-of-mind` label — posts a blocker comment, applies `blocked-contradiction` label, exits.
   - **contradiction** with `change-of-mind` label — proceeds; the spec's `supersedes` field is populated.
   - **new / independent** — proceeds to the refinement loop.
4. Runs one round of refinement: either posts clarifying questions (and exits; next invocation picks up on the next PM comment) OR emits the spec YAML, writes `specs/story-N.yaml` and updates `specs/_index.yaml`, commits + pushes a branch, opens a draft PR, applies `spec-ready` label.

Re-run on every new PM comment in the issue (via a GitHub Actions workflow triggered by `issue_comment` + `issues` events).

### `slowcook init`

Scaffold slowcook configuration in a consumer project. Writes `.brewing/*`, `.github/workflows/slowcook.yml`, and a `CODEOWNERS` section. Idempotent — re-running skips existing files unless `--force`.

```bash
npx slowcook init [--owner <handle>] [--force] [--dry-run] [--cwd <path>]
```

**Options:**

| Flag | Default | Description |
|---|---|---|
| `--cwd <path>` | `.` | Target project directory |
| `--owner <handle>` | detected from git remote | CODEOWNERS handle/team (e.g. `@your-handle`, `@acme/frontend`) |
| `--force` | false | Overwrite existing slowcook files |
| `--dry-run` | false | Print the plan without writing anything |

**Stack detection (0.3):** reads `package.json`. Requires Vitest in `devDependencies`. If Playwright is present, it's noted as a warning and left out of `stack.json` until slowcook supports Playwright discovery.

**CODEOWNERS handling:** uses `# --- slowcook:frozen-paths BEGIN/END ---` markers so re-running or adopting slowcook in a repo that already has a `CODEOWNERS` is safe.

**Exit codes:**

- `0` — success (or dry-run completed)
- `2` — script error (no `package.json`, vitest not found, invalid JSON)

### `slowcook guard`

Checks for frozen-path violations between two git refs. Intended for CI.

```bash
npx slowcook guard --base origin/main --head HEAD
```

**Options:**

| Flag | Default | Description |
|---|---|---|
| `--base <ref>` | `origin/main` | Base git ref to compare from |
| `--head <ref>` | `HEAD` | Head git ref to compare to |
| `--override` | false | Report violations but exit 0 (audit-only) |
| `--config <path>` | `.brewing/frozen-paths.json` | Config file location |

**Exit codes:**

- `0` — no violations (or `--override` was set and violations existed)
- `1` — violations detected
- `2` — script error (missing config, git failure)

**Config file** — a JSON file the consumer project ships, typically at `.brewing/frozen-paths.json`:

```json
{
  "directories": ["tests/", "tests-fixtures/"],
  "files": ["vitest.config.ts", "playwright.config.ts"],
  "partial": {
    "package.json": {
      "frozen_key_paths": ["scripts.test", "scripts.e2e"]
    }
  }
}
```

- `directories` — prefix match; anything under these paths is frozen.
- `files` — exact path match.
- `partial` — for files where only certain JSON keys are frozen (e.g., only `scripts.test*` in `package.json`).

### Use in GitHub Actions

```yaml
# .github/workflows/frozen-paths-guard.yml
name: frozen-paths-guard
on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - name: Run guard
        env:
          HAS_OVERRIDE: ${{ contains(github.event.pull_request.labels.*.name, 'override-freeze') }}
        run: |
          ARGS="--base origin/${{ github.base_ref }} --head HEAD"
          if [ "$HAS_OVERRIDE" = "true" ]; then ARGS="$ARGS --override"; fi
          npx --yes @slowcook-ai/cli@latest guard $ARGS
```

The guard emits `::error file=...::` annotations and writes to `$GITHUB_STEP_SUMMARY` when run in GitHub Actions.

### `slowcook manifest` (record / verify)

Captures the set of discoverable tests so agents can't silently remove or exclude them. 0.2 supports Vitest; Playwright is coming later.

```bash
# Record a snapshot of every test currently discoverable
npx slowcook manifest record

# Verify later that the recorded set still fully resolves
npx slowcook manifest verify
```

**Options (both subcommands):**

| Flag | Default | Description |
|---|---|---|
| `--stack-config <path>` | `.brewing/stack.json` | Consumer stack config |
| `--manifest <path>` | `.brewing/manifests/all.json` (or `.brewing/manifests/story-<id>.json` if `--story`) | Where to write / read the manifest |
| `--story <id>` | none | Tag manifest with a story id (enables per-story freezing) |
| `--cwd <path>` | `.` | Working directory for discovery commands |

**Config file** — `.brewing/stack.json` declares how to discover tests per suite:

```json
{
  "language": "typescript",
  "test": {
    "backend": {
      "runner": "vitest",
      "run_command": "npx vitest run",
      "discover_command": "npx vitest list",
      "reporter_format": "vitest-list-lines"
    }
  }
}
```

**Exit codes:**

- `record`: `0` manifest written, `2` script error (bad config, suite discovery failed)
- `verify`: `0` manifest matches (new tests since record are informational), `1` recorded tests no longer discoverable, `2` script error

**Use in GitHub Actions** — after the frozen-paths guard:

```yaml
      - name: Verify test manifest
        run: npx --yes @slowcook-ai/cli@latest manifest verify
```

## Coming in later versions

See the [monorepo README](../../README.md) for the roadmap.

## License

MIT
