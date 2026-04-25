# 0.7 → 0.11 plan: forge/stack refactor → UI coverage → gates via GitHub → R&R → brownfield cooker

> **Historical (closed).** Everything in this roadmap is shipped. 0.12.x finished the brownfield-retrieval phase that started here as 0.11. The active roadmap is now [`0.13-bug-flow-and-chef.md`](./0.13-bug-flow-and-chef.md) (in flight) followed by [`0.14-mockup-first-refinement.md`](./0.14-mockup-first-refinement.md). This doc is kept for the audit trail of how 0.7→0.12 was sequenced; don't re-edit it for new work.

> **2026-04-23 reconciliation note.** An earlier version of this doc (covering 0.7 → 0.10) silently dropped four pieces from the original `docs/DESIGN.md` §7 design: **Gate 1 mechanical UI** + **Gate 2 AI vision** (numbered 0.9 in DESIGN.md), **HITL review** (dashboard, numbered 1.0 in DESIGN.md), and the **screenshot capture + MinIO storage** that underpin Gates 2/3. The regression was caught when rewo story-006 shipped as "green tests, no UI" — exactly the failure mode the gates were designed to prevent. This version reinstates the gates and the HITL flow, but **descopes the standalone dashboard package**: the only feature that genuinely required a custom UI (inline screenshot annotation) gets offloaded to whatever annotation tool the PM already uses. Slowcook's responsibility ends at "post screenshot in a PR comment + parse the PM's reply." Everything else the dashboard was going to provide (halt intervention, spend monitor, audit log, refinement feedback) maps cleanly to GitHub-native primitives (issue comments, PR reviews, scheduled workflows, git history). Also adds two pieces that were never explicitly on any roadmap: per-issue audit-trail comments (0.7.4) and tier-1 UI component tests (0.7.5). R&R and brownfield cooker move out to 0.10 and 0.11 accordingly.
>
> **Ownership note.** The forge-specific CI-workflow templates in `packages/cli/src/commands/init/templates.ts` were technical debt I (the LLM) borrowed across 0.3 → 0.6.12. Slowcook's design pledge is forge-agnostic + stack-agnostic at the CLI layer, with adapters owning dialect-specific code. I kept inlining GitHub Actions YAML in the CLI because each addition looked like a small local choice; cumulatively it was six templates living in the wrong package. 0.7 paid that back as its first line item, landed and shipped on npm as `cli@0.7.0` / `forge-github@0.7.0`.

This plan now covers: shipped fixes (0.6.13, 0.7.0, 0.7.1, 0.7.2, 0.7.3); in-flight small items (0.7.4 audit-trail, 0.7.5 tier-1 UI); tier-2 acceptance + screenshots (0.8); gates 1/2/3 via GitHub comments (0.9); R&R (0.10); brownfield cooker (0.11). Scope is sequenced — each version depends on the prior landing.

---

## Immediate — 0.6.13 (this session or next): mock-drift hotfixes

Motivated by PR #46 on rewo, where the brew agent shipped a handler that called `createClient()` without its required `cookieStore` argument. Tests passed because `mockSupabase` returns the fake client regardless of arguments. Production would crash on the missing arg.

### 0.6.13 scope

1. **rewo patch**: add one line `const cookieStore = await cookies();` + `createClient(cookieStore)` in `src/app/api/members/[handle]/reactions/route.ts`. Not a slowcook change.
2. **slowcook patch — `mockSupabase` assertion mode.** The helper gains an optional `expectSignature` config: if set to `requireCookieStore: true`, the helper throws a loud error when `createClient()` is called without the expected arg shape. Tests for story-005 would fail fast instead of green-lying. Consumer opts in by tightening their helper.
3. **slowcook prompt tweak** in `TESTGEN_SYSTEM`: add a note that helpers SHOULD validate invocation shape against the real module, with a concrete example. Keeps tier-1 tests honest without waiting for tier-2.

Ships as a 0.6.13 patch. No breaking changes; additive. Closes the immediate mock-drift instance while the structural fix (tier-2 + R&R) is still multiple versions out.

---

## 0.7.0 — Forge/stack-agnostic refactor + Testgen Phase B2

Two objectives, done together because they share the same architectural direction: move code to the right package.

### 0.7.0 — A. Forge-agnostic refactor (pay the debt)

