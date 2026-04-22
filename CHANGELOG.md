# slowcook — CHANGELOG

All releases of `@slowcook-ai/cli` and workspace siblings (`@slowcook-ai/core`, `@slowcook-ai/stack-ts`, `@slowcook-ai/forge-github`). Packages version together unless noted.

Semantic-ish: 0.6.x is additive + bug-fix; 0.7.0 is the first behavioural-breaking line (testgen tier-1 redesign). Consumers adopting a new version should read the entry and bump `.brewing/slowcook-cli-version`.

---

## 0.7.0 — Phase 1: forge-agnostic refactor (pay the debt)

First phase of the 0.7.0 bundle (per `docs/plans/0.7-roadmap-to-brownfield-cooker.md`). Addresses the tech debt I (the LLM) borrowed across 0.3 → 0.6.14: four GitHub-Actions workflow templates living in `@slowcook-ai/cli` despite slowcook's forge-agnostic pledge. This release moves them to `@slowcook-ai/forge-github` where they belong, so CLI stays neutral and future forges (GitLab, Gitea) can bring their own dialect.

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
