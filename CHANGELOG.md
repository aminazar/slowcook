# slowcook — CHANGELOG

All releases of `@slowcook-ai/cli` and workspace siblings (`@slowcook-ai/core`, `@slowcook-ai/stack-ts`, `@slowcook-ai/forge-github`). Packages version together unless noted.

Semantic-ish: 0.6.x is additive + bug-fix; 0.7.0 is the first behavioural-breaking line (testgen tier-1 redesign). Consumers adopting a new version should read the entry and bump `.brewing/slowcook-cli-version`.

---

## 0.7.6 — Re-publish 0.7.4 + 0.7.5 with correct dist/ (fixes stale-build release)

**Process bug fix.** 0.7.4 (forge-github workflow templates `slowcook-tests-merged.yml` + `slowcook-brew-merged.yml`) and 0.7.5 (cli Phase A init integration for the UI testing helpers) were both published with **stale `dist/` folders** — the `src/` was correct, versions bumped, but I forgot to run `pnpm build` before publish. Result: both packages made it to npm with the previous version's compiled output.

Effect on consumers:
- **`forge-github@0.7.4`** published with 0.7.3's `dist/`. Fresh `slowcook init` did NOT emit the two new merge-audit workflows. Rewo was spared because PR #53 hand-copied the files; other consumers would have missed them.
- **`cli@0.7.5`** published with 0.7.4's `dist/`. Fresh `slowcook init` did NOT emit the Phase A UI testing helpers. Nobody adopted yet so impact was zero.

**Fix:**
- Both packages rebuilt and republished as `0.7.6`.
- `stack-ts@0.7.5` was published correctly (I did `pnpm --filter @slowcook-ai/stack-ts build` that session); unchanged. `core@0.7.1` unchanged.
- No code or API changes — pure repackage.

**Discipline lesson (documented in a new memory):** when version-bumping in a TypeScript workspace that publishes from `dist/`, `pnpm build` is mandatory before `pnpm publish`. Typecheck + test pass against `src/` but publish packages `dist/`. Fix-forward plan: add a `prepublishOnly` script to each package's `package.json` that runs `pnpm build` automatically so this can't happen again.

## 0.7.5 — Tier-1 UI testing helpers (Phase A: scaffolding)

Phase A of the 0.7.5 bundle per [`docs/plans/0.7.5-tier-1-ui.md`](docs/plans/0.7.5-tier-1-ui.md). Ships the consumer-side infrastructure that tier-1 UI tests will depend on, ahead of the testgen + brew changes (Phase B + C) that make agents emit and produce UI code.

**New in `@slowcook-ai/stack-ts`:**

- `getTsUiTestingHelpers()` — returns three helper files emitted by `slowcook init`:
  - `tests/helpers/render.tsx` — `renderWithProviders(ui, options?)` wraps `@testing-library/react`'s `render` with a mock Next.js router provider. Tests override the router via `options.router` to observe navigation calls.
  - `tests/helpers/mocks/fetch.ts` — `mockFetch(config)` returns a `vi.fn` matching URL patterns to canned responses with call-recording; `realShapedFetch(client)` is the signature-asserting wrapper analogous to `realShapedCreateClient` — throws if handler code calls fetch with a wrong-shaped first arg.
  - `tests/helpers/a11y.ts` — re-exports `jest-axe`'s `axe` + wires `toHaveNoViolations` as a global vitest matcher via `expect.extend`. TypeScript declaration-merging makes the matcher type-check without per-test `///<reference>` directives.
- `getTsUiDevDependencies()` — advisory list of npm packages the helpers import from: `@testing-library/react ^16.0.0`, `@testing-library/jest-dom ^6.0.0`, `jest-axe ^9.0.0`, `@types/jest-axe ^3.5.0`. Surfaced by init as post-run instructions since slowcook doesn't modify consumer `package.json` directly.

**New in `@slowcook-ai/cli`:**