**Problem.** `packages/cli/src/commands/init/templates.ts` and `packages/cli/src/commands/init/plan.ts` emit GitHub-Actions YAML directly. Consumer forges (GitLab, Gitea, Bitbucket, or self-hosted) can't use slowcook today without handwriting their own CI wiring.

**Shape.**

- `ForgeAdapter` interface (in `@slowcook-ai/core`) gains:
  ```ts
  interface CiArtifact {
    path: string;       // relative to repo root, e.g. ".github/workflows/slowcook.yml"
    contents: string;   // full file contents
    frozen?: boolean;   // if true, added to frozen-paths on init
  }
  interface ForgeAdapter {
    // … existing methods …
    /** All CI workflow / pipeline / config files for this forge. */
    getCiArtifacts(params: { cliVersion: string }): CiArtifact[];
    /** Paths the forge wants frozen beyond the core set. */
    getFrozenPathExtras(): string[];
  }
  ```
- `@slowcook-ai/forge-github` implements `getCiArtifacts()` by returning the six GHA YAMLs currently in CLI. All the `slowcook*.yml` templates move there verbatim.
- CLI's `init` calls `forge.getCiArtifacts()` and writes each. CLI no longer knows what file paths to emit — the forge decides.
- Same pattern for `.gitignore` entries if any become forge-specific.

**Migration.**

- Existing consumers: running `slowcook init --force` regenerates workflows from the new source, same output bytes. No-op unless a consumer hand-edited a template (in which case they see an overwrite prompt, same as today).
- GitLab adapter (future) implements its own `getCiArtifacts()` returning `.gitlab-ci.yml`.
- Tests: extract current workflow-template snapshot tests into forge-github's test suite.

**Why now.** Every extra 0.6.x patch added more GHA YAML in the wrong place. The 0.6.12 `slowcook-brew-auto.yml` addition is the sixth template living in CLI. Unblocking non-GitHub consumers is the reason slowcook exists; we owe the refactor before it compounds further.

### 0.7.0 — B. Stack-agnostic refactor (parallel cleanup)

Similar debt for `stack.json`, `frozen-paths.json`'s default directories, and the init template's assumption of Vitest.

**Shape.**

- `StackAdapter` interface (in `@slowcook-ai/core`) gains:
  ```ts
  interface StackArtifact {
    path: string;
    contents: string;
  }
  interface StackAdapter {
    // … existing methods …
    getInitArtifacts(params: { hasTestRunner: boolean }): StackArtifact[];
    getDefaultFrozenPaths(): { directories: string[]; files: string[] };
    getDefaultStackConfig(): object; // the JSON body for .brewing/stack.json
  }
  ```
- `@slowcook-ai/stack-ts` implements these — emits `vitest.config.ts` scaffold, typescript-specific frozen paths (`vitest.config.*`), etc.
- CLI's init composes: `forge.getCiArtifacts()` + `stack.getInitArtifacts()` + shared `.brewing/*` core. Nothing stack- or forge-specific remains in CLI.

### 0.7.0 — C. Testgen Phase B2: auto-generate helpers + stubs

Unblocks autonomous operation. Today consumers hand-author helpers (we did `mockSupabase` in rewo) and sometimes stubs (we did the route.ts stub for story-005). Testgen should own both.

**Shape.**

- Testgen scans the real module at `@/utils/supabase/server` before generating, extracts `createClient`'s signature + return type.
- If `tests/helpers/mocks/<service>.ts` doesn't exist, testgen writes it. The generated helper:
  - Types match the real module's exports
  - Validates invocation shape (issue 0.6.13 A above — now structural, not opt-in)
  - Exposes `calls` for assertion
  - Exposes config options named after intent (`user`, `tables`, not `return_value_for_from`)
- If the route file `src/app/.../route.ts` referenced by the test doesn't exist, testgen writes a stub with the `@slowcook-stub` marker (same shape as the story-005 manual stub).
- Both helper AND stub generation is gated by the tier-1 lint — generated files get a conformance check of their own.
- PR body lists every generated helper + stub explicitly. Reviewer knows "this file is an auto-stub; brewing replaces it."

### 0.7.0 — D. "Proper" helpers as a first-class contract

Three properties a proper helper must have (testgen generates, tier-1 lint enforces):

