# slowcook

> TDD-first agentic development harness. Turn a detailed user story into frozen tests, then let agents iterate overnight under strict guardrails until every test is green.

[![npm](https://img.shields.io/npm/v/@slowcook-ai/cli.svg)](https://www.npmjs.com/package/@slowcook-ai/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

## Status

**0.1 — frozen-paths enforcement.** The full pipeline (refinement → frozen tests → brewing → gates → HITL dashboard) is documented in [`docs/DESIGN.md`](./docs/DESIGN.md) and under active development. First shipping feature is the `guard` command — the foundational anti-cheat primitive that the rest of the pipeline depends on.

## The idea

Existing "vibe-coding" platforms optimize for time-to-first-screenshot. That's great for demos, bad for code you'll actually run. slowcook picks the opposite end of the spectrum:

1. **You write a detailed user story** (slowcook's refinement agent helps).
2. **Tests get generated and frozen** — humans approve once; agents can never modify them.
3. **Agents iterate overnight** under a ratchet: every commit must maintain all previously-passing tests and add at least one. Regressions are auto-reverted. Skipping tests is mechanically impossible.
4. **Morning review** is ~10% of the work — just the stuff that genuinely requires taste (brand feel, aesthetic calls).

Result: sturdy, test-covered code produced while you sleep, with an audit trail of exactly how it got there.

## Install

```bash
npm i -D @slowcook-ai/cli
```

## What works today (v0.1)

### `slowcook guard`

Enforces frozen paths between two git refs. Runs in CI on every PR.

```bash
npx slowcook guard --base origin/main --head HEAD
```

Reads `.brewing/frozen-paths.json` from the consumer project. Exits non-zero on any violation. Produces GitHub Actions annotations and PR step summaries. Supports `--override` for legitimate frozen-path edits (typically via an `override-freeze` PR label).

See [`packages/cli/README.md`](./packages/cli/README.md) for full usage.

## Coming next

| Version | Brings |
|---|---|
| 0.2 | `manifest record\|verify` — prevents test skip/exclude cheats |
| 0.3 | `init` — scaffolds `.brewing/*` in consumer projects |
| 0.4 | `refine` — refinement agent (issue → structured spec) |
| 0.5 | `testgen` — test generation from spec |
| 0.6 | `brew` — the ratcheted overnight loop (single lane) |
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
| `@slowcook-ai/stack-ts` | TypeScript/JS adapter (vitest, playwright, stryker) — 0.2 |
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