- `slowcook init` now emits the three helper files alongside existing artifacts. Each helper has a `// @slowcook-one-time-scaffold` marker on line 1 — consumer customisations are preserved on subsequent runs unless `--force` is passed.
- Post-init output adds a "UI testing (tier-1, 0.7.5+)" section with the devDependency install command and the `vitest.config.ts` `environmentMatchGlobs` snippet consumers need to add (routing `.tsx` tests to jsdom). Slowcook can't patch `vitest.config.ts` directly — it's consumer-owned, and post-init frozen by stack-ts's frozen-files contribution.

**Version jumps:**

- `@slowcook-ai/stack-ts 0.7.0 → 0.7.5` (new `getTsUiTestingHelpers()` + `getTsUiDevDependencies()` exports)
- `@slowcook-ai/cli 0.7.4 → 0.7.5` (init consumes the new helpers + prints post-run advice)
- `@slowcook-ai/core`, `@slowcook-ai/forge-github` unchanged.

**Adoption:** bump pin to 0.7.5, run `slowcook init` (non-force, safe) — new consumers get the helpers on first init; existing consumers see "create" actions for the three helper files alongside whatever else they have. Then install devDeps per the post-init prompt and add the `environmentMatchGlobs` line to `vitest.config.ts`. Phase B (testgen emission) + Phase C (brew `allowed_paths`) arrive in subsequent 0.7.5 releases — nothing from Phase A changes behaviour until the helpers are imported by an actual UI test.

114 cli tests still green (init plan tests don't assert on specific action counts; resilient to additions).

## 0.7.4 — Audit-trail comments on source issue

Stitches the pipeline into a single readable thread per source issue. Today refine posts comments (overlap / follow-up / clarifications / spec submitted) but after that the issue goes quiet while testgen, brew, and merges happen on separate PRs. This release plugs the three gaps:

**New in CLI:**

- **testgen** now posts an audit-trail comment on each spec's `source_issue` when the tests PR opens: *"tests: PR #N opened (story-M, K tests)."* Best-effort; doesn't fail the testgen run on a bad comment post.
- **brew** now posts on success-PR-open (halt path already posts): *"brew opened (SUCCESS): PR #P — X/Y green, $Z, I iterations."* Only on `success` outcomes; `halted` continues to post the existing halt report.
- **on-spec-merged** now also posts a transition comment alongside the existing label swap: *"spec: PR #N merged — testgen triggers automatically."*
- **on-tests-merged** — **new command**. Mirrors on-spec-merged. Listens for `slowcook-tests` PR merges; resolves each story's source issue via the manifest + spec; posts *"tests: PR #N merged — brew-auto triggers automatically."*
- **on-brew-merged** — **new command**. Final pipeline-transition comment. Infers story-id from the brew branch name, looks up the spec's source_issue, posts the closing *"shipped 🎉"* comment with a summary of the whole trail.

**New in forge-github:**

- `getGitHubCiArtifacts()` now emits two new workflow templates: `slowcook-tests-merged.yml` and `slowcook-brew-merged.yml`. Each fires on `pull_request.closed` gated by the relevant slowcook label and calls the corresponding CLI command. Pairs with the existing `slowcook-spec-merged.yml`.

**Version jumps:**

- `@slowcook-ai/cli 0.7.3 → 0.7.4`
- `@slowcook-ai/forge-github 0.7.3 → 0.7.4` (paired publish for the new workflow templates)

Adoption: bump the pin to 0.7.4, then `slowcook init --force` to regenerate workflows (or hand-add the two new YAMLs from the template output). Existing consumers get the CLI-side comments automatically on the next refine / testgen / brew run.

114 cli tests still green; no schema or behaviour changes for existing flows beyond the added comments.

## 0.7.3 — PR-gate runs the tests

Surfaced by rewo story-006's diagnosis: story-005's 11 tier-1 tests sat red on main for ~24h between its brew-merge and the next story's attempt, undetected. Root cause — the `slowcook checks` workflow does frozen-path guard + manifest verify + code-map check but **never actually runs vitest**. A broken test file passes the PR gate.

**Change:**

- `@slowcook-ai/forge-github` — `getGitHubCiArtifacts()` now emits a final `Run tests` step in `slowcook.yml` that runs `npm test`. Every new consumer initialised after 0.7.3 gets PR-side vitest enforcement by default. Existing consumers adopt by bumping their pin + re-init'ing the workflow (or hand-editing the one-liner in).
- Guidance documented inline in the emitted template: projects that gate heavy tests on an env var (`ACCEPTANCE=1`, `INTEGRATION=1`, etc.) should `describe.skipIf` those so `npm test` stays default-fast in CI and doesn't redline on local-server-required suites.

**Version jumps:**

- `@slowcook-ai/forge-github 0.7.0 → 0.7.3`
- `@slowcook-ai/cli 0.7.2 → 0.7.3` (consumer of forge-github; paired publish)
- `@slowcook-ai/core`, `@slowcook-ai/stack-ts` unchanged.

Existing consumers: bump pin to 0.7.3, then either (a) re-init and let slowcook regenerate `slowcook.yml`, or (b) add the single step manually. rewo is in state (b) — it took the hand-patch directly (see `chore/ci-run-tests`) rather than wait for the publish, to close the gap immediately.

114 cli tests still green. No behavioural changes to brew/refine/testgen/map.

## 0.7.2 — Brew halt diagnostics: full iteration history + fix cost sign bug + rescue run log on zero-checkpoint halts

Surfaced by rewo story-006's first brew run: halted with `ITERATION_CAP` after 10 iters / 0 checkpoints, and the halt report was nearly useless for diagnosis — only the last 3 iter diffs survived, and the spend was reported as **negative** ($-1.89). Without per-iteration data for iters 1–7, and with the rolling run log lost (it's only pushed to the brew branch on checkpoint), there was no way to see *what the agent tried and why each edit failed*.