1. **Signature assertion.** Calling the real function with wrong args must throw loudly, not silently return a fake. Catches the createClient/cookieStore bug class at test time.
2. **Call recording.** `client.calls` is the public assertion surface for "did handler call X?" — not `vi.fn().mock.calls` poking through.
3. **Intent-level config.** Tests supply what matters (user present, tables populated); helper maps that to whatever vitest primitives are under the hood. When R&R lands, internals switch without helper signature changing.

0.7.0 DoD includes unit tests in `stack-ts` that synthesize a helper for a toy module and prove all three properties hold.

### 0.7.0 sequencing inside the version

```
A. Forge-agnostic refactor       — prerequisite for B2's PR body emission & all below
B. Stack-agnostic refactor       — parallel; merges with A
C. Testgen Phase B2              — builds on cleaned-up adapter interfaces
D. Proper helpers contract       — tests in stack-ts verify B2's output
```

Ship as 0.7.0 once A-D land. Adopters: `slowcook init --force` + bump pin. Existing consumers' workflows regenerate with unchanged bytes (A was a move, not a rewrite).

---

## 0.7.4 — Audit-trail comments on source issue

Motivated by the rewo story-006 cycle: refine posts comments throughout (overlap / follow-up / clarifying questions / "spec submitted"), but testgen is silent when it opens the tests PR, brew is silent on success (only posts on halt), and the `spec-merged` / `tests-merged` transitions just swap labels without a comment. Result: the source issue has a partial audit trail that stops halfway through the pipeline.

### 0.7.4 scope

- **testgen** posts one issue comment on tests-PR-open: *"tests: PR #N opened (story-M, K tests)."*
- **brew** posts one issue comment on brew-PR-open success: *"brew: PR #P opened (story-M, X/Y tests green, $Z, I iterations)."* (Halt comments already exist since 0.6.)
- **on-spec-merged** and a new **on-tests-merged** workflow each post a transition comment: *"spec: PR #N merged, testgen triggered"* / *"tests: PR #N merged, brew-auto triggered."*
- **on-brew-merged** posts the final closing comment: *"brew: PR #P merged. Story-M shipped."*

No UI, no dashboard — just GitHub comments stitching the pipeline into a single readable thread per issue.

### 0.7.4 DoD

- Source issues tell a full story end-to-end without having to click out to Actions tab or PR list.
- Comments are dedup-safe: re-running testgen on a story with an already-open tests PR updates the existing comment rather than piling up duplicates.

---

## 0.7.5 — Tier-1 UI component tests

The biggest missing piece from both DESIGN.md and the prior roadmap: brew only produces code the tests drive it to produce. Today's tier-1 tests cover API handlers via direct import + `vi.mock` of external services. **Nothing drives the agent to write React components.** Story-006 shipped as "16 tier-1 tests green, no UI" — exactly because no UI test existed to turn red→green.

### 0.7.5 scope

