# slowcook

> TDD-first agentic development harness. Turn a detailed user story into frozen tests, then let agents iterate under strict guardrails until every test is green.

[![npm](https://img.shields.io/npm/v/@slowcook-ai/cli.svg)](https://www.npmjs.com/package/@slowcook-ai/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

## Status

**0.7.17 — pipeline closes its own integration gaps.** The pipeline runs end-to-end: `slowcook refine` (issue → spec) → `slowcook testgen` (spec → handler + UI tests + stubs + helpers + **page-link + schema static assertions**) → `slowcook brew` (ratcheted implementation loop, now fluent in editing Next.js pages + writing SQL migrations). Each transition posts an audit-trail comment on the source GitHub issue. Stories with `ui_behavior` get page-integration assertions so a test suite can't go green while the page forgets to mount the component; stories whose invariants describe DDL get schema assertions so migrations can't silently be skipped.

**First fully-autonomous UI shipment on rewo landed via PR #61 (2026-04-23).** Issue #47 / story-006 traversed refine → testgen (handler + UI bundles) → brew (1 iter, $0.21) after the observability arc (0.7.13 → 0.7.16) taught us to listen to the agent's own diagnosis. 0.7.17 addresses the two residual gaps the shipment exposed (page-integration + schema).

Published packages (latest on npm): `cli@0.11.7`, `core@0.11.0`, `stack-ts@0.9.2`, `forge-github@0.9.2`, `llm-anthropic@0.8.0`, `recorder@0.9.1`, `gates@0.10.0`.

The detailed design is in [`docs/DESIGN.md`](./docs/DESIGN.md); the active roadmap is [`docs/plans/roadmap-0.7-to-0.11.md`](./docs/plans/roadmap-0.7-to-0.11.md).

## The idea

Existing "vibe-coding" platforms optimize for time-to-first-screenshot. That's great for demos, bad for code you'll actually run. slowcook picks the opposite end of the spectrum:

1. **You write a detailed user story** (slowcook's refinement agent helps).
2. **Tests get generated and frozen** — humans approve once; agents can never modify them.
3. **Agents iterate** under a ratchet: every commit must maintain all previously-passing tests and add at least one. Regressions are auto-reverted. Skipping tests is mechanically impossible.
4. **Review** is ~10% of the work — just the stuff that genuinely requires taste (brand feel, aesthetic calls).

Result: sturdy, test-covered code produced while you're doing something else, with an audit trail of exactly how it got there.

## Recent milestones

The version timeline tells the story of how slowcook went from "brew exists" to "autonomous feature shipped."

- **0.5 (testgen agent)** — spec → Vitest tests as a PR. Idempotent; respects supersede chains.
- **0.6 (brew command)** — single-lane ratcheted loop. Baseline test run → per-iteration agent turn → test run → ratchet (revert regressions, revert no-progress, commit only checkpoints) → halt on budget / iteration / stagnation / wall-clock with a structured JSON report.
- **0.6.7 — Sonnet 4.6 as default, focus tools.** `find_handler({method, path})` + `outline_file(path)` collapse exploratory iterations. Single biggest driver of cost reduction.
- **0.6.8 — `slowcook map`.** A ts-morph-driven code map (APIs, pages, components, helpers, types) that brew reads first on every iteration. Replaces a dozen read_file calls with one.
- **0.6.11–0.6.13 — tier-1 test shape.** `vi.mock("path")` auto-mock form; `realShapedCreateClient(client)` signature-asserting wrapper that throws when handler code omits required arguments. Mock drift becomes a test failure, not a production crash.
- **2026-04-22: first autonomous brew success.** Rewo `story-005` (a reactions-page API) brewed end-to-end: 2 iterations, **$0.04 spent**, 11/11 tests green in 3m 57s. Prior Opus attempts on the same shape: $4-$12 per run with zero checkpoints. Sonnet + focus tools + tier-1 shape + stubs-in-place delivered a **~300× cost reduction** and crossed the autonomy threshold.
- **0.7.0 — forge + stack refactor + testgen Phase B2.** Moved GHA workflow templates + TS stack scaffolds into their adapter packages (`forge-github`, `stack-ts`); CLI now stays genuinely forge- and stack-neutral. Testgen emits a bundle: test file + route stubs + mock helpers in one PR.
- **0.7.1 — refine `follow_up` verdict.** Issues that fulfill scope a prior spec explicitly deferred via `non_goals` no longer halt as "overlap." Plus GitHub-native `#N` references in comments.
- **0.7.2 — brew halt diagnostics.** Full per-iteration history in the halt report (was truncated to last 3), cost sign bug fixed, rolling run log rescued into the halts/ artifact, regression tests list the broken test IDs inline.
- **0.7.3 — PR-gate runs vitest.** Closes a silent-red enforcement hole the `slowcook.yml` template had: broken tests now fail the PR that introduces them, not main.
- **0.7.4 — audit-trail comments.** refine / testgen / on-spec-merged / on-tests-merged / brew / on-brew-merged each post a status comment on the source issue so each issue thread tells its full pipeline story.
- **0.7.5 (Phase A) — tier-1 UI helpers scaffolded.** `slowcook init` emits `renderWithProviders` + `mockFetch`/`realShapedFetch` + `jest-axe` wiring. Consumers get the test-infra layer UI tests depend on.
- **0.7.6 — re-publish 0.7.4 + 0.7.5 with correct `dist/`.** Both prior versions had shipped with stale compiled output because `pnpm build` wasn't run before publish. Fixed; all packages now have `prepublishOnly: "tsc -b"` as a guard.
- **0.7.7 (Phases B + C) — testgen UI bundle + brew UI-aware.** Testgen emits `<ui_test_file>` + `<ui_stub>` blocks when specs have `ui_behavior`; a new `"ui-only"` mode lets testgen retroactively add UI tests to a brownfield story whose handler was built pre-0.7.5. Brew's system prompt knows how `.test.tsx` targets work (edit `src/components/` or client pages, respect `@slowcook-stub` markers, mock `fetch` via `vi.stubGlobal`, use `"use client"`).

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

Init scaffolds `.brewing/*`, the slowcook GitHub Actions workflows, CODEOWNERS entries, and tier-1 UI testing helpers under `tests/helpers/*`. The post-run output prints the devDependencies you need to install (`@testing-library/react`, `jest-axe`, `jsdom`, …) and the one-line edit to add to your `vitest.config.ts`.

## What works today

### Pipeline commands (agent-driven)

- **`slowcook refine --issue <N>`** — drive a GitHub issue toward a frozen spec YAML. Posts clarifying questions, detects overlap / contradiction / follow-up against active specs, opens a draft PR when the spec is ready. Runs in CI on `issues: [opened, labeled, reopened]` + `issue_comment: [created]`.
- **`slowcook testgen`** — spec → Vitest integration tests + route stubs + mock helpers + (for stories with `ui_behavior`) UI component tests + component stubs. Per-spec `"full"` / `"handler-only"` / `"ui-only"` mode inferred from what already exists on disk. Opens a draft PR with the `override-freeze` label (testgen legitimately adds files under `tests/`).
- **`slowcook brew --story <id>`** — the ratchet. Parses the story manifest, runs the test baseline, iterates `read/write/outline` agent turns with Anthropic Sonnet 4.6 by default, commits checkpoints when tests flip red→green without regression, reverts otherwise. Halts cleanly on budget / iteration / stagnation / API-error / manifest-drift with a structured report.

### Pipeline plumbing (workflow-driven)

- **`slowcook on-spec-merged` / `slowcook on-tests-merged` / `slowcook on-brew-merged`** — each fires from a `pull_request.closed` workflow, transitions labels + posts audit-trail comments on the source issue.
- **`slowcook-brew-auto.yml`** — auto-triggers brew after a tests PR merges, using the story-id from the PR's filenames.

### Discipline commands

- **`slowcook guard --base <ref> --head <ref>`** — enforces `.brewing/frozen-paths.json` between two git refs. The `override-freeze` label puts it in advisory mode for legitimate human-authored changes.
- **`slowcook manifest record | verify`** — capture / re-verify the set of tests vitest can discover. Runs in CI on every PR so agents can't quietly skip tests.
- **`slowcook map generate | check`** — ts-morph-driven repo-wide code map (APIs, pages, components, helpers, types). Brew reads the map first on every iteration; CI fails when the committed map drifts from a fresh generation.
- **`slowcook catchup`** — detects + runs pipeline steps that should have triggered but didn't (useful when a workflow misfires).

See [`packages/cli/README.md`](./packages/cli/README.md) for per-command detail.

## Roadmap

Active roadmap in [`docs/plans/roadmap-0.7-to-0.11.md`](./docs/plans/roadmap-0.7-to-0.11.md).

| Version | Brings |
|---|---|
| 0.1 ✅ | `guard` — frozen-paths enforcement |
| 0.2 ✅ | `manifest record\|verify` |
| 0.3 ✅ | `init` — consumer scaffolding |
| 0.4 ✅ | `refine` — refinement agent |
| 0.5 ✅ | `testgen` — spec → tests |
| 0.6 ✅ | `brew` — single-lane ratchet |
| 0.7.0–0.7.7 ✅ | forge/stack refactor, refine `follow_up`, halt diagnostics, PR-gate tests, audit-trail comments, tier-1 UI (helpers + testgen + brew) |
| 0.8 | Tier-2 acceptance runner (Playwright + real sandbox) + screenshot capture |
| 0.9 | Gates 1 + 2 + 3 via GitHub comments (mechanical UI asserts + Claude vision + PM review via PR comments — no standalone dashboard) |
| 0.10 | R&R swap — tier-1 helpers backed by captured fixtures |
| 0.11 | Brownfield cooker — `slowcook bootstrap` → `.brewing/DISCOVERY.md` with semantic code-map enrichment |

The original design ([`docs/DESIGN.md`](./docs/DESIGN.md)) described a standalone `@slowcook-ai/dashboard` package for HITL review; 0.7.7's reconciled roadmap descopes that in favor of GitHub-native surfaces (PR comments + native review UI + drag-drop annotated screenshots).

## Architecture

slowcook is a pnpm workspace monorepo:

| Package | Purpose |
|---|---|
| `@slowcook-ai/core` | Types, ratchet logic, halt schema — pure functions, no I/O |
| `@slowcook-ai/cli` | `slowcook` CLI binary (refine / testgen / brew / guard / manifest / map / init / catchup / on-*-merged) |
| `@slowcook-ai/stack-ts` | TypeScript/JS adapter — Vitest discovery + run, init-time scaffolding |
| `@slowcook-ai/forge-github` | GitHub adapter — labels, statuses, PRs, issue comments, all workflow templates |

Forge-agnostic and stack-agnostic by design; GitLab and Python adapters are fast-follows (0.12+).

## Consumer dogfood

[`reworthy/app`](https://github.com/reworthy/app) is slowcook's first consumer and integration-test project. Most features in this changelog were motivated by running slowcook against rewo and fixing what broke.

## Development

```bash
pnpm install
pnpm build       # required before publish — see feedback_build_before_publish memory
pnpm test
pnpm typecheck
```

Publishing: every package has `prepublishOnly: "tsc -b"` so `pnpm publish` re-builds `dist/` automatically. Still worth running `pnpm -r build` + `grep -l "<new-export>" packages/<pkg>/dist/*.js` manually as a cross-check.

## License

MIT — see [LICENSE](./LICENSE).