**Fixes:**

- **Cost sign bug in `costUsdForResponse`** — the effective-input formula was subtracting `cache_read_input_tokens` and `cache_creation_input_tokens` from `input_tokens` on the (wrong) assumption they were a subset. They're separate counters; the API already reports `input_tokens` as new-input-only. When cache tokens dominated, effective input went negative → spend reported negative. Removed the subtraction.
- **Halt report now includes ALL iteration diffs** (`iteration_diffs` field), replacing the old `last_three_diffs`. `IterationDiff` carries `target_test_id`, `files_touched` (list), `note`, `broken_tests` (for regressions), `spend_delta_usd`, and optional `rationale` per iteration. No data loss on halts with >3 iters.
- **Regressions surface broken-test names in the markdown comment** — `iter 4: reverted-regression — 1f/+23/-5 — broke: story-005/handle-auto-assignment, story-003/unverified-can-post (+3 more)`. Makes cross-story assertion clashes obvious at a glance without downloading the JSON.
- **Smart pagination in the markdown renderer** — halts with ≤15 iters render in full; longer halts show first 5 + last 5 with a gap marker citing the JSON for the rest. The full list is always in the JSON artifact.
- **Run log rescued to halts/ dir** — on halt, the rolling `.brewing/runs/<ts>/iterations.log` is copied to `.brewing/halts/story-<id>-<ts>.log`, which means CI's halt-artifact upload (`path: .brewing/halts/`) captures it even when zero checkpoints prevented a branch push.
- **Per-iter run-log lines enriched** — revert lines now include the first 3 file paths touched and (for regressions) the first 3 broken test IDs, so `tail -f iterations.log` during a live brew tells you what's happening without downloading the JSON at the end.

**No schema migration needed for consumers** — halt JSON is a private diagnostic artifact; nothing else reads it. The renamed/extended field is additive from the operator's perspective.

**Version jumps:**

- `@slowcook-ai/cli 0.7.1 → 0.7.2`
- No other packages touched (halt types live in CLI).

