# @slowcook-ai/cli

CLI for the slowcook brewing harness. Installs the `slowcook` binary.

## Install

```bash
npm i -D @slowcook-ai/cli
```

## Commands (v0.1)

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

## Coming in later versions

See the [monorepo README](../../README.md) for the roadmap.

## License

MIT
