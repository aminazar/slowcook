# slowcook

> TDD-first agentic development harness. Turn a detailed user story into frozen tests, then let agents iterate under strict guardrails until every test is green.

[![npm](https://img.shields.io/npm/v/@slowcook-ai/cli.svg)](https://www.npmjs.com/package/@slowcook-ai/cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

> **🤖 If you're an AI agent (Claude Code, Cursor, etc.) helping a human ship features with slowcook, read [AGENTS.md](./AGENTS.md) first.** It has the pipeline overview, command reference, and the empirical pitfalls list — saves real money + time on your first session. To file a bug: [REPORTING.md](./REPORTING.md).

> ⚠️ **Active development — expect breaking changes.** Slowcook is pre-1.0; the architecture itself is iterating in public. The 0.15 line was scrapped mid-cut (PR #145 closed) and replaced by today's 0.16 mock-app architecture. Public APIs, CLI commands, file layouts, and prompt contracts can and will change between alpha versions. Pin exact versions in your consumer (`.brewing/slowcook-cli-version`); read each release entry in [`CHANGELOG.md`](./CHANGELOG.md) before bumping. If you adopt slowcook today, treat it as a partnership — the project is still finding its shape and feedback from real consumers is what drives the next cut.

## Status

**0.19.5 stable** (cut 2026-06-01) — post-0.19.0 hardening batch. Five point releases over the 0.19.1 → 0.19.5 arc landed the post-emit refine lint chain (`validateEntityFieldReferences`, `validateComponentReuseShape`, `validateRouteCollisions`, `validatePlateDtoColumns`), `slowcook check spec` for PR-amendment safety, `slowcook cost log` for non-Actions agents, the chef DTO-rename surface grep, the brew dual-path + mirror-stories prompt tightening, and managed-block additions (`upsert-agent-docs`) for multi-agent choreography, no-import-stub, doc-audience, and combined-PR patterns. All four 0.20 design discussions are locked + documented in [`docs/plans/0.20-design-discussions.md`](./docs/plans/0.20-design-discussions.md): per-framework backend-adapter packages, `slowcook mirror` codegen, story-ID tombstones, recipe-emitted `brew_strategy`.

The 0.19.0 foundation — `.brewing/repo-knowledge/{auto,curated}/` deterministic code-shape extraction + git-history-mined organizational memory, surfaced to refine + visible to any AI agent via an `AGENTS.md` managed block — remains the bedrock. Empirical baseline: on a NestJS/TypeORM consumer, refine zero-hallucinated backend routes + field names + enum values that the pre-knowledge-layer pipeline had invented.

| Package | Version | Brings |
|---|---|---|
| `@slowcook-ai/cli` | `0.19.5` (latest) | full post-emit refine lint chain + `check spec` + `cost log` + managed-block additions + `on-brew-merged` non-main-branch warning + knowledge layer |
| `@slowcook-ai/llm-anthropic` | `0.16.3` (latest) | chef DTO-rename surface grep + brew dual-path + brew mirror-stories addendum |
| `@slowcook-ai/forge-github` | `0.12.3` (latest) | (no changes since 0.19.4) |
| `@slowcook-ai/stack-ts` | `0.9.9` (latest) | (no changes since 0.19.0) |

**Adopting:** `npm install @slowcook-ai/cli@0.19.5`. Pin in your `.brewing/slowcook-cli-version`. First-run consumers get the full knowledge-layer bedrock automatically via `slowcook init`.

**Milestone 2026-05-27 — knowledge layer + chef-on-brew-halt loop closed (cli α.51 → α.65):** Eleven alphas shipped over two days. Highlights: chef stops hallucinating spec fields (α.51); brew `legacy` renamed to `freehand` with navigator default-on (α.52); chef-drift parse-tolerant (α.53); chef owns test infrastructure incl. vitest.config + package.json devDeps (α.54); navigator gets scope + hallucination discipline (α.55); chef-on-brew-halt loop fully wired: halt artifact → enrichment from iteration_diffs → checkout brew_branch → push fix as PR (α.56-α.60); refine sees NestJS/TypeORM backend digest (α.61); ten disk-cached repo-knowledge digests + curated git-history-mined files (α.62-α.63); AGENTS.md managed block (α.64); init wires the whole bedrock automatically (α.65). Empirical wins from dogfood consumers: chef wrote a real layout component (not className-padded regex bait); refine cited exact mock file paths + brand-token vocabulary + cross-story context — zero hallucinations vs the α.61 baseline that invented routes.

**Highlights of the prior 0.17 → 0.18 arc:**

- **History-aware refine** (cli `0.17.0-α.0`): emits `.brewing/history-index.json` listing existing components + props + tests covering them, API routes, migrations, test helpers. Refine prompts vibe + testgen + brew to read the index; downstream divergence (e.g. PR #147's `MemberReactionsWithPins` vs `MemberReactionsPage`) is structurally hard to reproduce.
- **`slowcook recon`** (cli `0.17.0-α.1`): pre-brew structural backstop. Catches missing components, testid gaps, brownfield rename hazards. Cli `α.6` extends it: emits `tests/integration/story-N-shape.test.tsx` from mock JSX (skipping `data-mock-chrome="true"` subtrees) so brew can edit any file without silently corrupting design.
- **`slowcook init from-prod`** (cli `0.17.0-α.1`): scaffolds a perfect mock from the consumer's prod tree using a 4-strategy taxonomy (verbatim / DI seam / server-mock / skip). Skeleton-only today; full automation in 0.18.x.
- **File-level edit lock LIFTED** (cli `α.7`): brew can edit any file; recon-emitted shape tests + the full-suite test gate are the safety net.
- **Side-effects audit** (cli `0.18.0-α.0`, llm-anthropic `0.14.0`): when refine detects contradiction, a 2nd LLM pass enumerates the exact assertions in conflicting stories that would need to flip. PM reviews granularly + accepts; no more wholesale `change-of-mind` supersede.
- **Port rewrites all mock-runtime imports** (cli `0.18.0-α.1`): `useScenario`, `useScenarioRunner`, etc. dropped + stubbed with `(null as any)` no-ops so ported files compile in src/.
- **gh-proxy in `slowcook run-mock`** (cli `0.18.0-α.2`+, review-overlay `0.5.5`): localhost http proxy signs github calls with `gh auth token`. Overlay reads `NEXT_PUBLIC_SLOWCOOK_GH_PROXY` and skips the PAT prompt entirely. cli `α.3` adds the CORS-header strip so api responses don't double-emit `Access-Control-Allow-Origin`.
- **Recon `resolveImport` no longer accepts mock/src as a prod-`@/` candidate** (cli `0.18.0-α.4`): false-positive `clean` was letting brew dispatch when vitest couldn't actually discover the imported component. Regression test in `recon/index.test.ts` covers both directions.
- **Brew prunes slowcook auto-gen artifacts before scope check** (cli `0.18.0-α.5`): agent edits to `.brewing/code-map.target.md` (or other slowcook-managed files) used to revert the WHOLE iteration alongside legitimately-correct src/ changes. Now silently reverted only on those specific paths so the substantive work proceeds.
- **Entity-first foundation** (cli `0.18.0-α.6`+, α.7): `slowcook init entities` walks `supabase/migrations/*.sql` → emits TS interface + zod schema per table to `src/lib/entities/<table>.ts`, plus a mock-side re-export shim at `mock/src/lib/entities.ts` so `@/lib/entities` resolves under both tsconfigs.
- **First clean 0.18 brew** (dogfood issue #149 → PR #154, 2026-05-04): `35/35 green · 3 checkpoints · $1.29` after the α.2→α.5 fix arc validated end-to-end. Mode=legacy.
- **Entities-as-typed-contract empirically falsified** (2026-05-04, see [`docs/experiments/entities-hypothesis-tested-and-failed.md`](./docs/experiments/entities-hypothesis-tested-and-failed.md)): three dispatches across vibe + brew with the entity layer reachable produced 0 entity imports — agents legitimately use per-component view subsets, not full entities. Pair-brew is the architectural pivot — see [`docs/experiments/pair-brew-local-simulation.md`](./docs/experiments/pair-brew-local-simulation.md) for the local two-iter validation + [`docs/experiments/pair-brew-real-runs-2026-05-04.md`](./docs/experiments/pair-brew-real-runs-2026-05-04.md) for two real runs that surfaced cross-contract drift as the bottleneck.
- **Chef α.9 L1 — micromanager drift-fixer** (cli `0.18.0-α.9`, llm-anthropic `0.14.4`): `slowcook chef-drift` reads a failure trigger (mock-isolation, recon escalation, brew halt, navigator halt) + history-index + pre-computed enrichment (importers, file content) + spec; emits structured ChefVerdict JSON with surgical `search_replace` edits; validates pre-vs-post (handles pre-existing PR debt correctly); commits as `slowcook-chef[bot]`; posts audit comment via gh OR curl fallback. Hard line: never edits `tests/`, `vitest.config.*`, `.brewing/auto-gen/`. Empirically validated end-to-end on a consumer PR #157 (PinnedStrip → PinnedRewosStrip rename autonomous, $0.045 single move). 5 iterations of bug discovery shipped as commits `a7df238…e86d75e`.
- **Chef α.10 L2 — finisher mode** (cli `0.19.0-α.2` on alpha): `slowcook chef-drift --pr <number>` checks out the PR's branch, makes its surgical edits there, and pushes back to the PR head — re-running CI without dispatching a fresh brew. Brew-halt enrichment + path-alias resolver. Empirically validated on a consumer PR #153 (NO-CHANGE → revert; no bad commits pushed).
- **Chef α.10 L3 — pipeline orchestrator** (cli `0.19.0-α.2`): `slowcook chef-orchestrate --pr <n> --story <id>` decides between `redispatch_brew | rebase | escalate | close`. α.0 implements escalate + close end-to-end (post comment + label / gh pr close). Empirically validated on a consumer PR #153: $0.012, verdict CLOSE, PM-actionable comment cited #154/#155 supersede.
- **Pair-brew prod hook** (cli `0.19.0-α.4`, #76): optional `ctx.navigatorHook` on `BrewContext` fires post-iter, pre-checkpoint. On block: revert + fold concerns into next iter. Default Anthropic-backed implementation deferred to α.9+; structural slot ready.
- **Navigator emits hard-signal tests** (cli `0.19.0-α.5`, #77): when soft prompts are ignored across iters, navigator's verdict can carry a `proposedTest` written to `tests/navigator/`. Path-validated. Hard signal escapes the entities-falsified soft-prompt-ignored failure mode.
- **Recon shape v2** (cli `0.19.0-α.6`, #75): `synthesiseShapeTestFile({ emitMode: "v2" })` imports + mounts each component via `@testing-library/react` + queries the live DOM. Catches dynamic-className drift v1's source-grep tests miss.
- **Refactor command** (cli `0.19.0-α.7`, #64): `slowcook refactor` reads `.brewing/refactor/proposals.json`, filters by `--scope`, ranks by benefit-per-cost. Source-agnostic; boundedness rule keeps refactors surgical.
- **Recon `--reuse-scan`** (cli `0.19.0-α.8`+, `α.10` filters): deterministic near-duplicate detection across components AND API/utility files. Pure regex + Jaccard; auto-categorizes by JSX presence; cross-category short-circuits to 0. `α.10` adds default auto-template-skip (matches `@slowcook-template` / `@generated` / "AUTO-GENERATED" headers) + `--exclude <glob>`. Empirical: 65 → 7 pairs on a consumer (89% noise reduction).
- **Default Anthropic-backed pair-brew + `--with-navigator`** (cli `0.19.0-α.9`, #82): `slowcook brew --with-navigator` injects the default `NavigatorHook` into ctx. Adapter pure-tested; end-to-end real brew validation awaits ANTHROPIC budget.
- **Recon `--stub-scan`** (cli `0.19.0-α.11`, #84): walks `src/` for `@slowcook-stub` markers, ages each via `git log --diff-filter=A`, classifies fresh/stale/unknown against `--stub-max-age-days` (default 14). Optional `--stub-escalate` posts PM-actionable comments on the source issue. Different signal class from reuse-scan (incomplete work, not refactor).
- **Chef stack auto-loop** (consumer-side workflow, #83): chef-drift exit-1 in `--pr` finisher mode auto-dispatches chef-orchestrate. Closes the manual-dispatch gap.
- **`slowcook init mock` auto-wires pnpm workspace** (cli `0.19.0-α.3`): detects pnpm consumers + appends `mock` to `pnpm-workspace.yaml` (or creates it). Eliminates duplicate-`node_modules` trap. Honors npm/yarn consumers with a recommendation rather than auto-migrating.
- **Refine PM-facing question rules + visible cost footer** (cli `0.19.0-α.19`/`α.20`, llm-anthropic `0.16.0-α.3`/`α.4`): four hard rules (decide-first, never ask about tests, no internal stage names, ≤3 one-line questions with labeled options) enforced by prompt + eval fixture. Refine comments lead with questions, decisions collapsed in `<details>`, every comment ends with a plain-text cost footer (`💰 This step: $X · Story total: $Y`).
- **`slowcook dev-env` command** (cli `0.19.0-α.21`/`α.22`): scaffolds `.brewing/dev-env.yaml` so brew can be told "this repo uses pnpm + Vitest 4 + Node 22" instead of guessing.
- **Refine sees mock/src/ as design source-of-truth** (cli `0.19.0-α.23`–`α.26`): mock-fidelity bias + `technical-shrug-decide` rule + mock excerpt bumped 1500 → 8000 chars. Refine no longer asks PM questions the mock has already answered.
- **Funds-warning track** (cli `0.19.0-α.28`–`α.34`, llm-anthropic `0.16.0-α.7`–`α.10`, sc#62–#69): testgen graceful-degrade, multi-app proposals.routes filter, proposals.schema auto-emits ALTER TABLE, anthropic-ratelimit-* headers in cost footer, reactive 402 Payment Required catcher (labels PR + posts fuel-empty GIF + exits 2), canonical cost storage at `specs/story-N.cost.jsonl`, project fuel gauge appended to refine output. Three layers of out-of-credit protection: proactive gauge → mid-flight hint → reactive label+exit.
- **`slowcook budget` subcommand + credit-balance gauge** (cli `0.19.0-α.35`, sc#79): reads the canonical cost store + Anthropic credit balance to print a per-project / per-story fuel gauge on demand.
- **Refine Pass B brownfield-answer** (cli `0.19.0-α.36`, llm-anthropic `0.16.0-α.11`, sc#80): second LLM pass that re-grounds the spec against `history-index.json` before testgen sees it. Eval fixture `refine-brownfield-answer-rules` locks the contract.
- **sc#82 shape-aware track** (cli `0.19.0-α.37`–`α.42`, llm-anthropic `0.16.0-α.12`–`α.14`, core `0.14.0`, mock-runtime `0.3.4`): Phase 1 — Vite mock template + shape-aware config (sc#83); Phase 2 — vibe shape-aware (sc#84); Phase 3a — run-mock + plate + recon shape-aware (sc#85); Phase 4 — slowcook brand agent; follow-up — consolidate slowcook logo. Every agent that consumes the mock is now aware of its design-token vocabulary so brand drift surfaces as a recon warning rather than a brew failure.

**OSS incident-response infrastructure (cli α.12-α.14, this round):**

- **Uniform `slowcook:cost` markers** across all 11 agents that post comments — `gh issue view N | grep slowcook:cost` now aggregates per-story spend across the entire pipeline including the chef stack.
- **chef-drift workflow uploads `halt-trigger.json` as artifact** — closes the LLM-input reproducibility gap noted in the read-only-access survey. Maintainer can `gh run download` + replay chef-drift locally with the exact input.
- **`slowcook docs <topic>`** — prints bundled docs (`reporting`, `agents`, `read-only`) from the installed package.
- **`SLOWCOOK_READ_ONLY=1` env var** — single knob that blocks every GitHub-side write across chef-drift / chef-orchestrate / recon stub-escalate. Designed for maintainer-replay on someone else's repo.
- **REPORTING.md** — how to file slowcook bugs (public/private repo paths, no-bundle policy, GitHub-only forge caveat, fix-notice template, triage label table).
- **AGENTS.md** — onboarding doc for AI coding agents (Claude Code, Cursor, etc.). Decision tree, pipeline diagram, 22-command quick reference, ~15-item pitfalls memory.
- **CONTRIBUTING.md + bug-report issue template + 4 new persistent labels** on `aminazar/slowcook` (`needs-info` / `confirmed` / `regression-test-pending` / `blocked-on-anthropic`).

**Local-developer flow (cli α.15-α.16, this session):**

- **`slowcook garnish`** (α.15): commit-gate for human (or other-agent) tweaks on top of agent work. Detects uncommitted changes, traces each file back to the last agent commit, runs scoped tests, commits on green with `Tweaks-output-of:` git trailer lines recording the upstream agent. Trailers become learning signal for a future `slowcook reflect` mining step.
- **`slowcook run-mock <story> --garnish`** (α.16): single-command DevTools Workspaces flow. Boots the mock app locally, disables the review-overlay, prints Chrome Workspaces pairing instructions with the exact mock/src/ path, watches `mock/src/` for file saves (whether from DevTools, vim, VS Code, anything), debounces saves, auto-runs tests + auto-garnishes on green.

**Operational maturity (CI/CD):**

- **Branch protection on `main`** (2026-05-12): `allow_force_pushes: false`, `allow_deletions: false`. Admin can bypass for solo workflow; tighten when contributors arrive.
- **Dependabot wired** (2026-05-12): weekly npm batched PRs (grouped: anthropic / vitest / typescript / testing) + monthly GitHub Actions versions. Catches the class of drift that bit us empirically (vitest-4 fake-timers; future Anthropic SDK changes).
- **Open CI/CD backlog** tracked at [`docs/plans/ci-cd-roadmap.md`](./docs/plans/ci-cd-roadmap.md). Two HIGH items filed as issues: [#19 eval gate in CI](https://github.com/aminazar/slowcook/issues/19), [#20 telemetry schema](https://github.com/aminazar/slowcook/issues/20). Six MEDIUM/LOW items queued in the roadmap doc.

**Pending** (genuinely open, not yet shipped):
- Empirical real-brew validation of `--with-navigator` (needs ANTHROPIC budget + a halt-prone story)
- Empirical chain validation of chef-drift exit-1 → chef-orchestrate (needs an organic halt)
- Persistent-block tracking in the default pair-navigator's prompt context loader (so the proposedTest hard-signal escalation logic α.5 can fire)
- Eval-fixture format + harness ([#19](https://github.com/aminazar/slowcook/issues/19)) — bootstrap from garnish trailers as they accumulate
- Drift detection (planned 0.19)

**End-to-end validated (legacy mode):** dogfood issue #149 → PR #154 on 2026-05-04 ($1.29, 5 iters, 35/35 green). The plate-mode `@slowcook-port-from` carve-out has been deleted from the roadmap — the entities-hypothesis falsification (above) showed prop-shape drift can't be retired with structural rails alone. The architecture has settled on **pair-brew + chef as a two-layer system**: pair-brew (α.8 prototype shipped) is the failure DETECTOR — driver writes; navigator reviews per-iteration, can BLOCK with structured axes. Chef α.9 L1 (shipped + empirically validated) is the failure RESOLVER — surgical micromanaging editor that takes recon/brew/navigator escalations, makes search_replace edits across spec + mockup + src/, never touches tests, escalates to PM only on genuine ambiguity. See `docs/experiments/pair-brew-real-runs-2026-05-04.md` + the chef commits `a7df238…e86d75e` for the empirical record.

**0.14.0-α.1 → α.6 — mockup-first prereqs. Shipped 2026-04-25 → 2026-04-26.** Data-layer seam (`src/lib/data/<domain>.{mock.ts,ts}` with `@slowcook-stub` marker) + `proposals.fixtures.by_domain` schema in `core@0.12.0` + V7 hard-signal synthesizer backstops for `proposals.{ui_layout, fixtures}` + spec-emit content validator (catches LLM-truncation bugs like `var(--tint-in`). Six alphas, six bugs caught + fixed during V6 end-to-end validation against a consumer. The α.6+ slices in the original 0.14 plan (full mockup generation by refine) are **superseded by 0.15** in favor of the cleaner `vibe → plate → recipe → brew` separation.

**0.13.0–0.13.6 — brownfield extraction foundation. Shipped 2026-04-25.** `slowcook map --emit-schema` (Supabase migrations → Mermaid erDiagram), `--emit-tokens` (CSS `:root` + `@theme` → tokens catalog), top-level `slowcook extract` command, `buildProjectContext` reads both, refine prompts steer agent to reuse existing entities + tokens by exact name. Validated on a consumer: 10 entities + 21 light + 21 dark + 10 @theme tokens parsed in 315ms.

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
- **0.13.2–0.13.5 — brownfield extraction foundation for 0.14.** `map --emit-schema` (Supabase migrations → Mermaid erDiagram), `map --emit-tokens` (CSS `:root` + `@theme` → token catalog with light/dark/Tailwind-v4 split), `slowcook extract` focused command, refine reads both as project-awareness context, refine + investigate workflow templates auto-run extraction before each agent invocation. Validated on a consumer: 10 entities + 21+21+10 tokens parsed in 315ms.

**Latest published versions (verified 2026-05-18 via `npm view <pkg> dist-tags`):**

| Package | `latest` (stable) | `alpha` (pre-release) |
|---|---|---|
| `@slowcook-ai/cli` | `0.18.0` | `0.19.0-alpha.41` |
| `@slowcook-ai/core` | `0.13.1` | — (`0.14.0` on main, unpublished) |
| `@slowcook-ai/llm-anthropic` | `0.15.0` | `0.16.0-alpha.15` |
| `@slowcook-ai/forge-github` | `0.12.0` | `0.12.1` |
| `@slowcook-ai/stack-ts` | `0.9.8` | `0.9.9-alpha.0` |
| `@slowcook-ai/review-overlay` | `0.5.5` | — |
| `@slowcook-ai/mock-runtime` | `0.3.3` | — (`0.3.4` on main, unpublished) |
| `@slowcook-ai/recorder` | `0.9.1` | — |
| `@slowcook-ai/gates` | `0.10.0` | — |

> **`latest` is `0.18.0`** (cut 2026-05-05) — stable architecture for new consumers (`npm i @slowcook-ai/cli`). The `alpha` dist-tag is the live development line — currently `0.19.0-alpha.41` with the funds-warning track + refine Pass B brownfield-answer + sc#82 shape-aware track. Opt in with `npm i @slowcook-ai/cli@alpha`. Pin exact versions in `.brewing/slowcook-cli-version` for reproducibility.

**Active plan**: [`docs/plans/0.16-mock-app.md`](./docs/plans/0.16-mock-app.md) — canonical architecture reference for the singular-mock-app + element-anchored-review pipeline. Detailed initial design is in [`docs/DESIGN.md`](./docs/DESIGN.md). Recent history: [`docs/plans/0.15-plate-brew.md`](./docs/plans/0.15-plate-brew.md) (**abandoned** mid-cut — the data-layer-seam approach mixed mock data into `src/`, which broke separation; lessons informed 0.16) → [`docs/plans/0.14-mockup-first-refinement.md`](./docs/plans/0.14-mockup-first-refinement.md) (α.1–α.6 shipped) → [`docs/plans/0.13-bug-flow-and-chef.md`](./docs/plans/0.13-bug-flow-and-chef.md). The 0.7→0.11 roadmap (closed) is at [`docs/plans/roadmap-0.7-to-0.11.md`](./docs/plans/roadmap-0.7-to-0.11.md).

## What makes slowcook distinctive

Two pieces of the architecture deserve callouts — they're what turn slowcook from "yet another agentic harness" into a genuinely PM-friendly pipeline.

### The mock app — design contract you can click

Every project gets a singular `mock/` Next.js app, totally separate from `src/`. Vibe + plate write into it; the PM reviews it as a real running app on a preview URL (`slowcook preview deploy --pr N` ships it via SSH/Docker to the consumer's box). Scenarios in `mock/scenarios/` flip between user states (signed-in, visitor, owner-with-N-pins, etc.) so the PM can see every state without seed data dances. The mock IS the design contract — when the PM clicks "approve" on a mockup PR, brew is bound to ship the same shape into prod.

This means **PM review happens on real interactive UI, not on mockups in Figma + handoff diagrams.** The mock is real React. Every scenario is a real render.

![Mock app scenario picker — story-017 card with `✓ APPROVED` pill and 5-comment badge cluster (5 total / 2 applied / 2 unresolved / 1 spec-altering), aggregated live from the mockup PR.](./docs/screenshots/scenario-picker.png)

### The review overlay — figma-style annotation, on real components

`@slowcook-ai/review-overlay` ships as a floating pill on every mock app render. Three modes — Nav (browse), Comment (Figma-style anchored pins on any DOM element), Approve (one-click sign-off that labels the PR + posts an audit comment). The overlay's selector cascade (`#id` > `[data-testid]` > `role+name` > tag.classes > XPath) means comments anchor to the EXACT element even after surrounding code changes. The PM's comments + status (applied / unresolved / spec-altering) round-trip via the PR conversation so plate can amend without losing context.

Status counts per scenario render directly on the picker page (`useScenarioCommentStats`) — the PM knows at a glance which scenarios have unresolved feedback before clicking through.

![Anchored pin popover on a rendered scenario — overlay payload + plate's reply with the `touched:` file list, GitHub deep-links to both. Floating pill bottom-center: `💬 + ✓ Approved + 5` comment badge.](./docs/screenshots/pin-popover.png)

![Comments-list panel — all 5 comments grouped by status glyph (✓ applied / ⊘ noop / ⚠ spec-altering / ● unresolved), each anchor-resolved or marked `DRIFTED` when the selector no longer matches current DOM.](./docs/screenshots/comments-panel.png)

### The slowcook logo

<img src="./docs/screenshots/logo.png" alt="Slowcook logo — coral pot with three rising steam squiggles on a soft pink ground" width="120" />

Slow-cook pot with steam, rendered inline as SVG so it ships in the overlay package without binary assets — visible on the floating pill in any mock app dev-loop.

---

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

No active plan doc post-0.19.0 — next-cut planning will land as `docs/plans/0.20-*.md` when scoped. Historical plans (shipped or superseded) live in `docs/plans/`; see [`CHANGELOG.md`](./CHANGELOG.md) for the chronological record.

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
| 0.10 | `@slowcook-ai/recorder` (R&R fixture format) + `@slowcook-ai/gates@0.10.0` (Gate package) + tier-2 infra live on a consumer | ✅ shipped |
| 0.11 | Textual proposals (schema/ui_layout/routes/auth/perf/observability/infra/api_shape) + Mermaid in PR body + `/refine` resubmit + brew reading proposals + spec-body-synth backstop + first end-to-end clean ship (dogfood PR #114, $1.92) | ✅ shipped |
| 0.12.x | Phase 2 brownfield-retrieval (code-map line+callers, per-target slice, `.brewing/patterns/`) + testgen prevention checks (page-link, schema-presence) + cost-marker fixes (restaurant-bill rollup) | ✅ shipped |
| 0.13.0 | Bug-flow + chef orchestrator: parallel `investigate → recipe --regression → sift` pipeline; `chef` watches all PRs and classifies failures; `testgen` renamed to `recipe` for kitchen-metaphor consistency | ✅ shipped (cut 2026-04-25) |
| 0.13.2–0.13.6 | Brownfield extraction foundation: `slowcook map --emit-schema` (Supabase migrations → Mermaid ERD), `--emit-tokens` (CSS `:root` + `@theme` → tokens catalog), top-level `slowcook extract` command, refine reads both via `buildProjectContext`, refine + investigate workflow templates auto-run extraction | ✅ shipped |
| 0.14.0-α.1–α.6 | Mockup-first prereqs: data-layer seam (`<domain>.mock.ts` + `@slowcook-stub` marker), `proposals.fixtures.by_domain` schema in `core@0.12.0`, V7 hard-signal synthesizer backstops, spec-emit content validator. Six bugs caught + fixed during V6 end-to-end validation against a consumer. | ✅ shipped (cut 2026-04-26) |
| 0.14.0-α.7+ | Original plan: refine emits `src/**/page.tsx` directly + preview URL + vision-capable amendment | ⛔ superseded by 0.15 |
| 0.15 | First take on the `vibe + plate + recipe + brew` parallel-converge pipeline. Started shipping (vibe agent, emit module, data-layer seam in `src/lib/data/<domain>.{mock.ts,ts}`) but mid-cut feedback rejected the approach: mixing mock data into `src/` broke the mock + production filesystem separation. PR #145 closed; lessons folded into 0.16. | ⛔ abandoned mid-cut |
| 0.16 | Singular mock app + element-anchored review overlay + `slowcook port` + `brew --mode plate` reconciliation | ✅ shipped |
| 0.17 | Branding + logo distribution + brownfield-pipeline foundations (history-index, recon, mock-as-design-source) | ✅ shipped |
| 0.18 | Side-effects audit, port mock-runtime rewrites, gh-proxy in `run-mock`, recon false-positive fixes, entity-first foundation, first clean brew on real consumer | ✅ shipped |
| **0.19** | **Knowledge-layer arc + chef-on-brew-halt loop.** Refine NestJS/TypeORM backend grounding (α.61); ten disk-cached auto digests + git-history mining (α.62-α.63); AGENTS.md managed block discoverable by any agent (α.64); `slowcook init` wires the bedrock (α.65); refine dedup (α.66); `slowcook knowledge add` + chef writes back to curated/ (α.67). Full chef-on-brew-halt recovery loop. Navigator scope + hallucination discipline. Chef owns test infrastructure. | ✅ shipped (cut 2026-05-27) |
| 0.20 | TBD. Likely candidates: testgen + vibe wiring to curated/, formal `database_migrations:` spec field, brew auto-emits per-story EVALUATING-STORY-N.md, LLM-aided PR summarization at init | 📋 not yet scoped |

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

Slowcook is co-developed with active dogfood consumer repos that the maintainer keeps private. **Most features and bug fixes in the changelog were motivated by running slowcook against a real consumer and fixing what broke.** Examples: the 0.14.0-alpha.3–α.5 arc caught five distinct synth bugs by re-running new code against real story specs (see `feedback_run_synth_against_real_specs` memory).

When changing anything in `proposals-synth.ts`, `mock-fixtures.ts`, or any `prompts/*.ts`, run it against an actual consumer spec before cutting an alpha — unit tests with synthetic inputs miss real-world prose conventions.

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
cd /path/to/consumer-repo
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

### Validation against a consumer

A live consumer repo's CI is the real integration test. Every behaviour change should ride through one of:

- A `/refine` round on an open issue (story-flow validation)
- A `/refine` comment on an open spec PR (amendment validation)
- A merge of a `slowcook-bug-profile` PR (sift / bug-flow validation)
- An issue labeled `bug` (investigate validation)

Live runs cost ~$0.30–$2 per round on Opus, $0.10–$0.50 on Sonnet. Bound the spend with explicit budget caps in the config; the `slowcook · shipped` rollup renders the per-agent breakdown.

## License

MIT — see [LICENSE](./LICENSE).