114 cli tests still green. The next halt on any story — but especially the rewo story-006 re-run — should produce a report where the "why" of each failed iteration is legible.

## 0.7.1 — Refine agent: `follow_up` category + GitHub-native issue references

Surfaced by rewo issue #47, which was (correctly) recognized as touching the same domain as story-005 but (incorrectly) flagged as `overlap` because story-005's `non_goals` listed the fields #47 was requesting. The agent was treating a prior non-goal as evidence of overlap — logically the opposite of what non-goals mean. Non-goals are deliberate deferrals ("this WILL be a story, just not this one"); a later issue that fulfills them is the INTENDED follow-up, not duplication.

**New:**

- Fourth `RelationshipVerdict` kind: `follow_up`. Definition: "this issue fulfills scope an active spec explicitly deferred via `non_goals`." Refinement **does not halt** — the agent posts an informational comment noting the relationship and continues. The resulting spec will cite the predecessor(s) in its `related_specs` field.
- `RELATIONSHIP_ANALYST_SYSTEM` prompt rewritten with a four-case decision tree (goal/non-goal/reversal/none) + four concrete worked examples distinguishing the categories. Key rule pinned: "same surface" alone is NOT overlap — only duplicated or conflicting scope is.
- `followUpCommentBody` — new comment template. No "pause until PM acts" language; no blocking label.
- Verdict schema + type + parser updated across `@slowcook-ai/core` and `@slowcook-ai/cli`.

**Ergonomics:**

- `specRefForProse(spec)` — format a spec reference as `#<source-issue> (story-<id>)` when the source issue is known, falling back to `story-<id>`. GitHub auto-renders `#N` as a hyperlink in comments. Used in overlap/contradiction/follow-up comment bodies. Internal state (YAML, commit messages, slowcook bookkeeping) keeps `story-<id>` — that's the stable canonical identifier.
- All three relationship comment templates now thread `activeSpecs` through so `specRefForProse` can look up each referenced spec's source_issue.

**Version jumps:**

- `@slowcook-ai/core 0.5.0 → 0.7.1` (RelationshipVerdict type extension)
- `@slowcook-ai/cli  0.7.0 → 0.7.1`

Existing consumers: bump pin, no other action. The new category fires only when a prior spec's non-goals invite follow-up scope — existing pipelines unchanged. Rewo issue #47 will re-classify correctly on the next refine run; adding any new comment triggers it.

+5 tests: parseVerdict for follow_up, specRefForProse (three modes), followUpCommentBody shape. 114 cli tests.

## 0.7.0 — Phase 2: testgen auto-generates stubs + helpers

Closes the two remaining manual touchpoints from the story-005 run. Testgen now emits a **bundle** — test file plus any needed route stubs plus any needed mock helpers — instead of just a test file.

