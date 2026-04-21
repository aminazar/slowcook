# slowcook

> TDD-first agentic development harness. Turn a detailed user story into frozen tests, then let agents iterate overnight under strict guardrails until every test is green.

[![npm](https://img.shields.io/npm/v/@slowcook-ai/cli.svg)](https://www.npmjs.com/package/@slowcook-ai/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

## Status

**0.5 — test-gen agent.** Two agents now in the pipeline: `slowcook refine` (issue → spec) and `slowcook testgen` (merged spec → Vitest integration tests). Testgen fires automatically on push to main touching `specs/story-*.yaml`, is idempotent, respects the supersede chain (removes superseded stories' tests with auto-applied `override-freeze`), and opens a draft PR for review. Full pipeline (refinement → frozen tests → brewing → gates → HITL dashboard) is in [`docs/DESIGN.md`](./docs/DESIGN.md).

## The idea

Existing "vibe-coding" platforms optimize for time-to-first-screenshot. That's great for demos, bad for code you'll actually run. slowcook picks the opposite end of the spectrum:

1. **You write a detailed user story** (slowcook's refinement agent helps).
2. **Tests get generated and frozen** — humans approve once; agents can never modify them.
3. **Agents iterate overnight** under a ratchet: every commit must maintain all previously-passing tests and add at least one. Regressions are auto-reverted. Skipping tests is mechanically impossible.
4. **Morning review** is ~10% of the work — just the stuff that genuinely requires taste (brand feel, aesthetic calls).

Result: sturdy, test-covered code produced while you sleep, with an audit trail of exactly how it got there.

## Getting started

```bash
# Scaffold slowcook config in an existing TS/Vitest project
npx @slowcook-ai/cli@latest init

# Review + commit the generated files, then
npx @slowcook-ai/cli@latest manifest record
```

Or install locally:

```bash
npm i -D @slowcook-ai/cli
npx slowcook init
```

## What works today (v0.4)

### `slowcook refine` (first agent)

Drives a GitHub issue toward a frozen spec. Each invocation is one round: it analyzes the issue against existing specs, then either asks clarifying questions or emits the final spec and opens a draft PR. The agent enforces a **ratchet** on previously-accepted decisions:

- **Overlap** with existing specs → posts a comment, asks PM to merge / delta / close-as-duplicate, exits.
- **Contradiction** without a `change-of-mind` label → posts a blocker comment, applies `blocked-contradiction` label, exits.
- **Contradiction** with `change-of-mind` label → proceeds; the resulting spec explicitly `supersedes` the older stories and `specs/_index.yaml` is updated.

```bash
# In CI (triggered on issue labeled/commented):
ANTHROPIC_API_KEY=... GITHUB_TOKEN=... npx slowcook refine --issue 15
```

Requires `ANTHROPIC_API_KEY` (Claude) and `GITHUB_TOKEN` (issues/PRs write) in the environment.

### `slowcook init`

Scaffolds `.brewing/*`, a GitHub Actions workflow, and CODEOWNERS entries in one command. Idempotent (re-running skips existing files unless `--force`). Detects Vitest and Playwright in your `package.json`; Playwright is recognized but left out of `stack.json` until slowcook supports Playwright discovery.

```bash
npx slowcook init                # default
npx slowcook init --dry-run      # show plan, write nothing
npx slowcook init --owner @team  # override CODEOWNERS handle
npx slowcook init --force        # overwrite existing slowcook files
```

### `slowcook guard`

Enforces frozen paths between two git refs. Runs in CI on every PR.

```bash
npx slowcook guard --base origin/main --head HEAD
```

Reads `.brewing/frozen-paths.json`. Exits non-zero on any violation. Produces GitHub Actions annotations and PR step summaries. Supports `--override` for legitimate frozen-path edits (typically via an `override-freeze` PR label).

### `slowcook manifest record` / `slowcook manifest verify`

Captures the set of tests discoverable at a point in time and later verifies none have gone missing. Runs in CI alongside `guard`.

```bash
# Freeze the current set of tests into a manifest
npx slowcook manifest record

# Verify later that nothing got quietly removed
npx slowcook manifest verify
```

Reads `.brewing/stack.json` to know how to discover tests. 0.2 supports Vitest (`vitest-list-lines`); Playwright support lands in a later release.

See [`packages/cli/README.md`](./packages/cli/README.md) for full usage.

## Coming next

| Version | Brings |
|---|---|
| 0.2 ✅ | `manifest record\|verify` — prevents test skip/exclude cheats |
| 0.3 ✅ | `init` — scaffolds `.brewing/*` in consumer projects |
| 0.4 ✅ | `refine` — refinement agent (issue → structured spec) |
| 0.5 ✅ | `testgen` — test generation from spec |
| 0.6 ✅ | `brew` — the ratcheted implementation loop (single lane) |
| 0.7 | Parallel lanes |
| 0.8 | Tiered reviewer + mutation audit |
| 0.9 | Gate 1 (mechanical) + Gate 2 (vision) |
| 1.0 | HITL dashboard + end-to-end pipeline |

Per-version roadmap lives in [`docs/DESIGN.md`](./docs/DESIGN.md).

## Architecture

slowcook is a pnpm workspace monorepo:

| Package | Purpose |
|---|---|
| `@slowcook-ai/core` | Types, ratchet logic, halt schema — pure functions, no I/O |
| `@slowcook-ai/cli` | `slowcook` CLI binary |
| `@slowcook-ai/stack-ts` | TypeScript/JS adapter — vitest (shipped 0.2), playwright (later), stryker (0.8) |
| `@slowcook-ai/forge-github` | GitHub adapter (labels, statuses, PRs) — 0.4 |
| `@slowcook-ai/worker` | Long-running orchestrator daemon — 0.6 |
| `@slowcook-ai/dashboard` | Next.js HITL admin UI — 1.0 |

Forge-agnostic and stack-agnostic by design; GitLab and Python adapters are fast-follows.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

## License

MIT — see [LICENSE](./LICENSE).
