# slowcook

> TDD-first agentic development harness. Turn a detailed user story into frozen tests, then let agents iterate under strict guardrails until every test is green.

[![npm](https://img.shields.io/npm/v/@slowcook-ai/cli.svg)](https://www.npmjs.com/package/@slowcook-ai/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

> ⚠️ **Active development — expect breaking changes.** Slowcook is pre-1.0; the architecture itself is iterating in public. The 0.15 line was scrapped mid-cut (PR #145 closed) and replaced by today's 0.16 mock-app architecture. Public APIs, CLI commands, file layouts, and prompt contracts can and will change between alpha versions. Pin exact versions in your consumer (`.brewing/slowcook-cli-version`); read each release entry in [`CHANGELOG.md`](./CHANGELOG.md) before bumping. If you adopt slowcook today, treat it as a partnership — the project is still finding its shape and feedback from real consumers is what drives the next cut.

## Status

**0.16 — singular mock app + element-anchored review (in progress).** Architectural reset of 0.15. The mock layer now lives at `mock/` — a singular per-consumer Next.js app, totally separate from `src/`, runnable in docker on the consumer's box. Vibe writes scenarios into the mock; recipe writes tests in parallel, blind to the mock; a deterministic `slowcook port` copies new mock components into `src/`; brew (`--mode plate`) reconciles UI with real data + handlers. Canonical architecture reference: [`docs/plans/0.16-mock-app.md`](./docs/plans/0.16-mock-app.md).

**Shipped so far in 0.16 (alpha track, not on `latest`):**

- `@slowcook-ai/mock-runtime@0.1.0` — Scenario types, `defineScenarios([])`, `<ScenarioRegistryProvider>`, `useScenarioFixture<T>()`, `<ScenarioPicker />` ✅ published
- `@slowcook-ai/core@0.13.0` — `Scenario`, `MockUser`, `ScenarioRegistry` types lifted to core ✅ published
- `cli@0.16.0-alpha.1` — `slowcook init mock` scaffolds the mock app ✅ published
- `cli@0.16.0-alpha.2` — core retrack, no behavior change 🟡 in-repo
- `cli@0.16.0-alpha.3` — BUG-F refine-synth fixes (`_id`/`_at` columns no longer treated as tables; English-prose words rejected from apiColumns) 🟡 in-repo
- `cli@0.16.0-alpha.4` + `llm-anthropic@0.12.0` — vibe v2 (writes into `mock/`, REUSE-existing-components prompt rules, `mock/` path-safety guard) + recipe-blind-to-mock testgen addendum 🟡 in-repo

**Open work (numbered alphas through α.10):**

| Alpha | Brings |
|---|---|
| α.5 | `.brewing/preview.yaml` schema + `slowcook preview deploy/teardown` CLI + workflow templates + `docs/operating-guide.md` (consumer's box: Docker + reverse proxy + wildcard cert + SSH user) |
| α.6 | `@slowcook-ai/review-overlay` package — floating toggle on the preview deploy with nav/comment/approve modes + element-anchored selectors (id > data-testid > role+name > tag.classes:nth-child > XPath fallback) + screenshot via canvas API + GitHub PAT submit |
| α.7 | `plate` v2 — parses element-anchored comments, classifies as cosmetic / spec-altering / mock-divergence, escalates spec-altering ones (PM confirms before refine round) |
| α.8 | `slowcook port` — deterministic mock → src copy CLI; pre-brew CI step; runs without an LLM |
| α.9 | `brew --mode plate` v2 — narrower scope after port (UI shape is fixed; brew handles wiring, handlers, migrations, real data); new `SPEC_AMBIGUITY_DETECTED` halt class |
| α.10 | Orchestration trigger chain — `slowcook-mockup-merged.yml` + both-merged trigger that fires brew once both the mockup PR and the recipe-tests PR are in |

**0.14.0-α.1 → α.6 — mockup-first prereqs. Shipped 2026-04-25 → 2026-04-26.** Data-layer seam (`src/lib/data/<domain>.{mock.ts,ts}` with `@slowcook-stub` marker) + `proposals.fixtures.by_domain` schema in `core@0.12.0` + V7 hard-signal synthesizer backstops for `proposals.{ui_layout, fixtures}` + spec-emit content validator (catches LLM-truncation bugs like `var(--tint-in`). Six alphas, six bugs caught + fixed during V6 end-to-end validation against rewo. The α.6+ slices in the original 0.14 plan (full mockup generation by refine) are **superseded by 0.15** in favor of the cleaner `vibe → plate → recipe → brew` separation.

**0.13.0–0.13.6 — brownfield extraction foundation. Shipped 2026-04-25.** `slowcook map --emit-schema` (Supabase migrations → Mermaid erDiagram), `--emit-tokens` (CSS `:root` + `@theme` → tokens catalog), top-level `slowcook extract` command, `buildProjectContext` reads both, refine prompts steer agent to reuse existing entities + tokens by exact name. Validated on rewo: 10 entities + 21 light + 21 dark + 10 @theme tokens parsed in 315ms.

**0.13.0 — bug-flow + chef orchestrator + `testgen` → `recipe` rename. Cut 2026-04-25.** Slowcook now runs two parallel pipelines:

```
Story flow:  refine        →  recipe                 →  brew
Bug flow:    investigate   →  recipe --regression    →  sift
                                ↓
                              chef (watches all PRs, retries failures, escalates)
```

The story flow has been the production path since 0.7.x. The bug flow shipped 2026-04-25 (six alphas + α.3b LLM regression-test emitter, 345 tests green). Investigate diagnoses bugs by reading code; recipe --regression writes a failing test (deterministic stub OR LLM-backed real test); sift narrows to a regression-test-driven minimum-diff fix; chef orchestrates failure recovery across both flows. See [`docs/plans/0.13-bug-flow-and-chef.md`](./docs/plans/0.13-bug-flow-and-chef.md).

**Most recent shipped milestones:**

- **0.12.7–0.12.12 — Phase 2 brownfield-retrieval.** Code-map gained `line` + `callers` per symbol (2A); brew now writes a per-target code-map slice every iter (2B); `.brewing/patterns/` directory holds team-authored recipes brew indexes into its cached prefix (2C).
- **0.12.9 + 0.12.10 — testgen prevention checks.** Page-link static test catches "code points at non-existent route" regressions; schema-presence test catches "code references column that no migration adds."
- **0.12.13 + forge 0.9.8 — cost-marker fixes.** `slowcook · shipped` rollups now render as a fixed-width restaurant bill and correctly include testgen + brew (the missing-permissions + fire-and-forget bugs got the audit-trail right).
- **0.13.0 (cut 2026-04-25, tag `0.13.0`)** — `recipe` alias for `testgen`; full `investigate` + `sift` + `chef` agents; `recipe --regression` with both deterministic stub + LLM-backed real-test modes; PR opening + auto-trigger workflows. Pipeline now has parallel story-flow + bug-flow; chef watches both.
- **0.13.2–0.13.5 — brownfield extraction foundation for 0.14.** `map --emit-schema` (Supabase migrations → Mermaid erDiagram), `map --emit-tokens` (CSS `:root` + `@theme` → token catalog with light/dark/Tailwind-v4 split), `slowcook extract` focused command, refine reads both as project-awareness context, refine + investigate workflow templates auto-run extraction before each agent invocation. Validated on rewo: 10 entities + 21+21+10 tokens parsed in 315ms.

**Latest published versions:**

| Package | `latest` (stable) | `alpha` (pre-release) |
|---|---|---|
| `@slowcook-ai/cli` | `0.13.x` line — published, but install with care; the 0.16 alpha may be ahead of `latest` for active features | `0.16.0-alpha.1` — `npm i @slowcook-ai/cli@alpha` |
| `@slowcook-ai/core` | `0.13.0` | — |
| `@slowcook-ai/llm-anthropic` | `0.11.x` | `0.12.0` (in-repo for α.4) |
| `@slowcook-ai/mock-runtime` | `0.1.0` (NEW — 0.16 only) | — |
| `@slowcook-ai/forge-github` | `0.10.x` | — |
| `@slowcook-ai/stack-ts` | `0.9.3` | — |
| `@slowcook-ai/recorder` | `0.9.1` | — |
| `@slowcook-ai/gates` | `0.10.0` | — |

> **Pin to the alpha range when adopting 0.16.** The `latest` tag points at the 0.13.x stable line; the 0.16 architecture is on the `alpha` tag. Run `npm i @slowcook-ai/cli@alpha` (and `@slowcook-ai/mock-runtime@latest` — the only versioned line for that package). Breaking changes between alphas are likely; pin exact versions in `.brewing/slowcook-cli-version`.

**Active plan**: [`docs/plans/0.16-mock-app.md`](./docs/plans/0.16-mock-app.md) — canonical architecture reference for the singular-mock-app + element-anchored-review pipeline. Detailed initial design is in [`docs/DESIGN.md`](./docs/DESIGN.md). Recent history: [`docs/plans/0.15-plate-brew.md`](./docs/plans/0.15-plate-brew.md) (**abandoned** mid-cut — the data-layer-seam approach mixed mock data into `src/`, which broke separation; lessons informed 0.16) → [`docs/plans/0.14-mockup-first-refinement.md`](./docs/plans/0.14-mockup-first-refinement.md) (α.1–α.6 shipped) → [`docs/plans/0.13-bug-flow-and-chef.md`](./docs/plans/0.13-bug-flow-and-chef.md). The 0.7→0.11 roadmap (closed) is at [`docs/plans/roadmap-0.7-to-0.11.md`](./docs/plans/roadmap-0.7-to-0.11.md).

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
- **0.7.17 — pipeline closes its own integration gaps.** Page-link static test catches "page imports a component but never mounts it"; spec-driven schema-assertion test catches "spec describes columns no migration adds." Both auto-emitted by testgen.
- **0.8 + 0.9 — tier-2 acceptance + gates.** Playwright runner against a sandbox Supabase project; AI-vision checks; PR-comment-driven HITL review.
- **0.10–0.11 — model adapter + textual proposals.** `@slowcook-ai/llm-anthropic` extracted; refine emits structured route/schema/token proposals reviewers can edit inline.
- **0.12.7–0.12.12 — Phase 2 brownfield-retrieval.** Code-map carries `line` + `callers` per symbol (2A); per-target slice every iter (2B); `.brewing/patterns/` selective loading (2C). Foundation for adopting slowcook on existing codebases.
- **0.12.9 + 0.12.10 — testgen prevention checks.** Page-link fetch-URL static test (every `fetch('/api/...')` resolves to a real route file) + column-presence test (every `.from(t).select(c)` exists in migrations). Both catch real-world failure classes that slipped through tier-1 mocks.
- **0.12.13 + forge 0.9.8 — cost-marker fixes.** `slowcook · shipped` rollup posts a fixed-width "restaurant bill" with refine + recipe + brew + investigate + sift line items. Two underlying bugs fixed: testgen workflow template was missing `issues:write`, brew's halt comment was fire-and-forget (`.catch(() => {})` without await — process exited before the network round-trip).
- **0.13.0 — bug-flow + chef + recipe rename (cut 2026-04-25).** New parallel pipeline for bugs (`investigate → recipe --regression → sift`); `chef` orchestrator for PR-failure recovery; `testgen` renamed to `recipe` for kitchen-metaphor consistency. Six alphas plus α.3b (LLM-backed regression test emitter) shipped to git; final cut after 345 green / 26 files.

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

Active plan: [`docs/plans/0.16-mock-app.md`](./docs/plans/0.16-mock-app.md). Recent history: [`docs/plans/0.15-plate-brew.md`](./docs/plans/0.15-plate-brew.md) (abandoned mid-cut — replaced by 0.16) and [`docs/plans/0.14-mockup-first-refinement.md`](./docs/plans/0.14-mockup-first-refinement.md) (α.1–α.6 shipped, α.7+ superseded). Closed: [`docs/plans/roadmap-0.7-to-0.11.md`](./docs/plans/roadmap-0.7-to-0.11.md).

| Version | Brings | Status |
|---|---|---|
| 0.1 | `guard` — frozen-paths enforcement | ✅ shipped |
| 0.2 | `manifest record\|verify` | ✅ shipped |
| 0.3 | `init` — consumer scaffolding | ✅ shipped |
| 0.4 | `refine` — refinement agent | ✅ shipped |
| 0.5 | `testgen` — spec → tests | ✅ shipped |
| 0.6 | `brew` — single-lane ratchet | ✅ shipped |
| 0.7.0–0.7.x | forge/stack refactor, refine `follow_up`, halt diagnostics, PR-gate tests, audit-trail comments, tier-1 UI (helpers + testgen + brew), three pipeline-gap fixes (page-link, schema-presence, styling) | ✅ shipped |
| 0.8 | Tier-2 acceptance runner (Playwright + real sandbox) + screenshot capture | ✅ shipped |
| 0.9 | `@slowcook-ai/llm-anthropic` carve-out + Gate 1 (axe) live | ✅ shipped |
| 0.10 | `@slowcook-ai/recorder` (R&R fixture format) + `@slowcook-ai/gates@0.10.0` (Gate package) + tier-2 infra live on rewo | ✅ shipped |
| 0.11 | Textual proposals (schema/ui_layout/routes/auth/perf/observability/infra/api_shape) + Mermaid in PR body + `/refine` resubmit + brew reading proposals + spec-body-synth backstop + first end-to-end clean ship (rewo PR #114, $1.92) | ✅ shipped |
| 0.12.x | Phase 2 brownfield-retrieval (code-map line+callers, per-target slice, `.brewing/patterns/`) + testgen prevention checks (page-link, schema-presence) + cost-marker fixes (restaurant-bill rollup) | ✅ shipped |
| 0.13.0 | Bug-flow + chef orchestrator: parallel `investigate → recipe --regression → sift` pipeline; `chef` watches all PRs and classifies failures; `testgen` renamed to `recipe` for kitchen-metaphor consistency | ✅ shipped (cut 2026-04-25) |
| 0.13.2–0.13.6 | Brownfield extraction foundation: `slowcook map --emit-schema` (Supabase migrations → Mermaid ERD), `--emit-tokens` (CSS `:root` + `@theme` → tokens catalog), top-level `slowcook extract` command, refine reads both via `buildProjectContext`, refine + investigate workflow templates auto-run extraction | ✅ shipped |
| 0.14.0-α.1–α.6 | Mockup-first prereqs: data-layer seam (`<domain>.mock.ts` + `@slowcook-stub` marker), `proposals.fixtures.by_domain` schema in `core@0.12.0`, V7 hard-signal synthesizer backstops, spec-emit content validator. Six bugs caught + fixed during V6 end-to-end validation against rewo. | ✅ shipped (cut 2026-04-26) |
| 0.14.0-α.7+ | Original plan: refine emits `src/**/page.tsx` directly + preview URL + vision-capable amendment | ⛔ superseded by 0.15 |
| 0.15 | First take on the `vibe + plate + recipe + brew` parallel-converge pipeline. Started shipping (vibe agent, emit module, data-layer seam in `src/lib/data/<domain>.{mock.ts,ts}`) but mid-cut feedback rejected the approach: mixing mock data into `src/` broke the mock + production filesystem separation. PR #145 closed; lessons folded into 0.16. | ⛔ abandoned mid-cut |
| **0.16** | **Singular mock app + element-anchored review.** New per-consumer `mock/` Next.js app, totally separate from `src/`, runnable in docker on the consumer's box. Vibe extends the mock incrementally per story (no per-story shadow copies); recipe writes behavior tests blind to the mock; deterministic `slowcook port` copies new mock components into `src/`; `brew --mode plate` reconciles UI with real data + handlers + migrations. Element-anchored review overlay ships as a separate package; plate v2 classifies PM comments and escalates spec-altering ones. **In progress** — α.1–α.4 shipped; α.5–α.10 listed in the Status section above. | 🚧 cutting 2026-04-26 → ongoing |

The original design ([`docs/DESIGN.md`](./docs/DESIGN.md)) described a standalone `@slowcook-ai/dashboard` package for HITL review; the reconciled roadmap descopes that in favor of GitHub-native surfaces (PR comments + native review UI + drag-drop annotated screenshots).

### 0.16 pipeline at a glance

```
human spec ─→ refine → spec.yaml (merged) ─┬─ vibe → mock/scenarios/story-N.ts ─→ plate iterations ─→ mockup PR merged ─┐
                                           │                                                                              │
                                           └─ recipe (BLIND to mock) → tests/integration/story-N*.test.ts ─→ tests PR ───┤
                                                                                                                          ▼
                                                                                                            slowcook port (mock → src, deterministic)
                                                                                                                          ↓
                                                                                                            brew --mode plate (real data, handlers, migrations)
                                                                                                                          ↓
                                                                                                                       served
```

- **`mock/` is a singular per-consumer Next.js app** that grows incrementally. Vibe writes ONLY into `mock/`; brew writes ONLY into `src/` (after `slowcook port`).
- **`refine` is the upstream gate**; vibe + recipe both wait for spec-merge, then run in parallel.
- **`plate` is the mockup-iteration loop** — PM clicks through the live preview deploy, leaves element-anchored comments via the review overlay, plate amends scenarios/components or escalates to refine when the comment alters spec.
- **`recipe` is BLIND to the mock** — writes behavior assertions against the production component path; never imports from `mock/` or scenario files. Parallelism only works because recipe doesn't over-fit to vibe's exact JSX.
- **`slowcook port` is deterministic** (no LLM) — copies new mock components into `src/` before brew runs. Brew never copies, never UI.
- **`brew --mode plate`** focuses on the wiring problem: real data, real handlers, schema migrations, tests-green. UI shape is fixed at port-time.
- **`served`** is the label for the final brew-merged PR.

For non-UI stories (backend-only, infra), vibe's eligibility gate sniffs the spec's `ui_behavior` block and skips with exit 0; brew runs in its today-equivalent mode.

## Architecture

slowcook is a pnpm workspace monorepo. Packages publish independently and depend on each other via `workspace:^` (rewritten to real versions at publish time).

| Package | Purpose | Depends on |
|---|---|---|
| `@slowcook-ai/core` | Spec / index / proposals types, ratchet logic, halt schema, change-of-mind algebra — pure functions, no I/O | — |
| `@slowcook-ai/llm-anthropic` | Anthropic-tuned prompts for every agent (refine / testgen / brew / investigate / sift) + a thin `LlmClient` wrapper. Exists so swapping LLMs in future is a package swap, not a refactor | core |
| `@slowcook-ai/recorder` | R&R (record + replay) fixture format. Supabase calls captured at brew time, replayed in tier-1 tests | core |
| `@slowcook-ai/gates` | Gate 1 (axe / WCAG), Gate 2 (Claude vision), Gate 3 (PM review via PR comments) | core |
| `@slowcook-ai/stack-ts` | TypeScript / JS stack adapter — Vitest discovery + run, init-time scaffolding | core |
| `@slowcook-ai/forge-github` | GitHub adapter — labels, statuses, PRs, issue comments, all workflow templates | core |
| `@slowcook-ai/cli` | `slowcook` CLI binary — full agent set (refine / recipe / brew / investigate / sift / chef) + tools (guard / manifest / map / extract / init / catchup / on-*-merged / dispatch / fixtures) | all of the above |

Forge-agnostic + stack-agnostic by design. GitLab and Python adapters are fast-follows that drop into the existing interfaces; no core changes needed.

## Consumer dogfood

[`reworthy/app`](https://github.com/reworthy/app) is slowcook's first consumer and integration-test project. **Most features and bug fixes in the changelog were motivated by running slowcook against rewo and fixing what broke.** The 0.14.0-alpha.3–α.5 arc is a recent example: five distinct synth bugs were caught by re-running new code against rewo's real story specs (see `feedback_run_synth_against_real_specs` memory).

When changing anything in `proposals-synth.ts`, `mock-fixtures.ts`, or any `prompts/*.ts`, run it against an actual rewo spec before cutting an alpha — unit tests with synthetic inputs miss real-world prose conventions.

## Development

```bash
# Setup
pnpm install
pnpm -r build           # build all packages — REQUIRED before publish
pnpm test               # vitest across the workspace (~390 tests today)
pnpm typecheck

# Per-package targeted test
cd packages/cli && pnpm test -- --reporter=basic --run <pattern>

# Validate a synth change against a real consumer spec (see memory)
cd /path/to/rewo
git fetch origin slowcook/spec/story-XXX
git show origin/slowcook/spec/story-XXX:specs/story-XXX.yaml > /tmp/spec.yaml
node /tmp/synth-test.mjs   # tiny driver — see feedback_run_synth_against_real_specs

# Run the brownfield extract locally
npx slowcook@alpha extract  # writes .brewing/diagrams/{schema.mmd,tokens.md}
```

### Publishing

Every package has `prepublishOnly: "tsc -b"` so `npm publish` re-builds `dist/` automatically. Still:

1. Run `pnpm -r build` + spot-check the dist tree before publishing (the 0.7.4–0.7.6 stale-dist incident produced the `feedback_build_before_publish` memory — script-level guards aren't a substitute for a manual eyeball).
2. Pre-release versions (`0.14.0-alpha.N`) **must** publish with `--tag alpha` so they don't become `latest` for stable consumers. The 2026-04-25 `cli@0.14.0-alpha.2` publish accidentally took `latest`; fix is `npm dist-tag add @slowcook-ai/cli@<stable> latest`.
3. Dependency order on a multi-package release: `core` → `llm-anthropic` / `recorder` / `gates` (no cross-deps) → `stack-ts` / `forge-github` (depend on core) → `cli` (depends on everything). Publish in that order so `workspace:^` rewrites resolve correctly.

### Validation against rewo

`reworthy/app`'s CI is the real integration test. Every behaviour change should ride through one of:

- A `/refine` round on an open issue (story-flow validation)
- A `/refine` comment on an open spec PR (amendment validation)
- A merge of a `slowcook-bug-profile` PR (sift / bug-flow validation)
- An issue labeled `bug` (investigate validation)

Live runs cost ~$0.30–$2 per round on Opus, $0.10–$0.50 on Sonnet. Bound the spend with explicit budget caps in the config; the `slowcook · shipped` rollup renders the per-agent breakdown.

## License

MIT — see [LICENSE](./LICENSE).