- LLM output format is XML-tagged: `<test_file>`, `<stub path="...">`, `<helper path="...">`. Slowcook parses, writes each block, skips files that already exist (for stubs, unless they're still marked `@slowcook-stub` — those are re-generatable).
- Project-context enrichment: `buildProjectContext` now lists existing API routes under `src/app/**` so the LLM knows NOT to stub them, on top of the existing helper listing.
- `TESTGEN_SYSTEM` prompt rewritten with three concrete shape specs (test file, stub file, helper file) + reviewer guidance embedded in each. Helper spec pins the three non-negotiable properties: signature assertion (`realShaped*Wrapper` throwing on wrong args), call recording (`client.calls`), intent-level config.
- PR body gains "Generated stubs" and "Generated helpers" sections with reviewer checks: correct path + signature for stubs, asserting-wrapper present for helpers.
- `shouldWriteStub` — re-runs refresh stubs (detects `@slowcook-stub` marker on line 1) but won't clobber production impl.
- `shouldWriteHelper` — never clobbers an existing helper; operator deletes + re-runs to refresh.
- `parseTestgenBundle` — robust to outer markdown fences + inner per-block TS fences + empty conditional blocks. +7 unit tests.

Net effect for a future fresh story (like the `PATCH /api/profiles/me` issue pending on rewo): issue → refine → spec merged → **testgen now produces test + stub + helper together**, no human hand-authoring → brew → auto-PR. Same "merge one PR, review one PR" shape we unlocked for story-005, minus the manual workarounds.

## 0.7.0 — Phase 1B: stack-agnostic refactor

Mirror of Phase 1 for the stack adapter. `stackJson` (which hardcodes Vitest + TS/npm assumptions) moved from CLI to `@slowcook-ai/stack-ts` as `getTsStackConfig(params)`. `@slowcook-ai/stack-ts` also gains `getTsStackFrozenFiles()` (returns `vitest.config.*`) and `STACK_ID = "typescript"`. CLI imports + composes.

Version jump: `@slowcook-ai/stack-ts 0.6.2 → 0.7.0`. Byte-identical output for TS/Vitest consumers; CLI is now stack-neutral modulo the `frozen-paths.json` composition which is still hardcoded but doesn't reference stack-specific paths today. When Python/Go adapters land they implement their own equivalents.

## 0.7.0 — Phase 1: forge-agnostic refactor (pay the debt)

First phase of the 0.7.0 bundle (per `docs/plans/roadmap-0.7-to-0.11.md`, originally `0.7-roadmap-to-brownfield-cooker.md`). Addresses the tech debt I (the LLM) borrowed across 0.3 → 0.6.14: four GitHub-Actions workflow templates living in `@slowcook-ai/cli` despite slowcook's forge-agnostic pledge. This release moves them to `@slowcook-ai/forge-github` where they belong, so CLI stays neutral and future forges (GitLab, Gitea) can bring their own dialect.

**Package version jumps (breaking in principle; no-op for current consumers):**

- `@slowcook-ai/forge-github@0.5.0 → 0.7.0` — new exports: `getGitHubCiArtifacts({ cliVersion })`, `FORGE_ID`, and the `CiArtifact` type. All four GHA workflow templates (`slowcook.yml`, `slowcook-spec-merged.yml`, `slowcook-testgen.yml`, `slowcook-brew-auto.yml`) now originate here.
- `@slowcook-ai/cli@0.6.14 → 0.7.0` — init now imports from forge-github; the four workflow-emitting functions are deleted from `packages/cli/src/commands/init/templates.ts`. Init's action list is unchanged from a consumer's perspective — same file paths, same contents.

**Not moved (still in CLI or other packages):**

- `preCommitHook` (forge-neutral; about slowcook CLI, not GitHub API).
- `CODEOWNERS` template (cross-forge-ish; revisit later).
- Stack-specific things like `stackJson`, `vitest.config.ts` scaffold — these stay in CLI for now; stack-agnostic refactor is Phase 1B of 0.7.0 (separate commit).

**What's next in the 0.7.0 bundle:**

- Phase 1B — stack-agnostic refactor (`StackAdapter.getInitArtifacts()`).
- Phase 2 — Testgen Phase B2: auto-generate helpers + route stubs.
- Phase 3 — Tier-2 acceptance scaffolding (discovery, workflow, sandbox harness).
- Phase 4 — Recorder + scrubber, fixtures dir convention.
- Phase 5 — R&R swap: tier-1 helpers become fixture-backed.

## 0.6.14 — Pre-commit hook forces code-map freshness

Closes the recurring stale-map PR-CI loop. The 0.6.9 `slowcook map check` gate caught staleness on the PR — but by then the author had already committed, pushed, and was watching CI fail. The fix was always a manual regen + fixup commit. Over 0.6.10-0.6.13 this happened repeatedly.

- `slowcook init` now writes `.githooks/pre-commit`. On every commit that stages src/\*\*.{ts,tsx}, the hook regenerates `.brewing/code-map.{json,md}` and auto-stages the result. Uses the CLI pin from `.brewing/slowcook-cli-version` so local behaviour matches CI. Idempotent; bypass with `--no-verify`.
- Init sets executable bit (0o755) on any file under `.githooks/` on write, so the hook actually runs.
- `.brewing/README.md` grows a "One-time setup per clone" section with the `git config core.hooksPath .githooks` one-liner. Same hint prints in `slowcook init`'s "Next steps" output.
- Adopters: re-run `slowcook init --force` to pick up the hook + README changes, or copy `.githooks/pre-commit` manually from slowcook's template. Then run the `git config` one-liner per clone.

Rewo adopted the hook ahead of this ship in commit `cebc2a8` — proof-of-concept.

## 0.6.13 — Signature-asserting helpers guidance

Surfaced by PR #46 on rewo: the brew agent shipped a handler that called `createClient()` without its required `cookieStore` argument. Tests passed because `mockSupabase` returned the fake client regardless of arguments. Production would have crashed.

- `TESTGEN_SYSTEM` prompt gains a rule preferring `.mockImplementation(signatureAssertingWrapper(helper))` over `.mockReturnValue(helper as never)` when the consumer exposes an asserting wrapper (e.g. rewo's `realShapedCreateClient`). The asserting wrapper throws loudly on wrong invocation; `mockReturnValue` silently ignores.
- Consumers should pair each mock helper with a signature-asserting companion that wraps the real module's function signature. Generated tests reach for it when present; fall back to `mockReturnValue` + `TODO` when not.

No runtime / lint changes — this is a prompt-only nudge. Structural fix (testgen auto-generates the asserting wrappers as first-class output) lands in 0.7.0 Phase B2.

Related rewo commit: `687dfed` on reworthy/app — fixes the immediate bug, adds `realShapedCreateClient` as a companion helper, documents the convention.

## 0.6.12 — Auto-PR after brew + auto-trigger-on-tests-merged template

Shipped the morning after the first real success (story-005 on rewo: 11 tests green, 2 iterations, \$0.04). Closes two loops so the next story won't need any human touch between "tests merged" and "implementation PR up for review."

- **Auto-PR after brew.** \`runBrew\` now opens a draft PR when a brew succeeds, AND when it halts with \`checkpoints_committed > 0\`. Previously the branch was just pushed; operators had to open a PR manually. Now:
  - Success → draft PR titled \`brew ✓ story-NNN: K checkpoint(s) · G/T green · $S\`, labelled \`slowcook-brew\` + \`brew:success\`.
  - Halt-with-progress → draft PR titled \`brew (partial) ...\`, labelled \`brew:partial\`, body includes the halt-report markdown so the operator sees both what landed AND why we stopped.
  - Zero-checkpoint halts → no PR (nothing to review).
  - Forge failure on PR creation is best-effort — logged to the run log, doesn't change the brew's success/halt disposition.
- **New workflow template \`slowcook-brew-auto.yml\`.** Fires on \`pull_request: closed\` when the merged PR carries the \`slowcook-tests\` label. Parses story ids from the PR title and dispatches \`slowcook-brew.yml\` once per story. \`GITHUB_TOKEN\` with \`actions: write\` is enough — \`workflow_dispatch\` is an explicit exception to the "GITHUB_TOKEN doesn't chain" rule. Manual dispatch stays available for non-default model/budget.
- \`slowcook init\` now writes \`slowcook-brew-auto.yml\` alongside the other workflow templates. Consumers who want a human gate can delete the file.

Adopters: bump \`.brewing/slowcook-cli-version\` to \`0.6.12\` and either re-run \`slowcook init --force\` to pick up the new workflow, or copy \`slowcook-brew-auto.yml\` from slowcook's init templates manually.

## 0.6.11 — Tier-1 lint relaxed for module-boundary injection + prompt with concrete pattern

Two consecutive testgen runs on rewo story-005 failed because the tier-1 lint banned `vi.mock(` outright — but vitest has no other way to replace a module, so the LLM had no valid path and kept emitting the forbidden inline-factory form. The lint was catching the right anti-pattern (**inline fake construction**) via the wrong mechanism (**banning the only injection primitive**).

Fix:

- Lint now distinguishes the two forms. Rejects `vi.mock("path", () => ({...}))` (factory, where inline fakes live). Permits `vi.mock("path")` (auto-mock, the shortest path to module replacement). Same goes for test files: `vi.mocked(...)` is a type-only assertion and fine; `vi.fn(...)` in a test file is still banned (helpers own fake-function construction).
- Testgen system prompt gains a complete copy-this-shape example showing the intended pattern: `vi.mock("path")` at top, `beforeEach(resetMocks)`, `vi.mocked(createClient).mockReturnValue(mockSupabase({...}))` inside each test. Explicit callout that the 2-arg factory form is the trap.

No changes to the helper side of the contract — `tests/helpers/mocks/*.ts` is still where fake-function construction is allowed to live.

+1 lint test (the ALLOWED auto-mock pattern); +1 adjusted (the 2-arg factory form is still rejected, under the new label).

## 0.6.10 — `map check` ignores metadata drift

Hotfix on top of 0.6.9. The `mapsEqual` helper used by `slowcook map check` only excluded the `generated_at` timestamp — but NOT `slowcook_version`. So bumping the CLI version alone (e.g., `.brewing/slowcook-cli-version` 0.6.8 → 0.6.9) was enough to make the next PR fail with `Map is stale` — wrong signal, since no source actually changed. Surfaced immediately in rewo's first real spec PR under the 0.6.9 pin pattern.

Fix: `mapsEqual` now compares only the scanned entities (api_routes, pages, components, helpers, types). All metadata (`generated_at`, `slowcook_version`, `repo_root`, `schema_version`) is ignored.

Effect for consumers: no action needed. A map committed under 0.6.8 remains valid under 0.6.9+ without regeneration. Bump `.brewing/slowcook-cli-version` to `0.6.10` to pick up the fix.

## 0.6.9 — Single-source-of-truth pin + map-check in CI templates

Adopters: update `.brewing/slowcook-cli-version` to `0.6.9`. If you're on an older init (≤0.6.1), re-run `slowcook init --force` to pick up the new workflow templates; otherwise manually adopt the `Resolve slowcook CLI pin` step in each workflow and remove the top-level `env: SLOWCOOK_CLI: ...` block.

- `slowcook init` now writes `.brewing/slowcook-cli-version` — a single-line file holding the version pin. Every generated workflow reads it at run time via an `actions/checkout@v4`-follow-up step (`echo SLOWCOOK_CLI=@slowcook-ai/cli@$(cat .brewing/slowcook-cli-version ...) >> $GITHUB_ENV`). Bumping slowcook is now a one-file edit regardless of how many workflows a consumer has. Fixes the drift we observed where `slowcook.yml` pinned 0.6.1 while `slowcook-brew.yml` pinned 0.6.3 — two workflows running against incompatible versions with no gate catching it.
- `slowcook init`'s `slowcook.yml` template now runs `npx slowcook map check` on every PR. If a contributor edits `src/` and forgets to regenerate `.brewing/code-map.{json,md}`, CI fails red with a clear "run `slowcook map generate`" message.
- Existing consumers (already scaffolded by older init versions) need to adopt both manually; rewo's commit is a worked example (see `e9c4192` in reworthy/app).

## 0.6.8 — Code map

- `slowcook map generate` — ts-morph scanner writes `.brewing/code-map.{json,md}`: API routes (Next.js App Router), pages, React components, helpers (src/lib, src/utils), and types. JSDoc, signatures, imports, file paths all surfaced.
- `slowcook map check` — fail-if-stale gate for CI.
- Brewing automatically regenerates the map at brew start + after every checkpoint. System prompt tells the agent to read it first, replacing many exploratory `read_file` calls per iteration.
- New dep: `ts-morph@^24`.

## 0.6.7 — Brew focus tools + Sonnet 4.6 default

- New brewing tool `find_handler({method, path})` — deterministic API spec → `src/app/.../route.ts :: <method>` mapping (Next.js App Router).
- New brewing tool `outline_file(path)` — regex-based ~200-token outline (imports + top-level signatures + line numbers) vs ~5k for full `read_file`.
- System prompt adds explicit cheap-first exploration order: find_handler → outline_file → read_file → write_file.
- Default model flipped `claude-opus-4-7` → `claude-sonnet-4-6` for brew. ~5× cheaper per iteration with comparable tool-use quality. `--model claude-opus-4-7` still available for opt-in.
- Pricing table in `agent.ts` now tracks sonnet-4-6 for spend accuracy.

## 0.6.6 — Phase B1 of tier-1 testgen redesign

- `TESTGEN_SYSTEM` prompt rewritten: generated tests import route handlers directly and call project helper functions (`mockSupabase(...)`) — never inline `vi.mock` or `vi.fn`. Tests run in-process, construct `Request` objects, assert on `Response`. No HTTP loopback.
- New `lintTierOneTest(source)` — mechanical conformance gate. Halts testgen if the LLM slipped back to tier-0 habits (inline `vi.mock`, `fetch(`, `test.skip`, HTTP-mock library imports). Uses sanitised-source scanning so banned patterns inside comments or string literals don't trip it.
- `buildProjectContext` enumerates existing helpers in `tests/helpers/mocks/*.ts` so the LLM knows which to import.
- Phase B2 (helper + stub auto-generation) deferred to 0.7.0.

## 0.6.5 — Phase A of tier-1 testgen redesign

- Testgen reads `.brewing/context.md` (same as refine). `readContextMd` promoted to shared export.
- Refine prompt gains handler-call-level-invariant guidance with six concrete examples (3 good / 3 to avoid). Steers PMs away from acceptance-only invariants that brewing can't verify.

## 0.6.4 — Operator visibility

- `.brewing/runs/<ts>/iterations.log` — per-iteration rolling log (BASELINE, ITER START, REVERT regression, REVERT no-progress, CHECKPOINT, HALT, SUCCESS). Operator can `tail -f` during a long brew without waiting for CI log flush.
- Eager checkpoint push: `commitCheckpoint` pushes the brew branch immediately after each green-gain commit, not just at the end. Progress visible on GitHub in real time.

## 0.6.3 — `API_ERROR` halt reason

- `runBrew` now wraps the iteration loop in try/catch. Uncaught external-call errors (Anthropic SDK, forge) become a proper halt report with reason `API_ERROR` instead of crashing with exit 2 and no artifact.
- Surfaced by the 2026-04-21 rewo story-001 run where a credit-balance 400 from Anthropic crashed the CLI with no halt report.

## 0.6.2 — path normalisation

- `stack-ts` 0.6.2: `parseVitestJson` uses `path.relative(cwd, file)` as primary normaliser, falls back to anchor regex only when cwd is absent. Fixes the `app/app/tests/...` regression on GitHub-Actions self-hosted runners under `/home/runner/.../_work/app/app/...`, which caused false `MANIFEST_DRIFT` halts.

## 0.6.1 — MANIFEST_DRIFT halt reason

- Before: if a story's tests weren't discovered at all, brew declared success (empty red set = "all green"). Now halts with `MANIFEST_DRIFT` pre-baseline if the manifest lists tests vitest didn't discover. Diagnostic names the most common cause: vitest.config.ts `include` pattern missing the test file's directory.

## 0.6.0 — `brew` command

- Ratcheted implementation loop. Given a story, iterates with Claude to flip red tests to green. On every turn: agent writes a diff, slowcook runs tests, reverts regressions and no-progress turns, commits only on green-gain. Halts with a structured report on budget/iteration/stagnation/wall-clock/test-runner/violation-streak/api-error. Full halt reports in `.brewing/halts/story-<id>-<ts>.json`.
- New deps: `@anthropic-ai/sdk`, prompt caching enabled.