- **Testgen emits component tests** when `ui_behavior` exists in the spec. Shape: `tests/integration/story-N-ui.test.tsx` importing the page or component, using `@testing-library/react` + `jsdom` (Vitest's default env for `.tsx`). Asserts on rendered output, state transitions, event handling, conditional rendering.
- **Brew `allowed_paths` extension.** Adds `src/components/**` and client-side `src/app/**/*.tsx` to the brewable set. Stays minimal-diff via the existing graduality caps.
- **UI helpers** analogous to `mockSupabase`: a shared render helper that sets up a reasonable default (router, query client, auth state) and a `mockFetch` helper with the same signature-asserting pattern (`realShapedFetch`) for handlers the component calls.
- **Stub generation extension.** For each UI story, testgen emits a component stub (`export default function PlaceholderComponent() { throw new Error('@slowcook-stub'); }`) alongside the test file so the test collects.
- **Testgen prompt** gets a UI-shape spec similar to the tier-1 handler shape — render, fire events, assert on DOM.
- **Accessibility built in.** `jest-axe` runs against every rendered component in the tier-1 UI suite. Catches contrast, ARIA, heading-hierarchy, label-for-input mismatches at PR time, before acceptance ever spins up. Low cost, high leverage — a11y bugs compound if not caught early.

### 0.7.5 — What tier-1 UI actually covers (not "does the component exist")

With jsdom + Testing Library + `jest-axe`, tier-1 UI covers most of `ui_behavior`'s substance cheaply (<1s/test). Examples, each a realistic test for rewo story-006's profile-edit form:

| Category | Example assertion |
|---|---|
| **Conditional rendering** | "warning banner renders when `handle_confirmed=false`" |
| **State-machine behavior** | "typing in handle field triggers debounced `/api/profiles/handle-available` call at 300ms" |
| **Event → state** | "clicking Save calls `PATCH /api/profiles/me` with the current form state" |
| **Form-validation UI** | "bio counter turns red at 161 chars; Save button disables" |
| **Accessibility** | "no axe violations (contrast, ARIA, heading hierarchy, label-for)" |
| **Semantic structure** | "emoji picker opens as a dialog with the right ARIA role" |
| **Error states** | "shows 'handle taken' error when API returns 409" |
| **Loading states** | "shows spinner while availability check is in-flight" |
| **Routing intent** | "clicking Cancel calls `router.push('/profile')`" |

What tier-1 UI **can't** check — deferred to acceptance + screenshots + gates:
- Real CSS layout (jsdom's layout engine is approximate; flex/grid compute differently).
- Pixel-level: centering, spacing, actual color values.
- Tap-target sizes ≥44px (needs real layout).
- Viewport behavior (mobile-dark vs desktop-light — jsdom has no viewports).
- Animation smoothness, sheet-transition behavior.
- Brand / aesthetic taste calls.

**Tier-1 UI catches the functional substance of `ui_behavior`; tier-2 + Gates 1/2/3 catch the visual substance and the real-sandbox substance.** Most UI regressions are functional, so tier-1 UI is where the bulk of the coverage lives — cheap to run on every PR.

### 0.7.5 — Interaction with context.md

`.brewing/context.md` needs a new subsection documenting the UI test conventions: which render helper, what to mock, how to assert. Rewo's `context.md` (post-PR #52) documents tier-1 handler conventions; extend it to UI.

### 0.7.5 DoD

- A refreshed testgen run on rewo story-006 emits `story-006-ui.test.tsx` with component tests alongside the handler tests.
- A subsequent brew run on a new UI-only story produces a working component + form + save flow — green end-to-end.
- The UI helpers pattern is symmetric with the handler helpers: intent-level config, signature-asserting wrapper, calls-recorded.

---

## 0.8.0 — Tier-2 acceptance runner + recorder + screenshot capture

Adds the structural backstop against mock drift that 0.6.13's opt-in assertions only partially cover. Also lays the recorder that 0.9's record-and-replay depends on.

### 0.8.0 scope

- **Discovery.** `stack-ts.discover.ts` extended to know about `tests/acceptance/`. Default vitest include pattern unchanged; acceptance runs via a distinct command gated by `ACCEPTANCE=1`.
- **Runner harness — new stack-adapter responsibility.** `stack-ts` (or a future stack-acceptance adapter) knows how to spawn the real sandbox for the consumer: `supabase start` for the Supabase stack, `next dev` for Next.js. Pluggable so other stacks can opt in.
- **`slowcook-acceptance.yml` workflow template.** Lives in `@slowcook-ai/forge-github` (thanks to 0.7's refactor). Runs **on every brew PR (pre-merge gate) + nightly against main**. Installs the stack sandbox, runs `ACCEPTANCE=1 npx vitest tests/acceptance`, drives Playwright for UI stories, uploads captured fixtures and screenshots as artifact. Why per-PR: acceptance's job is real-sandbox mock-drift detection — if it's only nightly, drift ships to main before being caught. Cost per run is minutes (sandbox spin-up + Playwright); acceptable for the safety net it provides.
- **Recorder.** Wrapper around external-service clients that intercepts every request → response pair. Shape of output: `tests/fixtures/<story-id>/<service>/<request-hash>.json`. Hash is stable across request body reorderings. Generated fixtures are committable alongside tests.
- **Scrubber.** Pre-write pass that replaces volatile fields with placeholders per a service-specific config in the stack adapter. Defaults are loud: scrub every UUID/email/bearer/timestamp unless allow-listed. CI refuses to accept a PR where a fixture contains a pattern matching `[a-f0-9]{8}-[a-f0-9]{4}-...` etc. without a placeholder.
- **Staleness gate.** New CLI command `slowcook fixtures check`, added to the CI workflow. Fails PR if the newest fixture under `tests/fixtures/<story-id>/` is older than `N` days (default 14), unless a `@fixtures-frozen <reason>` marker is present in the story's spec. Forces periodic re-record to surface drift.
- **Screenshot capture + storage (new in the reconciled roadmap; was DESIGN.md 0.9).** Playwright captures screenshots per `(viewport × color-scheme)` during acceptance runs. Viewports = desktop-light, mobile-light, mobile-dark (matching spec's `ui_behavior` shape). Storage in MinIO (per DESIGN.md §10) keyed by `story-id × commit-sha × viewport × scheme`. These are the inputs Gate 1 + Gate 2 will consume in 0.9. In 0.8 they're captured but not yet graded — the infra lands first.

### 0.8.0 — The chicken-and-egg, again

Tier-2 tests reference real rewos / users / IDs captured during recording. First recording run against a fresh sandbox produces fixtures; subsequent runs validate them. Before any recording, tier-2 tests have nothing to compare against — they run and establish the fixtures.

Testgen for tier-2 is deferred to 0.11 (after the recorder lands; testgen can hit the sandbox first + produce deterministic tests second).

### 0.8.0 DoD

- rewo's story-005 gains a first `tests/acceptance/story-005.spec.ts` — hand-authored for now, testgen auto-generates it in 0.11.
- Nightly workflow runs against a staging Supabase project with a seeded schema.
- Recorded fixtures under `tests/fixtures/story-005/supabase/*.json`.
- Scrubber test suite: any regression that would leak a real bearer token fails loudly.
- Screenshots land in MinIO for at least one viewport × scheme per UI story. Retrievable by `story-id` + `commit-sha` via a typed `ScreenshotStore` interface (consumer-swappable — S3/local/MinIO).

---

## 0.9.0 — Gates 1 + 2 + 3 via GitHub comments (reinstated from DESIGN.md §7, descoped)

Grades the screenshots captured in 0.8. Objective/AI-judgeable checks (Gate 1 + Gate 2) happen automatically; subjective/PM-judgeable checks (Gate 3) happen via GitHub's native PR comment + review mechanism — not a custom dashboard. See the top-of-doc reconciliation note for why the dashboard package was descoped.

### 0.9.0 scope — Gate 1: mechanical UI checks

- **Shape.** Deterministic assertions over the rendered DOM + computed layout, executed as part of the tier-2 acceptance run. Not human-readable prose — actual code.
- **Asserts.** Examples drawn from DESIGN.md: element centering (computed `getBoundingClientRect` vs parent), focus-ring visibility (`outline` style on keyboard focus), text readability (contrast ratio ≥ 4.5:1 per WCAG AA), overflow guards (no horizontal scroll on mobile viewports), tap-target sizes (≥ 44px on mobile).
- **Per-story config.** Specs can declare `ui_mechanical_asserts` in YAML — a list of named asserts to apply to named selectors. Stack adapters ship a default set (`a11y_contrast`, `no_overflow`, `tap_targets`) that apply to every story unless opted out.
- **Failure mode.** Gate 1 failure blocks merge; re-runs brew's review/revise loop. No human intervention needed — it's mechanical.

### 0.9.0 scope — Gate 2: AI vision per viewport × scheme

- **Shape.** For each captured screenshot, Claude vision receives: the image, the spec's `ui_behavior` section, and the acceptance scenario's "When/Then" prose. Returns a structured verdict: `pass` / `fail` with evidence, or `uncertain` with the specific ambiguity. Uncertain escalates to Gate 3 (0.10).
- **Prompt engineering.** Live in `@slowcook-ai/cli` alongside other agent prompts. Vision prompt framed adversarially per DESIGN.md §5 reviewer framing ("what would you flag if this was submitted in review?"). Evidence requirement: vision must cite specific coordinates or elements, not hand-wave.
- **Cost control.** Vision calls are the expensive part of Gate 2 — budget cap per story (~$0.50 of vision spend for a 3-viewport × 2-scheme run). Cache keyed on image hash: re-runs of identical screenshots skip the vision call.
- **Failure mode.** Gate 2 `fail` blocks merge + posts the vision's finding as a PR comment. Gate 2 `uncertain` escalates to Gate 3 (human) as a PR comment asking the PM to approve or request change.

### 0.9.0 scope — Gate 3: HITL via GitHub comments (descoped from the dashboard)

The only dashboard feature that genuinely required a custom UI was inline screenshot annotation. Everything else maps onto GitHub primitives. We offload annotation to the PM's existing tool of choice (Preview.app, Figma, Excalidraw, markup.io, Loom) and focus on the delivery + feedback-parsing protocol.

- **Screenshot delivery.** For each UI story's brew PR, `slowcook-review[bot]` posts one comment per (viewport × scheme) with the screenshot rendered inline. Images are committed to a `slowcook-screenshots/story-N/commit-sha/*.png` side-branch and referenced via `raw.githubusercontent.com` URLs — GitHub renders them in the comment markdown for free.
- **Feedback protocol.** PM replies to the screenshot comment. Two supported shapes:
  - **Prose only** — *"the warning banner is too close to the top edge on mobile; also the save button needs more breathing room below the emoji picker."* Brew's next iteration reads the thread as natural-language guidance context.
  - **Annotated image re-upload** — PM drags an annotated image into the reply (optionally with prose). Next iteration's agent receives both original + annotated versions via Claude vision ("diff these; the annotations mark what the PM wants changed").
- **Review state.** PM uses GitHub's native PR review — "Approve" or "Request changes." Gate 3 reads the review state directly; no custom approval mechanism.
- **Uncertain Gate 2 verdicts** → Gate 3 PR comment: *"vision uncertain about X on mobile-dark — please approve or request change."*
- **`aesthetic-sensitive` label** on an issue forces Gate 3 review even when Gate 2 says pass. Already specced in DESIGN.md §8.1.

**What slowcook does NOT deliver (intentionally):**
- No `@slowcook-ai/dashboard` package.
- No inline annotation UI.
- No custom screenshot-storage backend. The git side-branch + GitHub CDN is enough for 95% of cases. MinIO stays as an optional higher-retention/higher-res backend for projects that want it.

**Other dashboard features → GitHub-native mappings:**
- **Halt intervention** — reply to halt comment with `/slowcook resume <choice>` or custom hint; agent resumes on next iteration. (Already partial: halt comments exist since 0.6.)
- **Large-iteration review** — non-blocking issue comment on over-cap iterations; PM 👍/👎 reaction or prose reply. Cap-calibration logic reads the disposition.
- **Spend monitor** — scheduled workflow runs `slowcook costs` (new CLI command); opens an issue if a story exceeds 2× peer median.
- **Audit log** — already is the git history of `.brewing/*` + the PR-comment trail. Diff-able, searchable, permanent.
- **Refinement feedback channel** — PM replies to refine's comment with corrections ("this isn't a duplicate of story-005; it's a follow-up"); refine reads the thread on next run. Already partial — works today for clarifying-question replies.

### 0.9.0 — What this unlocks

- First autonomous pipeline that can fail a PR for "the button is off-center" or "the warning banner doesn't meet contrast minimums" without a human in the loop.
- PMs review taste-dependent UI changes via GitHub, using their own annotation tool if they want. No new app to learn, no new login, no new surface — everything flows through the same PR thread the code review is already in.
- Brew iterations pick up PM feedback automatically because the comment thread IS the feedback channel.

### 0.9.0 DoD

- rewo story-006's profile form: a regression that hides the `handle_confirmed = false` warning banner is caught by Gate 2 vision against the screenshot, not by a human seeing the bug post-merge.
- A regression that breaks mobile-dark contrast on the save button is caught by Gate 1's contrast-ratio assert.
- Vision failures post PR comments with specific bounding-box evidence, not vague "looks wrong."
- A PM can reply to a Gate 3 screenshot comment with an annotated image + prose, and the next brew iteration picks it up as guidance.

---

## 0.10.0 — Record-and-replay swap

Makes tier-1 helpers self-updating from tier-2's fixtures. Biggest payoff: tier-1 stops being load-bearing fiction. (Was 0.9 in the original roadmap; moved to 0.10 in the reconciliation to make room for gates.)

### 0.10.0 scope

- **Helper internals swap.** `mockSupabase(config)` (the signature tier-1 tests call) no longer builds responses from `config.tables`. Instead, it looks up the captured fixture keyed on the computed request hash. `config.tables` becomes a fallback for requests the tier-2 run didn't cover.
- **Helper regeneration.** `slowcook testgen --refresh-helpers` reads the latest fixtures and rewrites `tests/helpers/mocks/*.ts` so each helper has the up-to-date list of known-good response shapes. Runs on a schedule or manually.
- **Staleness backoff.** If fixtures for a specific request don't exist, helper returns a null-ish response + emits `TODO(tier-2): record /api/.../...`. Tier-1 tests covering those paths start failing red, signaling the operator to run tier-2.
- **Tier-2 testgen.** The refine → testgen pipeline for tier-2: testgen reads the spec, generates `tests/acceptance/story-N.spec.ts` that hits real endpoints against a sandbox. Output is a separate PR from tier-1 testgen (different frozen-paths policy).
- **Contract stability.** Tier-1 tests written in 0.7 work unchanged in 0.10. Helper signatures are the only contract; internals are implementation detail.

### 0.10.0 DoD

- rewo story-005's `mockSupabase` uses captured fixtures by default.
- Any fresh test case that references a request shape without a recorded fixture fails red with a clear `TODO(tier-2)` message.
- Regenerating fixtures via `slowcook fixtures regenerate` (on-demand) produces a PR with only the fixture diffs — reviewer can see drift.

---

## 0.11.0 — Brownfield cooker

The final version of this plan. Slowcook becomes capable of onboarding into a mature existing codebase (not a greenfield rewo-style project where we controlled conventions from day one). (Was 0.10 in the original roadmap; moved to 0.11 in the reconciliation.)

### 0.11.0 scope

- **`slowcook bootstrap` command.** For a brownfield consumer: scans the codebase, produces `.brewing/DISCOVERY.md` — a generated-but-editable anchor doc. Contains:
  - Domain vocabulary extracted from code (entity names, action verbs, frequently-referenced tables)
  - Architectural overview (where APIs live, how auth flows, how data persists)
  - Existing testing conventions (detected test runner, discovery patterns, present mock libs)
  - Known third-party services (from imports + env-var references)
- **`.brewing/DISCOVERY.md` load-path.** Read by refine, testgen, brew agents (same as `.brewing/context.md` today). Refine cross-references DISCOVERY.md when asking clarifying questions — if a new story's terminology matches something in DISCOVERY, agent uses that term rather than inventing vocabulary.
- **Code-map enrichment.** The existing ts-morph scanner in 0.6.8 produced shape. 0.11 adds semantic enrichment: which handlers talk to which tables, which components consume which hooks, call graph within `src/lib/**`. Compute on map-generate; cheap enough to run on every `slowcook map generate`.
- **Brewing prompt additions.** Brew's system prompt gets a "you are working in a brownfield codebase" variant that emphasizes convention-following and conservative refactoring. Toggle driven by presence of `DISCOVERY.md`.
- **Conservative-diff mode.** Default to smaller diff caps (100 lines / 3 files) when operating on brownfield stories — tighter graduality because the cost of a regression is higher in code with unknown integrations.

### 0.11.0 — The prize

A brand-new consumer can run:
```bash
npx slowcook init
npx slowcook bootstrap   # new in 0.11
```

…and have refine/testgen/brew work against their existing codebase without the PM having to hand-author context.md. The LLMs see enough to not re-invent the project's vocabulary on every issue.

### 0.11.0 DoD

- A non-rewo consumer (pick a small OSS project) goes from `slowcook init` to an autonomous brew of a real story inside 60 minutes.
- DISCOVERY.md quality is human-auditable: the PM reads it, says "yes that's basically right" with minor edits.
- Agent's first-round refine questions on the brownfield project are project-specific (not generic "what does 'user' mean here?" questions).

---

## Cross-cutting concerns

Items that span multiple versions; called out so they don't fall between cracks.

### Multi-stack (sketch, probably 0.12+)

- Python adapter (pytest discovery + fastapi/django route detection for `find_handler`)
- Go adapter (go test + net/http mux detection)
- Rust adapter (cargo test + axum detection, maybe)

Each lives in `@slowcook-ai/stack-<lang>`. Core CLI stays agnostic. Model choice per stack: Sonnet-heavy for strongly-typed languages, possibly stronger model for duck-typed.

### Changelog + semver pledge

- Every release gets a CHANGELOG.md entry from 0.6.9 onward (started — keep the discipline).
- Breaking changes require a minor bump (0.X.0, not 0.X.Y).
- Semver discipline: patch releases must not require consumer action beyond bumping the pin file.

### Eval harness (somewhere around 0.8 or 0.9)

- Slowcook needs regression testing of its own. As we ship 0.7-0.11, we'll accumulate failure modes that could regress.
- Shape: a suite of synthetic brownfield projects + canned stories. CI runs the full pipeline end-to-end against each on slowcook PRs.
- Cost: real Anthropic API calls. Budget per slowcook-PR run: ~$1 (Haiku for simple eval stories, Sonnet for complex).
- Value: catches the "our prompt tweak broke the ratchet on simple stories" class of regression that our current test suite can't see.

### Cost observability

- `slowcook costs` command that aggregates `tokens_spent_usd` across `.brewing/halts/` + successful runs (tracked in a new `.brewing/runs/*/summary.json`).
- Weekly cost report in consumer repos, optional.

---

## Proposed order of attack

1. **0.6.13 — shipped.** createClient fix + `expectSignature` on `mockSupabase`.
2. **0.7.0 — shipped.** Forge + stack refactors + Phase B2 testgen + proper-helpers contract.
3. **0.7.1 — shipped.** Refine agent `follow_up` verdict + GitHub-native spec refs.
4. **0.7.2 — shipped.** Brew halt diagnostics: full iteration history, cost sign fix, run log rescued to halts/, broken-tests inline.
5. **0.7.3 — shipped.** `slowcook.yml` template emits a `Run tests` step so broken tests fail the PR that introduces them.
6. **0.7.4 — next.** Audit-trail comments on source issue.
7. **0.7.5 — next.** Tier-1 UI component tests (the missing ratchet-driver for UI).
8. **0.8.0.** Tier-2 acceptance runner + recorder + screenshot capture (MinIO optional).
9. **0.9.0.** Gates 1 + 2 + 3 via GitHub comments (mechanical UI asserts + AI vision + PM review via PR comments/reviews; no dashboard package).
10. **0.10.0.** R&R swap + tier-2 testgen. Fixtures drive tier-1 helpers.
11. **0.11.0.** Brownfield cooker. `slowcook bootstrap`. Adopt a non-rewo consumer end-to-end as validation.

Each version gets its own detailed plan doc when we're ready to implement — this one is the umbrella roadmap, not the detailed design. **Discipline note (2026-04-23):** so far only one detailed plan has been written (`0.7-testgen-two-tier.md`). Future milestones should get one before starting, especially the bigger ones (0.8 acceptance, 0.9 gates).

## Related docs

- [`docs/plans/0.7-testgen-two-tier.md`](0.7-testgen-two-tier.md) — earlier plan covering tier-1 + tier-2 shape. Sections of this roadmap supersede the sequencing in that doc (tier-2 is now 0.8, not part of 0.7).
- [`docs/plans/0.13-bug-flow-and-chef.md`](0.13-bug-flow-and-chef.md) — 0.13.0 plan: parallel bug-fix flow (`investigate` + `recipe --regression` + `sift`), `chef` orchestrator that watches all slowcook-bot PRs and recovers from failures, and the `testgen` → `recipe` rename.
- [`docs/DESIGN.md`](../DESIGN.md) — pipeline overview. §7 is the canonical spec for the gates + HITL flow that 0.9 reinstates into this plan. DESIGN.md's `@slowcook-ai/dashboard` package has been descoped in favour of GitHub-native surfaces; the gates themselves and the HITL review loop are preserved in full. 0.11's brownfield cooker augments §3 (refinement) without changing the pipeline shape.

## Post-0.11 sequencing update (2026-04-25)

Phase 2 brownfield-retrieval shipped in 0.12.7–0.12.12 (signature/caller enrichment, per-target slicing, patterns dir). The next major architectural shift is **0.13.0** — see `0.13-bug-flow-and-chef.md`:

- **Bug-fix flow** as a parallel pipeline. Story flow stays: `refine → recipe → brew`. Bug flow adds: `investigate → recipe --regression → sift`. Same TDD red→green ratchet on both, different agents at each stage tuned for their failure mode.
- **`chef` orchestrator** — watches all slowcook-bot PRs, classifies failures (self-conflict / self-CI-fail / external / infra), rebases / retry-dispatches / escalates. Single point for retry policy + cost gating + (later) PR review + queue management.
- **`testgen` → `recipe` rename** — strengthens the kitchen metaphor (refine, recipe, brew, sift, investigate, chef). `testgen` keeps as a hidden alias through 0.13.x; removed in 0.14.0.

R&R (was 0.10) and brownfield cooker (was 0.11) move further out as 0.12.x retrieval already addressed brownfield's blocking concerns; explicit re-sequencing happens once 0.13 ships.
