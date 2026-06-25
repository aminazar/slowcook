# slowcook — CHANGELOG

All releases of `@slowcook-ai/cli` and workspace siblings (`@slowcook-ai/core`, `@slowcook-ai/stack-ts`, `@slowcook-ai/forge-github`). Packages version together unless noted.

Semantic-ish: 0.6.x is additive + bug-fix; 0.7.0 is the first behavioural-breaking line (testgen tier-1 redesign). Consumers adopting a new version should read the entry and bump `.brewing/slowcook-cli-version`.

---

## review-overlay 0.9.7

- EPSS jump palette: a **☰ All** button lists every surface (epic/persona/scenario/state) without the ≥3-char spotlight gate — an empty query matches all rows. Browsing the full route set no longer requires guessing search terms.


## review-overlay — docs: vite dev-server mocks behind a CDN (the `?v=` immutable trap)

Docs-only (no code/version change). README `Hosting the built mock` section gains a subsection for the **live vite dev-server** case: vite serves optimized dep bundles (`/node_modules/.vite/deps/*.js?v=<hash>`) as `immutable`, but reuses the `?v` across re-optimizes — so a CDN (Cloudflare) caches a redeployed-but-same-version dep bundle immutably and serves the **stale** overlay to reviewers forever (`cf-cache-status: HIT`), even though the origin serves the new code. Documents the symptom and the fix (`proxy_hide_header Cache-Control; add_header Cache-Control "no-store"` on the dev proxy locations, + a one-time CDN purge to evict the already-poisoned entry). Surfaced by the delgoosh dogfood.

## review-overlay 0.9.5 — live EPSS status, login hints, signed-in pill no longer clips

`@slowcook-ai/review-overlay` 0.9.5 (overlay-only; additive). Three fixes from the delgoosh dogfood:

- **The EPSS status is now LIVE** — it reflects the surface the reviewer is *actually* on (reactive to navigation), not just the last picked surface. It tracks SPA navigation (`history.pushState`/`replaceState` patched to notify, plus `popstate`/`hashchange` and a low-frequency poll). When the live path matches the selection it shows the full `Context › Scenario › State`; navigate away and it shows the live `Context › Scenario`; off-manifest it shows `Identity › /path`. New helpers `findSurfaceByPath` / `liveSurfaceLabel`.
- **Login/OTP "how to enter" hint.** An anonymous context can now carry a `hint` (manifest field); on its login/OTP surface the pill shows it in a **distinct colour** (🔑, amber) under the status, telling the reviewer how to sign in (test OTP / email / masterkey, or "use the jumper"). New helper `activeHint`.
- **Signed-in pill no longer clips.** With the 0.9.3 `min-content` column, a wide signed-in button row (the `@user` identity chip) overflowed *outside* the pill border because the width was hard-capped at 300px. The cap is now `min(560px, 94vw)` — the pill sizes to its button row and keeps the chip inside; the grip still pans it on a tiny viewport.

No breaking changes (adds `ManifestContext.hint` + the three helpers).

## review-overlay 0.9.4 — distinct comments-panel header bar

`@slowcook-ai/review-overlay` 0.9.4 (overlay-only; additive). The comments side-panel header ("Comments (N)") was transparent over the panel body — correctly themed but blending in, so it read as a flat/unfinished header. It now has a **distinct elevated header bar** (`#23232e` dark / `#f4f5f7` light) with the divider below, so the title reads as a proper header in both schemes. No API changes.

## review-overlay 0.9.3 — pill width = button row; EPSS breadcrumb always `›`

`@slowcook-ai/review-overlay` 0.9.3 (overlay-only; additive). Two follow-ups from the delgoosh dogfood:

- **The pill is now exactly as wide as its button row.** Previously a long EPSS status, even though it wrapped, still stretched the pill to its max width. The content column is now `min-content` (sized to the single-line button row) and the status **wraps within that width** — so a long surface label makes the pill *taller*, never wider.
- **The EPSS status always shows the `›` hierarchy separator.** 0.9.1 changed the separator in the label builder, but selections persisted before that still displayed their baked `·` label. The status now **re-derives the breadcrumb from the manifest** by id at render time (`selectionBreadcrumb`), so old and new selections both read `Context › Scenario › State`; a `becomes`/unknown selection falls back to its stored label with any legacy `·` upgraded to `›`.

No API changes (adds the exported `selectionBreadcrumb` helper).

## review-overlay 0.9.2 — more pill compaction + finish the dark-mode pass

`@slowcook-ai/review-overlay` 0.9.2 (overlay-only; additive). Follow-on polish from the delgoosh dogfood:

- **Compacter pill.** The "📍 Pin a comment" button is now an **icon-only 💭** (thought-bubble) toggle — ✕ while armed — instead of an icon+label, and the signed-in chip drops the **`applies`/`review` tier badge** (unexplained jargon; the write-access nuance still lives in the chip's `title`).
- **Dark-mode legibility, finished.** Three overlay surfaces that were still hardcoded light/dark are now theme-aware via `prefers-color-scheme`:
  - the **page badge** (route/story pill in the composer) was `#3a3a3a` — illegible on the dark composer; now themed.
  - the **element-selector** line in the composer now uses the themed dim colour (was a flat `opacity:0.7`).
  - the **comments side-panel** (`CommentsListPanel`) was hardcoded dark throughout (illegible header + chrome in light mode, off-theme in dark) — container, header, dividers, the already-applied toggle, comment cards, replies, and group headers all follow the system scheme now.

No API changes.

## review-overlay 0.9.1 — EPSS pill polish + dark-mode comment composers

`@slowcook-ai/review-overlay` 0.9.1 (overlay-only; additive). Seven fixes from the delgoosh dogfood of the 0.9.0 EPSS pill:

- **Compact pill — the EPSS status wraps, it doesn't widen.** A long active-surface label used to grow the pill rightward (or ellipsize on one line); it now **wraps onto a few lines** inside a capped-width pill, so the pill stays as narrow as its button row.
- **Hierarchy separator `·` → `›`.** The status reads `Context › Scenario › State`, making the Epic▸Context▸Scenario▸State hierarchy visible at a glance.
- **Full-height drag grip.** The grip now spans the **entire left border** (a tiled dot texture via `align-self: stretch`), however many lines the status wraps to — previously it only covered the first row.
- **Status *is* the jump trigger.** Removed the separate `🎛` palette button; tapping the always-visible EPSS status line opens the Spotlight jump palette (one affordance, less clutter).
- **Comment composers follow the system light/dark scheme.** The element-anchored and general-note composers were hardcoded white (`#fff`/`#1a1a1a`) and ignored dark mode; they now theme via `prefers-color-scheme` like the jump palette, with a higher-specificity `.sc-ovl-composer-input` `!important` rule overriding the shadow-firewall's light-pin on the textarea.
- **Visible Cancel button.** The composer Cancel buttons now carry **explicit themed text + border colours**, so they're legible in both schemes (they previously inherited and could vanish against the surface).

No API changes. EPSS resolver/manifest semantics unchanged from 0.9.0.

## review-overlay 0.9.0 — EPSS testing-surface router in the pill

`@slowcook-ai/review-overlay` 0.9.0 (overlay-only; additive). Reviewing a mock means reaching every UI state of every surface fast. A consumer can now point the overlay at a `testing-surfaces.json` manifest (new `testingSurfacesUrl` prop, or `NEXT_PUBLIC_SLOWCOOK_SURFACES_URL`) and the pill grows an **EPSS router** — **Epic ▸ Context ▸ Scenario ▸ State ▸ CTA** — so any action is ≤4 clicks. It lives **inside the pill (one artifact)**. The pill is **left-anchored**: the drag **grip sits on the left edge** (so a long status that grows the pill off the right of the viewport is still recoverable — grab the grip, pan left), with the logo + a compact **nav/rev** toggle pinned beside it. The active surface shows as a **tappable status** (both nav and review modes — the jumper is independent of nav/rev), **left-ellipsized** so the most-specific state stays visible; tapping it opens a **centered, Spotlight-style jump palette** — a floating search that reveals results only once you've typed ≥3 characters (no big upfront list), grouped by epic·context with ⚡/➡ markers. All overlay artifacts (pill + palette) **follow the system light/dark colour scheme** (reactively, via `prefers-color-scheme` — independent of the app's own theme, since the overlay is shadow-isolated). Mobile-portrait friendly.

The model generalises "persona" → an auth/identity **context** with `status` `anonymous` (no user — login/signup/OTP surfaces are first-class) or `authed` (carries `user`); a state's **`becomes`** flips the active context (login as *outcome*: anonymous → authed-as-X). Picking a state resolves the checkpoint and writes the selection to `localStorage["slowcook_test_surface"]` (+ a `slowcook-test-surface-change` event) for the mock's data-adaptor to read, then navigates. The overlay resolves two documented seed conventions — `profileIds` (via an epic `profiles` lookup, with `profileOverrides`) and `dateOffsetDays` (→ ISO, so mock dates never go stale); everything else in `seed` passes through opaque, so the manifest's data shape stays the consumer's own. Manifest shape + resolver (`resolveSelection`/`resolveSeed`, incl. `becomes` + anonymous) are unit-tested. Surfaced from the same delgoosh dogfood as 0.8.x.

## review-overlay 0.8.0 → 0.8.2 — free-nav comment mode, deterministic auth guidance, test hardening

`@slowcook-ai/review-overlay` 0.8.0–0.8.2 (overlay-only). The 0.8.0/0.8.1 features came from a slowcook session dogfooding the overlay on the **delgoosh** SPA (a private, RTL, mobile-reviewed mock) and feeding fixes back upstream; 0.8.2 backfills the test coverage + this changelog entry.

**0.8.0 — arm-to-pick free navigation in LCR comment mode.** Comment mode used to capture *every* page click into a composer, exitable only via Escape — so mobile reviewers (no Esc key) were locked out of navigating the mock. Now a review session navigates the app freely; the reviewer arms a single element-pick ("📍 Pin a comment") and only the *next* click is captured, after which it auto-disarms. Mobile-safe on-screen cancels at every layer (armed banner, composer Cancel, toolbar toggle); Escape steps back one layer at a time (composer → armed pick → mode) instead of nuking the whole mode. The page tint shows only while a pick is live.

**0.8.1 — deterministic auth guidance + classic-PAT sign-in.** Being signed in via the GitHub device-flow OAuth app is *not* enough to comment on a private repo or an OAuth-restricted org — the app's token is blocked and only carries `public_repo`, so reviewers hit an opaque `403 …OAuth App access restrictions…` toast. Now `describeAuthError()` maps 401/403/404 + GitHub's message to a plain-English reason and fix (keyed off the org/repo); the sign-in dialog always offers a classic-PAT path with baked-in instructions and a prefilled "create a classic token (`repo` scope)" link; `signInWithPat()` validates the token and derives identity + write-access tier; write failures that are really auth route to the dialog (`reportFailure()`) instead of a dead-end toast. Plus a docs note: statically-hosted mocks must serve `index.html` as `Cache-Control: no-cache` or reviewers keep seeing a stale mock after each redeploy (content-hashed assets stay immutable).

**0.8.2 — test hardening.** `describeAuthError` is now exported and unit-tested (7 cases incl. the OAuth-restriction dead-end, case-insensitive match, and the 401/404/fallback paths); a jsdom render test covers the 0.8.0 arm-to-pick contract end-to-end (unarmed click navigates, armed click captures + auto-disarms) — which also proves the 0.7.3 shadow-DOM portal still delivers React click events. 73 overlay tests green (was 65).

## review-overlay 0.7.3 — Shadow-DOM style firewall (fixes host-CSS bleed on RTL / hard-reset hosts)

`@slowcook-ai/review-overlay` 0.7.3 (overlay-only; cli unchanged). Fixes a real bug found dogfooding the overlay on the **delgoosh** SPA (a Persian, RTL app): the floating disk "lost its shape" and couldn't be gripped/dragged, and buttons were unclickable.

**Root cause — host CSS leaked *into* the overlay.** The overlay rendered straight into the host's DOM (no isolation boundary), so the host's *global* CSS bled onto it. Two delgoosh rules broke it: a universal reset `*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}` collapsed the disk's internal geometry, and `body{direction:rtl}` mirrored the toolbar and inverted the disk's `right`-anchored drag math. It "worked in rewo" only because rewo is LTR with a benign reset — and because earlier `!important` patches had been written reactively against rewo's *specific* CSS. (No rewo code/styles were ever bundled into the overlay — verified; the leak is purely host→overlay.)

**Fix.** The whole UI now mounts inside a **Shadow DOM** on a body-level host element (`createPortal` into an open `shadowRoot`). Selector-based host CSS (`*{}` resets, `button{}` styles) physically can't cross the boundary. Inherited properties (direction/font/color) still cross, so an in-root `:host{ all: initial; direction: ltr; unicode-bidi: isolate; … }` reset re-establishes them — note `all` deliberately skips `direction`/`unicode-bidi`, which is exactly what un-mirrors the toolbar on RTL hosts. The host element carries no transform/filter, so `position: fixed` children still resolve to the viewport; comment-mode still queries the host document directly (the shadow only encapsulates the overlay's *own* UI). +2 jsdom tests reproducing the RTL+reset host (65 overlay tests green).

**Also closes #205** (signed-in reviewer badge overlapped the draggable toolbar, grip unreachable): that was a 0.6.0-only bug already fixed in **0.6.2** by folding the sign-in into the floating disk (the separate `ReviewerSignInBadge` is gone). delgoosh was pinned to the npm-stale 0.6.0; 0.7.3 carries both fixes. Consumers on 0.6.x should bump.

## 0.21.2 — trace-check coverage + persona-surface lints · review-overlay 0.7.2 (docs studio, persona pane, write-gate)

`@slowcook-ai/cli` 0.21.2 · `@slowcook-ai/review-overlay` 0.7.2. (core/forge-github/llm-anthropic unchanged since 0.21.1.) Ships the two trace-check lints and the overlay 0.6.1→0.7.2 arc that had accumulated on the LCR-review branch under stale version numbers — npm's `cli@0.21.1` predated both lints, and `review-overlay` was still at 0.6.0.

**`trace check` — two new lints:**
- `--coverage` — the inverse of provenance: reports stories/requirements with no LCR mock surface. Opt-in hard-fail (backend-only stories legitimately have no surface, so it's off by default).
- **persona-surface lint** (always-on hard fail): every spec's `persona` + `surfaces[].route` must resolve to a real mock router path (`/u/:handle` matches `/u/you`). Catches a promised-but-unbuilt surface.

**review-overlay 0.6.1 → 0.7.2** (LCR multi-person review polish):
- **0.7.0 Docs studio** — a 📄 mode that fetches/commits the spine markdown (PRD/stories/etc.) via the Contents API on the branch, so a reviewer's doc edit is itself a scope change.
- **0.6.18 write-access apply-gate** — `GET /repos` `permissions.push` decides `vibe` auto-apply vs `community-review` held-for-PM; requires a GitHub login (no anon).
- **0.7.1** persona switcher moves out of the mock into the pane (`surfaces` prop + `SurfaceSwitcher`, pushState nav); login-dialog z-index above the Docs panel.
- **0.7.2** compact pane select (beats host `select{16px!important}`) + pane flex-wraps to 2 rows on portrait mobile.
- **0.6.16/0.6.17** sticky pins, scroll-lock, page/element split, style-isolation; per-author pin identity + hide resolved pins.

## 0.21.1 — fix: publish llm-anthropic 0.18.0 (MENU_SYSTEM)

`@slowcook-ai/cli` 0.21.1 · `@slowcook-ai/llm-anthropic` 0.18.0. The GUCDI `menu` command imports `MENU_SYSTEM`/`MenuStoryDraft` from llm-anthropic, but llm-anthropic was never republished after they were added — so cli 0.21.0 (pinning `^0.17.0`) crashed at load with `does not provide an export named 'MENU_SYSTEM'`. Bump llm-anthropic to 0.18.0 (with the menu prompt) and republish cli so it pins `^0.18.0`.

## 0.21.0 — multi-person LCR review (free-nav + GitHub identity + contextualised issues) · GUCDI commands

`@slowcook-ai/cli` 0.21.0 · `@slowcook-ai/core` 0.15.0 · `@slowcook-ai/forge-github` 0.14.0 · `@slowcook-ai/review-overlay` 0.6.0. (Also the first release carrying the GUCDI greenfield commands — `menu`, `trace check`, `greenfield status`, `brand logo` — that landed on main after 0.20.0.)

Pairs with the GUCDI LCR shape: a mock is now a full navigable app, so review lets a human roam every route and comment anywhere, not pick a scenario — and several reviewers can each sign in as themselves.

**Multi-person LCR review** (review-overlay 0.6.0 + the new reviewer-identity seam):
- `reviewMode: "scenarios" | "lcr"` (env `NEXT_PUBLIC_SLOWCOOK_REVIEW_MODE`). In `lcr` mode the overlay shows on every route (incl. `/`), captures each comment's `pathname`/`route_query`/`route_story`, and files a standalone `[LCR] story-NNN` issue labelled `lcr-review`+`vibe` instead of a PR comment.
- **Reviewer identity** — core `ForgeReviewerAuth` seam + forge-github `GitHubReviewerAuth` (OAuth device flow). run-mock in lcr mode hosts a device-flow auth-helper (`--expose` for a remote box); the overlay's "Sign in with GitHub" posts each comment as that reviewer's own account. Ships a default shared OAuth client-id (overridable via `.brewing/mock.yaml` `review_oauth_client_id`/`review_oauth_scope`).
- **Lifecycle** — applied/declined/noop comments hide behind a "show already-applied" toggle; the new `needs-clarification` status stays visible.
- `useStoryMarker`/`readCurrentStory` — an LCR page self-reports its story at runtime (`data-slowcook-story`) so the issue is tagged with the exact requirement.

On `feat/plate-lcr-free-nav`.

- **`@slowcook-ai/review-overlay` 0.6.0** — new `reviewMode: "scenarios" | "lcr"` prop (env `NEXT_PUBLIC_SLOWCOOK_REVIEW_MODE`, default `scenarios`). In `lcr` mode the overlay no longer hides on the `/` route (an LCR's home is a first-class surface) and every comment payload now carries `pathname` + `route_query` (the route it was left on), rendered as a `**Route:**` line. Back-compat: scenario-mode payloads omit the fields; the parser ignores extras.
- **plate** reads `payload.pathname` (falling back to parsing `url`) and prefixes each comment fed to the amendment agent with `` on route `/x` `` (new pure `plate/route-hint.ts`), so it amends the component rendering THAT page instead of guessing from the selector alone.
- **run-mock** reads `review_mode` from `.brewing/mock.yaml` and passes it through as `NEXT_PUBLIC_SLOWCOOK_REVIEW_MODE`. New `review_mode` field on the mock-shape config (default `scenarios`; GUCDI mocks set `lcr`).
- Remaining for a full Vite LCR demo: the Vite mock template must mount `<SlowcookReviewOverlay reviewMode="lcr" />` (today only the Next.js template mounts the overlay), and the consumer must pin review-overlay 0.6.0 — both land once 0.6.0 publishes.

## 0.20.0 — anti-drift + HITL-halt pipeline: fidelity eye, role gates, dense extraction (sc#173 #12–#14)

Cut 2026-06-07. `@slowcook-ai/cli` 0.20.0 · `@slowcook-ai/gates` 0.11.0 · `@slowcook-ai/llm-anthropic` 0.17.0 · `@slowcook-ai/forge-github` 0.13.0. (Also folds the unpublished 0.19.7 `slowcook serve` fixes, which never reached npm.)

Builds designs #8/#9/#10 from the delgoosh design-react dogfood: brew shipped front-ends that weren't pixel-faithful to the mock, and the pipeline could advance past points needing human review.

- **#8 — fidelity eye.** `@slowcook-ai/gates` gains `diffSnapshots`/`captureSnapshot`/`gradeFidelity`/`runFidelityGate` — render mock + brewed across the viewport×scheme matrix and diff computed-style/color/box/missing. New `slowcook eye --reference <url> --candidate <url> [--story <id>]` command renders the spec's declared `fidelity.modes`, grades, screenshots, exits 1 on drift. `runFidelityPhase` (gate-only or eye-driven via the bounded `runFidelityLoop`) + `slowcook-eye.yml` workflow (uploads `eye-pr-<N>-*`, escalates `blocked-on-designer`) + `slowcook-eye-cleanup.yml`. Validated on the real delgoosh login dark-mode drift.
- **#9 — HITL role gates.** New `slowcook gate check --stage <s> --pr <n>` + `slowcook-gate.yml`. A stage only advances once a *human* in the required role (`.brewing/reviewers.yaml`) approves on the PR — bot/agent reviews never satisfy a gate. Local-pipeline managed-docs halt section.
- **#10 — dense mock-style extraction.** recon now pins each element's *full* utility-class set (brewed ⊇ mock containment) instead of a 17-token allowlist; brew plate-mode prompt scopes the edit license to data-wiring seams and treats the dense tests as the design contract.
- **Spec `fidelity.modes`** (refine declares → eye enforces → brew is measured) on the `Spec` schema.
- `slowcook` cli now depends on `@slowcook-ai/gates` (the eye launches Chromium; gates supplies the diff engine) + `@playwright/test`.

The one seam not yet validated end-to-end: the live `applyFix` → brew-agent fix turn (eye-DRIVEN correction over a hot-reload candidate). It's injected, not defaulted; gate-only escalation is fully wired.

---

## 0.19.7 — `slowcook serve` execution layer + compose-file layering (sc#173)

Cut 2026-06-03. `@slowcook-ai/cli` 0.19.7 only.

Dogfood feedback on the 0.19.6 `slowcook serve` release (issue sc#173, delgoosh local-pipeline session 2026-06-01) surfaced two correctness gaps in the planners. Both fixed here.

- **sc#173 finding #1 — `serve <profile> up` actually executes.** Previously the planners emitted `cmd: docker compose -f ... up -d` into `output[]` and exited without running it, even when `profile.ssh_target` was set. Operators had to copy-paste + ssh themselves. Now planners populate `result.commands[]` with structured `ShellCommand` records; the cli wrapper invokes `runCommands()` which wraps `remote: true` commands in `ssh user@host 'cd <checkout_dir> && <cmd>'` and executes via `execSync`. `--dry-run` prints the wrapped form without executing.

  Local-only commands like `git push` (sync verb) declare `remote: false` so they're never ssh-wrapped. Stdio is inherited so operators see docker / git output in real time.

- **sc#173 finding #2 — multi-file compose + `--build` suppression.** New `compose_files: [string]` field on the profile schema; takes precedence over `compose_overlay` when both are set. Real consumers (delgoosh, etc.) put long-lived services (postgres, networks, depends_on chain) in `docker-compose.production.yml` and the dev overlay ONLY redefines the bind-mounted services. Emitting just `-f overlay.yml` skipped the base + broke the `depends_on` graph.

  The `--build` flag is now suppressed for `bind-mount-source` mode (the whole point of bind-mount is skipping the build loop). Still passed for `built-image` mode.

  New `composeFiles(profile)` and `shouldBuildOnUp(profile)` helpers, both pure + exported for testing.

- **`runner.ts` + `ShellCommand`**: introduces the structured-command layer. Pure `resolveCommand()` returns the wire-shape string (with ssh-wrap applied when applicable); `runCommands()` executes a list, bailing on first failure. Six new unit tests cover the local / remote / single-quote-escape / dry-run paths.

- **Backward-compat**: every existing `slowcook serve` invocation continues to work. The legacy single-file `compose_overlay` field still resolves through `composeFiles()`. Existing `.brewing/dev-env.yaml` consumers can adopt `compose_files` incrementally.

Findings #3–#7 from the same dogfood (autosync workflow scaffold, dynamic source-branch resolver, alpine-vs-debian for native modules, dev-mode side-effects audit pattern, mock-detect verbosity) tracked as follow-ups; some are net-new design discussions, some are doc-shaped.

Test count: 1154 → 1169.

---

## 0.19.6 — `slowcook serve` multi-mode + help-manifest single-source

Cut 2026-06-01. `@slowcook-ai/cli` 0.19.6 only.

Same-day follow-up to 0.19.5. Two headline additions plus the per-story status CLI the delgoosh agent had drafted earlier and hadn't yet been merged.

- **`slowcook serve <profile> <verb>` (design #5 — all three phases shipped)**:
  - `serve dev` (#169) — bind-mount source for fast UI iteration. Replaces the hand-rolled push/sync plumbing every consumer had been writing on top of `dev-env`.
  - `serve mock` (#170) — vite-dev mock app for vibe-feedback loops. Auto-skips silently when `mock/package.json` has no `scripts.dev` (Trade-off #4).
  - `serve staging` (#171) — built-image profile with named-scenario seed reset (`seed.scenarios: {demo, enterprise, post-incident}` — Trade-off #5 map shape). `reset --scenario <name>` re-runs idempotent seed scripts; optional `seed.guard_env` blocks accidental wipes from interactive sessions.

  Consumer-supplied compose overlays + bring-up commands; slowcook ships zero image-build pipeline (Trade-off #3). Config can live in `.brewing/serve.yaml` (new) OR `.brewing/dev-env.yaml` (legacy) — both paths supported forever (Trade-off #1). `slowcook dev-env <verb>` is kept as a backward-compat alias and marked deprecated in the help catalog. Phase 1–3 documented in `docs/plans/0.20-design-discussions.md` design #5 (locked DECIDED 2026-06-01 in #167).

- **Help manifest — single source of truth (#168)**: `packages/cli/src/commands.manifest.ts` exports the canonical `COMMANDS` array. Both `slowcook help` AND `packages/cli/README.md`'s catalog block now render from it. `scripts/sync-readme-help.sh` regenerates the README block; `.github/workflows/readme-help-sync.yml` fails CI on drift. Closes the npm-facing help drift the user flagged — README was stuck at "Commands (v0.4)" listing only 4 commands while the cli surface had grown to 38.

  Per-command `--help` shims added for `cost` and `knowledge` (both were erroring before). New invariant test: every `case "<name>":` in `cli.ts` must have a matching manifest entry — no callable command without a doc entry, enforced at build time.

- **`slowcook stories status` (#161, sc#146 #6)**: per-story pipeline-stage table (refine / testgen / vibe / brew / chef). Two-source PR scan (branch-prefix search + label scan); graceful no-token fallback. Reads `specs/_index.yaml` + queries GitHub for slowcook-labelled or slowcook-branched PRs. The PR was opened by the delgoosh agent right before 0.19.5 was cut but not yet merged at the time of that release.

Test count: 1087 → 1154 (+67 across the four PRs).

CHANGELOG note: this entry covers PRs since 0.19.5 (`3572615 → HEAD`).

---

## 0.19.5 — local-claude-pipeline batch #5 round-trip

Cut 2026-06-01. `@slowcook-ai/cli` 0.19.5 + `@slowcook-ai/llm-anthropic` 0.16.3.

Tenth round of feedback from a local Claude Code session driving slowcook against the delgoosh consumer. Mostly mechanical adds that close gaps the agent surfaced while brewing eight stories on the consolidation branch + deploying it. Plus four 0.20 design-discussion decisions locked into `docs/plans/0.20-design-discussions.md`.

- **`validateRouteCollisions` (#152)** — third member of the post-emit refine lint chain (after `validateEntityFieldReferences` in #132 and `validateComponentReuseShape` in #136). Flags when two stories claim the same `route.file` value; PM gets a `flagged`-action finding instead of two specs racing to the same file. Same shape as the existing validators; pure helper exported for unit testing.

- **`validatePlateDtoColumns` (#160)** — plate-time check that every field in `packages/dtos/src/**/*.ts` either backs to a migration column or is annotated with a `// computed:` comment. Caught real DTO drift on delgoosh story-006 (peer-chat); previously a silent landmine for the next handler PR. Plugs into plate's existing flagged-finding loop.

- **Chef DTO-rename surface grep (#155)** — chef now does a surface grep for the old DTO field name before applying any edits. Closes the class of bug where a chef PR renames a field in the DTO but misses one of the call sites; downstream brew sees a stale name + halts.

- **Brew mirror-stories addendum (#159)** — small one-liner in `BREW_SYSTEM`: when a spec's `related_specs[].note` matches "mirror of X" / "inverted from X", brew should propose mirror-codegen rather than full re-writing. Builds toward the `slowcook mirror` codegen command parked for 0.20 (see Design Discussion #2).

- **Managed-block additions in `slowcook upsert-agent-docs` (#153 + #154)** — combined-testgen+brew-PR pattern for small stories (#153) and the no-import-stub pattern for testgen against not-yet-installed deps (#154). Both surfaced as recurring patterns in the local-pipeline session.

- **Doc additions (#157 + #158)** — `docs/local-pipeline-role.md` names the IDE-driving-slowcook role pattern (when to use it, what to mimic, what NOT to do); `docs/testgen-backend-conventions.md` documents the NestJS-CQRS handler-test conventions (one helper per handler, `@slowcook-stub` line-1 marker, TestManager beforeAll/beforeEach/afterAll, per-test inlined seed helpers). Both feed into the `@slowcook-ai/backend-adapter-nestjs` package now scoped for 0.20.

- **0.20 design-discussion decisions (#162 + #163)** — four parked design items resolved + documented in `docs/plans/0.20-design-discussions.md`:
  - **#1 `slowcook recipe --backend`** → per-framework adapter packages (`backend-adapter` + `backend-adapter-nestjs` first impl) mirroring `stack-ts` / `forge-github` layout
  - **#2 `slowcook mirror` codegen** → parametrize-at-source-write + minimal mirror CLI (~30 LoC); refine + brew prompt addendums push parametrization upstream
  - **#3 story-ID claim/release** → tombstone via `specs/_retired/story-N.yaml`; numbers never recycle; `reserve-story-id` for atomic claim; `stories release` for retirement
  - **#4 `brew_complexity` field** → no complexity field; recipe agent emits `brew_strategy: single|multifurcate|pair-brew|escalate-to-human` directly in `recipe/manifests/<story>.json`; brew strategy router dispatches

Test count: 1075 → 1087.

CHANGELOG note: the 0.19.1 / 0.19.2 / 0.19.3 / 0.19.4 entries were not backfilled into this file before 0.19.5; see release PRs #137 / #138-#143 / #144 / #150 for those release bodies.

---

## 0.19.0-alpha.20 — refine questions-first layout + visible cost footer

Cut 2026-05-14. Two more PM-facing comment rules surfaced from
delgoosh#606 round 2 observations:

- **α.20 — questions-first layout, decisions collapsed below**
  (`llm-anthropic` 0.16.0-α.4): refine's comment now leads with
  questions. Decisions move to a `<details><summary>Decisions I've
  already made on your behalf</summary>` block UNDER the questions.
  The PM opens the comment to find what THEY need to act on, not to
  audit a wall of decisions first. Trace + audit material stays
  available but folded.

- **α.20 — visible cost footer on every refine comment**: every
  question-round comment now appends a human-readable footer:

  > 💰 **This step:** $0.35 · **Story total:** $0.42 (2 agent calls so far)

  Plain text, not HTML-comment, so the PM sees it. "Story total"
  accumulates by reading prior bot comments + summing the existing
  `<!-- slowcook:cost -->` markers (already emitted across the
  pipeline; this just surfaces them). Cost transparency at every
  step is now contract, not just trace.

  New helper `formatCostFooter(thisRunUsd, priorMarkers)` in
  `@slowcook-ai/llm-anthropic` (re-exported from package index).
  Wired into refine's question-round emit site; other emit sites
  (overlap-blocked, contradiction-blocked, resubmit-noop, etc.) and
  other agents (testgen, plate, brew, chef) follow in subsequent
  PRs.

- **Eval fixture extended**: the `refine-pm-facing-question-rules`
  fixture now also asserts the prompt contains the `<details>` /
  `<summary>` layout language. cli 800/800 tests + eval gate 2/2
  fixtures green.

---

## 0.19.0-alpha.19 — refine PM-facing question rules

Cut 2026-05-14. Codifies four hard rules for refine's clarifying-question
rounds, validated against the first organic refine run on delgoosh#606
where the absence of these rules produced 5 questions all violating
≥1 rule.

- **α.19 — refine prompt overhaul** (`llm-anthropic` 0.16.0-α.3):
  the `REFINEMENT_ANALYST_SYSTEM` prompt now enforces:
  1. **Decide-first** — technical questions answerable by reading
     the codebase MUST be decided by the agent. It can mention
     alternatives + trade-offs but always picks one and explains
     why. Only ask when there is genuine PM-only judgment.
  2. **Never ask about tests** — refine NEVER asks about test
     scenarios, test scope, or what cases to cover. Testgen's job.
  3. **No internal pipeline leakage** — PM-facing text MUST NOT
     name slowcook internal agents/stages (refine, recipe, plate,
     vibe, brew, port, sift, chef, navigator, tier-1, tier-2).
     The PM thinks about their product, not the pipeline.
  4. **Question shape**: ≤3 questions/round (was 5), each = one-line
     imperative ≤15 words + labeled options (a/b/c) ≤10 words each
     + optional rationale below. Includes a bad-vs-good example
     drawn verbatim from the delgoosh#606 violations.
- **Second eval fixture** (`refine-pm-facing-question-rules`):
  asserts the prompt contains the four-rule language + the
  bad/good example, so future prompt edits that strip these rules
  fail the eval gate. cli 800/800 tests + eval gate 2/2 fixtures
  green.

### Test coverage

`@slowcook-ai/cli` 800/800 passing. New: refine added to the eval
BUILDERS map; second bootstrap fixture closes part of
[#19 follow-ups](https://github.com/aminazar/slowcook/issues/47).

---

## 0.19.0-alpha.18 — TypeORM migration scanner + migration gate

Cut 2026-05-13 (late). Two-part fix for the long-standing schema-gap
class (rewo story-005 / story-006 incident shape, `project_migration_gap_in_pipeline` memory). Ships ahead of the first delgoosh story so the
brownfield consumer is covered before any pipeline run.

- **α.18 — TypeORM migration scanner (closes #108)**: `scanMigrations`
  now auto-dispatches per-file: `*.sql` → existing Supabase parser;
  `*.ts` → new TypeORM parser. The TS parser handles two patterns:
  raw SQL via `queryRunner.query(\`...\`)` (template-string extraction
  then existing SQL parsers), and `DatabaseCreateTable(queryRunner,
  'tbl', [...])` helper calls (delgoosh-monorepo style, with implicit
  helper-added columns: id, created_at, updated_at, deleted_at).
  Auto-discovery: if `supabase/migrations/` is absent, tries
  `packages/postgres/src/migrations`, `src/migrations`, `migrations` in
  that order. Smoke-tested on delgoosh-monorepo — detects 14 migration
  files, 61 tables.
- **α.18 — migration gate in recon (closes #109)**: new
  `checkMigrationGate(repoRoot, storyId)` invoked from `slowcook recon`.
  Reads the story spec, extracts `proposals.schema.sql`, and verifies
  every proposed table / column is covered by some migration file on
  disk. Emits `structural_gaps[].kind = "missing_migration"` with
  recommendation text pointing at the right migration path for the
  consumer's flavour (TypeORM or Supabase). Pure structural — no LLM.
  Hooks into the existing `escalate` exit-2 path, so brew-auto
  workflows already gate on it without further wiring.

### Test coverage

`@slowcook-ai/cli` 800/800 passing (was 775). New: 8 history-index
tests (TypeORM parsing + auto-discovery), 12 migration-gate tests
(no-op / Supabase / TypeORM / format helpers).

### Why this matters for delgoosh

Delgoosh uses TypeORM migrations at `packages/postgres/src/migrations/*.ts`
in a helper-driven style. The old scanner only saw Supabase SQL —
zero migrations would be detected, the gate would silently no-op,
and the rewo story-005 incident class would have shipped on the
first delgoosh story. After α.18, the gate fires.

---

## 0.19.0-alpha.17 — prompt-regression eval gate

Cut 2026-05-13. Closes #19 (partial — shape + one bootstrap fixture
land; the remaining 4 rewo-history fixtures filed as follow-ups).

- **α.17 — `slowcook eval` cli command + CI gate (#19)**: new command
  that loads frozen fixtures from `packages/cli/eval/fixtures/<id>/fixture.json`,
  calls the relevant `build*Prompt(args)` function from
  `@slowcook-ai/llm-anthropic`, and asserts the resulting prompt
  string contains all `expected_prompt_includes` substrings and none
  of the `expected_prompt_excludes` substrings. New workflow
  `.github/workflows/eval-gate.yml` runs `slowcook eval --all` on
  every PR that touches `packages/llm-anthropic/src/prompts/**`.
  Catches the regression class the 749 cli unit tests don't:
  silent context drops in prompt PRs.
- **Bootstrap fixture**: `chef-orchestrate-close-on-incomplete-halt`
  models the rewo PR #153 L3 chef-orchestrate halt — asserts the
  prompt includes the chef-drift ledger, all related PRs, runner
  output, and the spec body, and excludes placeholder leaks (`TODO`,
  `{{`, etc.). Live verification: `slowcook eval --all` passes
  against current `buildChefOrchestratePrompt`.
- **Docs**: CONTRIBUTING.md gets a "Prompt-regression fixtures"
  section documenting the fixture format + when to add one.
  AGENTS.md quick-reference row added.

### Test coverage

`@slowcook-ai/cli` 775/775 passing (was 769). New: 11 eval-command
tests covering listing, validation, run-fixture pass / fail / error
shapes.

### Follow-up fixtures (filed as separate issues)

Each fixture below captures a real regression class from rewo history
+ proves the eval gate would have caught it. Splitting per-fixture
keeps each PR small + the assertion-design discussion focused.

- chef converge-on-clean-brew (story end-to-end success)
- brew styling-gap shape (zero-className output class)
- recon stub-scan escalation context
- vibe brownfield-DISCOVERY awareness

---

## 0.19.0-alpha.12 → α.14 — visibility, traceability, OSS process

Cut 2026-05-07 (afternoon round 2). Five-task stretch closing the
incident-response architecture (cost markers + artifact upload +
REPORTING.md + AGENTS.md + bug-report issue template). 727 → 727
cli tests (one round was pure docs/process; another added new tests
for the read-only env-var helper).

- **α.12 — uniform `slowcook:cost` markers across the chef stack (#86)**: chef-drift, chef-orchestrate, chef (PR-CI handler), and recon stub-scan now emit `<!-- slowcook:cost agent=X usd=Y kind=Z cli=V -->` HTML markers consistent with refine / vibe / plate / brew / testgen. `gh issue view N | grep slowcook:cost` now aggregates per-story spend across the WHOLE pipeline, not just the 5 agents that already emitted markers.
- **rewo workflow: chef-drift uploads halt-trigger.json as artifact (#87)**: the LLM-input bytes (failing test runner output + source file contents) are now downloadable from the workflow run, closing the one reproducibility gap in the read-only-access flow. Validated empirically: maintainer can now `gh run download` + replay chef-drift locally with the EXACT input the LLM saw. (Rewo-side change; consumer workflows that mirror this pattern should adopt the same staging step.)
- **α.13 — `slowcook docs <topic>` cmd + `SLOWCOOK_READ_ONLY` env var (#88)**: `slowcook docs reporting / agents / read-only` prints bundled docs from the installed package. New `SLOWCOOK_READ_ONLY=1` env var blocks every GitHub-side write (commits, pushes, comments, labels, PR closes) so a maintainer can replay slowcook commands on a consumer's repo without polluting state. Applied at chef-drift / chef-orchestrate / recon stub-escalate write sites. Brew not yet gated (its commit/push logic needs a wider rework; deferred). 8 unit tests on `isReadOnlyMode()`.
- **REPORTING.md polish**: GitHub-only forge caveat at top; @aminazar named explicitly as the maintainer to grant Triage role to (with link to repo for current-owner check); "What you'll see when a fix ships" section with the comment-back template + `slowcook:fix-notice` HTML marker; triage label table.
- **α.14 — AGENTS.md + README pointer (#89)**: canonical entry doc for AI coding agents (Claude Code, Cursor, etc.) helping a human ship features through slowcook. Decision tree, pipeline diagram, 22-command quick reference, ~15-item pitfalls memory. README first paragraph gets a bold pointer so any agent reading slowcook hits AGENTS.md first.
- **OSS incident-response process (#90)**: bug-report issue template (forces source-issue / PR / workflow-run URLs + agent / version / expected-vs-actual + 2 pre-flight checkboxes); `.github/ISSUE_TEMPLATE/config.yml` disables blank issues; CONTRIBUTING.md (regression-test discipline + after-fix workflow + cli conventions). Created 4 persistent labels on `aminazar/slowcook`: `needs-info`, `confirmed`, `regression-test-pending`, `blocked-on-anthropic`. `fixed-in-α.X` created on-demand per fix.

### Test coverage

`@slowcook-ai/cli` 727/727 passing (was 718). `@slowcook-ai/llm-anthropic` 13/13.

---

## 0.19.0-alpha.9 → α.11 — chef stack auto-loop, default pair-brew nav, reuse/stub filters

Cut 2026-05-07 (afternoon session). Four-task autonomous run closing the post-checkpoint task list (#83 / #82 / #85 / #84). 668 → 718 cli tests across the run; $0 Anthropic spend (only deterministic helpers + dry-run dispatches).

- **α.9 — Default Anthropic-backed pair-brew + `--with-navigator` flag (#82)**: `slowcook brew --with-navigator` constructs a default `NavigatorHook` that calls Anthropic with `NAVIGATOR_SYSTEM` + `buildNavigatorPrompt`, parses the response as `NavigatorVerdict`, adapts to the brew-loop's `NavigatorHookVerdict` shape via the pure helper `navigatorVerdictToHookVerdict`. Per-call cost-budget guard (default $0.10/iter) returns null on overrun → brew abstains. Lean prompt-context loader pulls mockFiles + codeMapDigest + specYaml from disk. 18 unit tests on the pure helpers. End-to-end real brew validation awaits ANTHROPIC budget.
- **α.10 — Reuse-scan filters (#85)**: `recon --reuse-scan` now defaults to skipping files marked `@slowcook-template` / `@slowcook-stub` / `@generated` / "AUTO-GENERATED" / "do not edit by hand" (header-only check, first 400 chars). New `--exclude <glob>` flag for project-specific filtering. Empirical impact on rewo: 65 → 7 pairs (89% noise reduction); the 19 excluded files were exactly the noise — entities templates + stubs + mock barrels. `--no-skip-auto-templates` disables the default. 13 unit tests.
- **α.11 — Stale-stub detector (#84)**: `recon --stub-scan` walks `src/` for `@slowcook-stub` markers, ages each via `git log --diff-filter=A --follow --reverse` (file's first-add commit), classifies fresh/stale/unknown against `--stub-max-age-days` (default 14). Optional `--stub-escalate` posts a PM-actionable comment on the stub's source issue with three options (re-dispatch / hand-write / withdraw). Closes the gap reuse-scan exposed: stubs are incomplete-work signal, not refactor signal. 19 unit tests.

### Workflow integration (rewo-side)

- **chef-drift exit-1 → chef-orchestrate auto-chain (#83)**: when chef-drift exits 1 in `--pr` finisher mode, the workflow now automatically dispatches chef-orchestrate against the same PR. Closes the chef stack manual-dispatch loop. Final-exit-code policy: workflow exits 0 when chef-drift OR chef-orchestrate succeeded; exits 1 only when both halted. Dry-run dispatch (run 25470122594) validated the YAML structure + step gating; failure-path empirical validation awaits next organic halt.

### Operations note

Yesterday's npm → pnpm migration on rewo broke the scheduled tier-2 acceptance workflow (`npm ci` against a missing `package-lock.json`). Surfaced today; fixed by switching all rewo consumer-deps install steps (acceptance / brew / sift / vibe / slowcook / pair-sim) to `pnpm/action-setup@v4` + `pnpm install --frozen-lockfile`. Knock-on bug from a clean migration; would have hit the next dispatched workflow regardless of which.

### Test coverage

`@slowcook-ai/cli` 718/718 passing (was 562 at session start, 668 at midday checkpoint). `@slowcook-ai/llm-anthropic` 13/13.

---

## 0.19.0-alpha.4 → α.8 — pair-brew prod wiring, recon shape v2, refactor + reuse-scan

Cut 2026-05-07. Five-alpha autonomous run shipping the long-deferred slowcook task list (#76, #77, #75, #64, plus reuse-scan as a follow-on). All pure-helper-tested locally; no Anthropic dispatch needed beyond the L3 dogfood ($0.012 on rewo PR #153). 562 → 668 cli tests across the run.

- **α.4 — pair-brew navigator hook in production loop (#76)**: optional `ctx.navigatorHook` on `BrewContext` fires post-iter, pre-checkpoint. On `block` verdict, reverts iteration + folds concerns into next iter's history. Pure decision helper `decideNavigatorAction` exported + 7 tests. Default Anthropic-backed implementation deferred to α.9+.
- **α.5 — navigator may emit hard-signal tests on persistent BLOCKING (#77)**: `NavigatorHookVerdict` gains optional `proposedTest: { path, content }`. Path-validated (`tests/navigator/`-only) + written to disk during the BLOCK branch so the next iter's red-set picks it up. Hard signal escapes soft-prompt-ignored loops (the entities-falsified failure mode). 13 unit tests.
- **α.6 — recon shape-emit v2 (#75)**: `synthesiseShapeTestFile({ emitMode: "v2" })` imports each component, mounts via `@testing-library/react`, queries the live DOM for testid presence, class tokens, header element. Catches dynamic-className drift v1's source-grep tests miss. v1 stays default; opt into v2. 11 unit tests.
- **α.7 — refactor command (#64)**: `slowcook refactor` reads `.brewing/refactor/proposals.json`, filters by `--scope`, ranks by benefit-per-cost, prints table or JSON. Boundedness rule: every `filesAffected` must match at least one scope pattern (refactors stay surgical). Source-agnostic — hand-authored JSON, recon emissions, future LLM proposers all feed the same pipeline. 18 unit tests.
- **α.8 — recon `--reuse-scan` flag**: deterministic near-duplicate detection across components AND API/utility modules. Pure regex-based structural-signature extraction (jsxTags / propsUsed / callsUsed / imports / exports), Jaccard similarity with auto-categorization (component-vs-component vs api-vs-api; cross-category short-circuits to 0). `--write-proposals` appends synthesized RefactorProposal entries directly to the file `slowcook refactor` consumes. Fixed TS-generic-as-JSX-tag false positive via negative lookbehind. 22 unit tests.

### Empirical run on rewo `src/`

After cleanup, 11 real-signal pairs surfaced (out of 65 raw matches at threshold 0.7). Most prominent finding: 6 `@slowcook-stub` files left behind from incomplete story-016/018 brews showing as 100% similar — that's stub-leakage signal, not refactor signal. Genuine moderate duplication: `reactions POST` ↔ `rewos POST` (77%), `invites/send-email` ↔ `invites/validate` (73%). Verdict: don't build pre-write prevention — chronic dup-creation isn't actually happening; periodic reuse-scan + a separate stale-stub detector are the right level.

### Test coverage

`@slowcook-ai/cli` 668/668 passing (was 562 at session start). `@slowcook-ai/llm-anthropic` 13/13.

---

## 0.19.0-alpha.3 — slowcook init mock auto-configures pnpm workspace

Cut 2026-05-06.

`slowcook init mock` now wires `mock` as a pnpm-workspace member when the consumer is on pnpm — eliminating the duplicate-`node_modules` problem (mock + prod sharing 200-500MB of identical Next/React/Vitest/Tailwind transitive deps that previously installed twice). New behavior:

- pnpm consumer + `pnpm-workspace.yaml` exists → appends `- mock` to the existing block-list (preserves prior indentation + entries)
- pnpm consumer + no workspace file → creates `pnpm-workspace.yaml` with `packages: [- mock]`
- pnpm consumer + mock already declared → no-op
- npm/yarn consumer → prints a one-line recommendation (no auto-migration; that needs lockfile re-resolution)

The post-init "Next steps" text adapts: pnpm consumers see `pnpm install` at root + `pnpm --filter mock dev`; npm/yarn consumers see the legacy `cd mock && npm install` flow plus an inline migration hint.

Three new exported helpers: `detectPackageManager` (lockfile-presence pure), `isMockInPnpmWorkspace` (yaml-shape-aware), `ensurePnpmWorkspace` (the orchestrator). 17 new unit tests on those helpers.

Discovered post-rewo dogfood (2026-05-06): rewo's `mock/` ended up with its own `pnpm-lock.yaml` + `node_modules` distinct from the root `package-lock.json`, costing duplicate disk + double install time on every fresh clone. Fix is upstream-only — rewo migration is consumer's call (lockfile re-resolution risk).

### Test coverage

`@slowcook-ai/cli` 596/596 passing (was 579).

---

## 0.19.0-alpha.2 — chef L3 (chef-orchestrate) + L2 path-alias fix

Cut 2026-05-05.

**Chef L3 (cli α.10 L3 α.0)** — new `slowcook chef-orchestrate --pr <n> --story <id>` command + chef-orchestrate prompt + ChefOrchestrateVerdict types in `@slowcook-ai/llm-anthropic`. Sibling to chef-drift: where chef-drift edits source files surgically, chef-orchestrate decides what to do with a halted PR (one of `redispatch_brew | rebase | escalate | close`). Reads chef-drift's prior ledger, PR state, spec, all open PRs for the story, and the recent runner output. α.0 implements `escalate` (post comment to source issue + apply chef:escalate label) and `close` (post comment + gh pr close) end-to-end. `redispatch_brew` and `rebase` persist the verdict to `.brewing/chef-orchestrate/story-<id>.json` for a follow-up workflow step to act on (auto-execution lands in α.10 L3 α.1). 10 new unit tests on `validateVerdictShape` (per-kind action shape).

**Chef L2 path-alias fix (cli α.1)** — `collectImportedSourceFiles` + new `resolveImportToFile` helper now resolve `@/X` and `~/X` (Next.js / Vite default tsconfig path aliases) in addition to relative `./X` `../X` imports. Previously chef-drift saw 0 source files when failing tests imported via `@/components/...`. Validated on rewo PR #153: alpha.0 → 0 source files visible, HALT; alpha.1 → 3 source files visible, AUTONOMOUS_FIX. Limitation: arbitrary tsconfig.paths entries (`@tests/`, `@app/`, etc.) still treated as scoped packages — reading consumer's `tsconfig.json` paths is α.3.

### Test coverage

`@slowcook-ai/cli` 579/579 passing (was 562). `@slowcook-ai/llm-anthropic` 13/13 passing.

---

## 0.19.0-alpha.0 — chef α.10 L2 finisher mode + prompt domain sweep (in-repo)

Cut 2026-05-05 (in-repo only; not yet on npm). First entry on the post-0.18 alpha line. Two unrelated additions:

**Chef α.10 L2 (cli, llm-anthropic):** `slowcook chef-drift --pr <number>` enables finisher mode — chef checks out the PR's branch as a local `chef-finisher/pr-<n>` ref, makes its surgical edits there, commits, and pushes back to the PR's head branch (re-running CI). Audit comment routes to the PR (not the source issue). New `brew_halt_class` enrichment: cli precomputes `failing_test_files` / `failing_test_contents` / `source_file_contents` (resolves relative imports against the test dir) and injects them into `trigger.raw` so chef can write surgical search_replace pairs without read tools. Chef prompt explicitly bans editing `failing_test_contents` (tests/ is frozen) — if only a test edit can fix it, return `pm_question`.

New unit tests in `packages/cli/src/commands/chef/drift-fix.test.ts` (11 cases) cover both pure helpers (`parseBrewHaltOutput`, `collectImportedSourceFiles`); end-to-end finisher run requires a real halted brew PR + ANTHROPIC_API_KEY and is left to the next dogfood iteration.

**Prompt + consumer-surface domain sweep:** all 8 agent prompts (`brew`, `chef`, `investigate`, `navigator`, `plate`, `refine`, `testgen`, `vibe`) plus consumer-facing surfaces (init templates, mock-readme generator, init from-prod help/console, forge-github README, stack-ts emitted test setup) had rewo-domain references rewritten to neutral examples (Item / EntityHeader / RationBadge / your-org / your-repo / etc). Internal source/JSDoc comments that explain WHY a check exists keep the historical rewo references — slowcook devs need that context. Net: agents see no per-project vocabulary; consumer-emitted code/help shows neutral examples.

### Test coverage

`@slowcook-ai/cli` 562/562 passing (was 551 at 0.18.0). `@slowcook-ai/llm-anthropic` 13/13 passing.

---

## 0.18.0 — pair-brew + chef stable cut

Cut 2026-05-05. Promotes the 0.18-alpha line to stable. `latest` dist-tag now points at 0.18.0; the 0.13.x line that was previously `latest` is retired.

### What's new vs 0.17

The 0.18 line evolved through 9 alphas (cli α.0 → α.9, llm-anthropic 0.14.0 → 0.15.0). Two architectural arcs played out empirically:

**Falsified: entities-as-typed-contract (cli α.6 + α.7).** `slowcook init entities` extracts the consumer's domain ERD into `src/lib/entities/<table>.ts` (TypeScript interfaces + zod schemas) and writes a mock-side re-export shim. Three real dispatches across vibe + brew showed agents IGNORE the entity-import directive — they legitimately use per-component view subsets, not full entities. The layer stays as supporting infra (refactor codemods, schema discipline) but is demoted from load-bearing rail. See `docs/experiments/entities-hypothesis-tested-and-failed.md`.

**Settled: pair-brew + chef as a two-layer system.**
- **Pair-brew prototype (cli α.8)**: `slowcook brew --pair-sim` runs driver + navigator agents in alternation. Driver writes prod code; navigator reviews each iteration with structured per-axis verdicts (design_fidelity, reuse, responsive, test_prediction, api_contract, accessibility, code_quality, cross_story_risk). Navigator can BLOCK with revert. Empirically validated on rewo PR #154 ($1.29, 35/35 green) + two real pair-sim runs ($2.20 total) that surfaced cross-contract drift as the architectural bottleneck.
- **Chef α.9 L1 (cli α.9, llm-anthropic 0.15.0)**: `slowcook chef-drift` is the surgical drift-fixer. Triggered by recon escalation, brew halt-class, navigator halt-class, or mock-isolation failure. Reads spec + history-index + cli-precomputed importer enrichment + existing file content; emits structured ChefVerdict JSON with `search_replace` edits (literal find/replace pairs, never full-file regeneration). Validates pre-vs-post (handles pre-existing PR debt correctly). Commits as `slowcook-chef[bot]`. Posts audit comments via gh OR curl fallback. Hard line: never edits `tests/`, `vitest.config.*`, `.brewing/auto-gen/`. Validated end-to-end on rewo PR #157 ($0.045 single move).

### Other 0.18 work

- **`init entities`** with mock-side shim (cli α.6 + α.7)
- **gh-proxy in `slowcook run-mock`** (cli α.2): localhost http proxy signs github calls with `gh auth token`; review-overlay reads `NEXT_PUBLIC_SLOWCOOK_GH_PROXY` to skip PAT prompt. CORS-strip in α.3.
- **Side-effects audit** (cli α.0, llm-anthropic 0.14.0): when refine detects contradiction, 2nd LLM pass enumerates exact assertions to flip. PM reviews granularly.
- **Recon resolveImport mock-strict** (cli α.4): false-positive `clean` was letting brew dispatch when vitest couldn't actually discover the imported component.
- **Brew prunes auto-gen artifacts** (cli α.5): agent edits to `.brewing/code-map.target.md` no longer revert the WHOLE iteration alongside legitimately-correct src/ changes.

### Migration

Consumers on 0.13.x (the prior `latest`) should bump to 0.18.0 via `.brewing/slowcook-cli-version`. Major intermediate work happened across 0.14, 0.15, 0.16 — see prior CHANGELOG entries for the trail.

Future incremental work (chef α.10 finisher, recon shape-emit v2, prop-shape reconciliation, etc.) continues on the `alpha` dist-tag as `0.19.0-alpha.X`. Today's `0.18.0-alpha.9` remains accessible via `npm install @slowcook-ai/cli@alpha`.

### Test coverage

`@slowcook-ai/cli` 546/546 passing. `@slowcook-ai/llm-anthropic` 13/13 passing.

---

## 0.17.0-alpha.1 — recon command + init from-prod scaffolding

Cut 2026-05-03. Two new commands land alongside the α.0 prompt-side work.

### `slowcook recon --story N`

Pre-brew structural divergence check. Pure deterministic; no LLM. Catches residual vibe ⇄ testgen divergence that refine + downstream history-awareness didn't bridge:

- Tests importing non-existent components → `STORY_HISTORY_CONFLICT`
- Testid selectors in tests → present in mock JSX (the rewo PR #147 wall, $0 to detect now)
- Brownfield rename safety (recorded; deferred to 0.17.7)

Output: `.brewing/recon-result.json` + console summary. Exit code 2 on escalation; brew workflow should NOT dispatch.

Smoke-tested on rewo story-017: caught all 5 testid gaps the failed brew run 25278580747 hit.

### `slowcook init from-prod`

Scaffold a perfect mock from the consumer's prod src/ tree. Encodes the 4-strategy taxonomy (A=verbatim / B=DI-seam / C2=server-mock / D=skip) as a deterministic file classifier.

`--dry-run` prints the per-file strategy plan; full run emits the mock/ skeleton with `@slowcook-mock-from` provenance markers.

Smoke-tested on rewo: 83 src files → 59 A · 13 B · 10 C2 · 1 D. Matches the hand-built mock/LESSONS.md classification ratios.

What 0.18.1+ will automate (currently still hand-finished after this scaffold):
- per-table fixture handlers from supabase/migrations/
- per-endpoint api-client functions from fetch call sites
- mock/package.json + next.config + tsconfig boilerplate

### Tests

532 cli tests pass (was 521). +11 across recon (5) + from-prod (6).

---

## 0.17.0-alpha.0 — refine becomes history-aware (the leverage point)

Cut 2026-05-03. First release in the 0.17 brownfield-pipeline line. Plan doc: `docs/plans/0.17-brownfield-pipeline.md`. Memory: `feedback_refine_is_leverage_point` + `project_perfect_mock_taxonomy`.

### What changed

Five agent prompts now read a single auto-generated source of truth: `.brewing/history-index.json`. Refine emits it; vibe + testgen + plate + brew read it.

| Agent | Change | What it prevents |
|---|---|---|
| **refine** (cli + llm-anthropic) | Emits history-index.json before LLM runs; prompt requires brownfield-conflict Q&A anchored on the index | Underspec'd brownfield collisions cascading downstream |
| **vibe** (llm-anthropic) | Naming-discipline section: extend existing components by name, never invent parallels like `XWithFeature` | The PR #147 `MemberReactionsWithPins` vs `MemberReactionsPage` divergence |
| **testgen** (llm-anthropic) | Use existing component names + prop signatures + test helpers; default to MODIFY existing tests when surface is shared | Inventing `MyXList` + new mocking idioms (`x-test-viewer`) when prod has its own |
| **plate** (llm-anthropic) | Same naming rules as vibe; surfaces `<component_change_request>` block instead of silently introducing parallel files | Plate amendments compounding vibe's name divergence |
| **brew** (llm-anthropic) | Existence-check section: call `find_handler` first; ALTER TABLE not CREATE TABLE; never duplicate migrations | The "brew almost wrote duplicate `00031_bookmarks.sql` next to existing `00018_*`" failure |

### Why this is the leverage point

7-agent simulation on /me/bookmarks (rewo `mock-perfect/.pipeline-bookmarks/`) traced every divergence/stuck point back to refine missing brownfield context. The fix isn't "harden each downstream agent"; it's "give refine + downstream agents the same single-source-of-truth so they CAN'T diverge."

Empirical evidence from the 7-agent run: 7 naming/structural divergences between vibe + testgen, all preventable with refine emitting the right history index ahead of time.

### Files

- `packages/cli/src/commands/refine/history-index.ts` — NEW (pure-deterministic scanner; 350 lines)
- `packages/cli/src/commands/refine/history-index.test.ts` — NEW (7 cases)
- `packages/cli/src/commands/refine/context.ts` — adds `readHistoryIndexDigest` block
- `packages/cli/src/commands/refine/index.ts` — emits history-index.json before agent runs (issue + resubmit paths)
- `packages/llm-anthropic/src/prompts/refine.ts` — new "Code history index" + brownfield Q&A discipline section
- `packages/llm-anthropic/src/prompts/vibe.ts` — naming-discipline section
- `packages/llm-anthropic/src/prompts/testgen.ts` — naming + idiom + modify-existing rules
- `packages/llm-anthropic/src/prompts/plate.ts` — naming-discipline section + component_change_request escape
- `packages/llm-anthropic/src/prompts/brew.ts` — existence-check section before write_file

### Next in 0.17

- 0.17.6 — recon command (NEW): structural backstop after refine + history-aware downstream
- 0.17.7 — refactor command (NEW): cost/benefit-per-proposal + codebase scope
- 0.18.0 — mocking agent: `slowcook init --from-prod` (the perfect-mock generator)
- 0.19.0 — drift detection: `slowcook check-mock-drift`

### Tests

521 cli tests pass (was 514, +7 for history-index). 

### Versions

- cli: 0.17.0-alpha.0
- llm-anthropic: 0.13.0 (prompt changes)

---

## 0.16.0-alpha.30 — halt-XML parser: agent's diagnosis becomes the halt classification

Cut 2026-05-03. Brew's plate-mode prompt instructs the agent to halt by emitting `<halt class="X">...</halt>` in its text. Without this parser, brew never reads its own agent's halt envelopes — the agent's perfect classification falls through to the generic `AGENT_STALLED_NO_EDITS` because brew only counts tool calls.

### Trigger

Rewo PR #147 brew run 25278580747 (α.29): agent emitted a textbook MOCKUP_DESIGN_CONFLICT envelope:

\`\`\`xml
<halt class="MOCKUP_DESIGN_CONFLICT">
  <test>tests/integration/story-017-ui.test.tsx > "owner clicks Pin"</test>
  <conflict>The test imports MemberReactionsPage but vibe ported MemberReactionsWithPins...</conflict>
</halt>
\`\`\`

Brew reported `AGENT_STALLED_NO_EDITS`. $0.91 wasted on the misclassification — the agent did its job; brew didn't listen.

### Fix

`parseHaltEnvelope(rationale)` — scans agent text for `<halt class="X">...</halt>`, validates `X` is in a recognised whitelist, extracts `<conflict>` body (or falls back to inner text). Called inside the no-edits branch BEFORE the consecutive-no-edits stall check.

Recognised classes: `MOCKUP_DESIGN_CONFLICT`, `SPEC_AMBIGUITY_DETECTED` (NEW), `TEST_RUNNER_BROKEN`, `AGENT_SELF_REPORTED_STUCK`.

### New halt class

`SPEC_AMBIGUITY_DETECTED` is now in the `HaltReason` union (was only in the prompt). The mock + the test interpreted the spec's `ui_behavior` differently (e.g., test queries "Pinned"; mock renders "Saved"); both readings defensible. PM picks one + /refine.

### Behaviour matrix

| Agent state | Old | New |
|---|---|---|
| Tool calls × N | normal iter | normal iter |
| Zero tool calls, no envelope, ≥2 consecutive | `AGENT_STALLED_NO_EDITS` | `AGENT_STALLED_NO_EDITS` |
| Zero tool calls, **valid envelope** | `AGENT_STALLED_NO_EDITS` (wrong) | **`<class from envelope>`** |
| Zero tool calls, "Considering halting voluntarily" in rationale | `AGENT_SELF_REPORTED_STUCK` | `AGENT_SELF_REPORTED_STUCK` |

### Files

- `packages/cli/src/commands/brew/agent.ts` — add `parseHaltEnvelope` helper; wire into the no-edits branch
- `packages/cli/src/commands/brew/halt.ts` — add `SPEC_AMBIGUITY_DETECTED` to `HaltReason` + suggested actions
- `packages/cli/src/commands/brew/agent.test.ts` — 7 cases covering the parser

### Architectural rhyme

α.27 → port resolves collisions itself
α.28 → brew degrades unrunnable suites
α.29 → plate-mode lets brew wire data into ported files
α.30 → brew listens to the agent's diagnosis instead of generic-halting

Each release closes one "harness off-loads its own friction to the operator" gap.

---

## 0.16.0-alpha.29 — plate-mode contract: preserve UI shape, swap mock data for real data (cli + llm-anthropic@0.12.4)

Cut 2026-05-03. User feedback: "'don't touch the UI' is very hard promise to keep, we should say 'don't touch the UI shape, and for behaviours, only replace real data instead of mock data'."

### Trigger

Rewo PR #147 brew run 25278045422 halted `AGENT_STALLED_NO_EDITS` after 7 iters / $1.82. The agent correctly diagnosed it needed to wire `POST /api/pins` — but the click handler that should make that call lives inside the ported component (`@slowcook-port-from`-marked). Old plate-mode rejected ALL writes to port-marked files, including handler bodies. Result: 5 REJECTs in a row + 2 NO-EDITS → halt with no progress.

### New contract

| Aspect | Old (α.9–α.28) | New (α.29) |
|---|---|---|
| `@slowcook-port-from`-marked files | **Hard reject** all writes | **Allowed** (handler bodies, hooks, fetch — preserve JSX shape) |
| `src/components/*` without marker | Hard reject | Hard reject (consumer's hand-written prod UI) |
| `src/*.tsx` without marker | Hard reject | Hard reject |
| `.mock.ts` files | Hard reject | Hard reject (no behavior to wire) |
| `mock/*` | Hard reject | Hard reject |

The marker check is now an **allow signal**, not a deny signal. Brew can edit handlers + hooks inside the file vibe ported (which is exactly the file the test imports from). Tier-2 acceptance + visual regression are the backstop for shape drift.

### Prompt rewrite

`BREW_PLATE_MODE_ADDENDUM` reframed around the two-part rule:

1. **Preserve the UI shape** — JSX structure, props signature, className, layout
2. **Swap mock data for real data** — handler bodies + hooks edit-allowed inside port-marked files

Includes a new escape-hatch hint: when the test imports a path without the marker, that's a vibe/recipe drift — halt with `MOCKUP_DESIGN_CONFLICT` and call out the name mismatch (instead of stalling).

### Files

- `packages/cli/src/commands/brew/agent.ts` — flip the marker check from reject to allow
- `packages/llm-anthropic/src/prompts/brew.ts` — rewrite plate-mode addendum (bumps llm-anthropic to 0.12.4)

### Why this matters

Same architectural rhyme as α.27 + α.28: harness resolves its own friction instead of off-loading it to the operator. α.27 made port skip collisions. α.28 made brew degrade unrunnable suites. α.29 lets brew wire data into the component vibe ported — the natural place that wiring lives.

---

## 0.16.0-alpha.28 — brew auto-degrades when one suite can't boot

Cut 2026-05-03. Follow-up to α.27 — same shape, different surface: brew should resolve "one suite is unrunnable in this environment" by proceeding with the suite that DID run, not by halting `TEST_RUNNER_BROKEN`.

### Trigger

Rewo brew --mode plate dispatched on the Contabo runner; baseline acceptance suite (`ACCEPTANCE=1 npx playwright test`) booted Next as a webServer; Next crashed at the Supabase client step because `.env.acceptance` wasn't written (no acceptance creds in the rewo CI). Backend vitest suite passed fine and produced 24 tests, but stack-ts returned `ran: false` because the playwright suite errored — and brew halted at iteration 0 with $0 spent.

### Behavior change

Per-suite degradation: if `runTests` returns `ran: false` but `tests.length > 0`, brew now logs a `BASELINE_DEGRADED` notice + proceeds with the surviving tests. Same for the per-iter mid-brew run.

| Run state | Old | New |
|---|---|---|
| All suites OK | continue | continue |
| All suites failed (zero tests) | HALT TEST_RUNNER_BROKEN | HALT TEST_RUNNER_BROKEN |
| Some suites failed (some tests) | **HALT TEST_RUNNER_BROKEN** | **DEGRADE — proceed with surviving tests** |

### Architectural rhyme with α.27

Both releases follow the same principle: the agent should resolve its own friction instead of asking the operator to hand-fix CI.

- α.27: port resolves destination collisions (skip-with-notice, not abort)
- α.28: brew resolves per-suite boot failures (degrade-with-notice, not abort)

In both cases the operator's "hand fix" was a one-line CI patch — a smell that the harness was off-loading its own resilience to the consumer.

### What's still on the operator

If the entire test runner is unrunnable (zero tests at all from any suite), brew still halts. That's a real "fix it before brewing" signal.

### Files

- `packages/cli/src/commands/brew/agent.ts` — degrade-on-partial logic in baseline + per-iter halt paths

---

## 0.16.0-alpha.27 — port resolves conflicts itself (no abort, no hardcoded shell list)

Cut 2026-05-03. Follow-up to α.26's hardcoded layout/page/globals.css exclusions. User feedback: "when there is a port conflict, port should be able to resolve it, not you hand fix it."

α.26 fixed the brew failure but kept piling up file-name checks. The right shape is for port to **never abort on a destination collision** and to **never need a hardcoded shell list** — collisions resolve themselves at write-time.

### Behavior change

| Destination state | α.26 | α.27 |
|---|---|---|
| Missing | CREATE | CREATE |
| Has `@slowcook-port-from` marker | UPDATE | UPDATE |
| Identical to our output | NO-OP | NO-OP |
| Hand-written (no marker) | **BLOCK + exit 2** unless `--force` | **SKIP with notice** unless `--force` |

The hand-written file is the consumer's source of truth. Port now silently leaves it alone with a console notice and continues with the rest of the files. `--force` still overwrites if the consumer truly wants the mock version.

### File-level opt-out marker

New `@slowcook-port-skip` marker — when present in the first 20 lines of a mock file, port walks past it without writing anything to src/. Use this for mock-only shims (e.g. `mock/src/lib/mock-emotions.ts` band-aid for pre-α.12 vibe output).

### Removed

Hardcoded exclusions for `mock/src/app/{layout,page,globals.css}` are gone — they're handled by the generic skip-on-collision rule (consumer's real shell exists at the destination, no marker → skipped).

### Net win

- Port no longer aborts the brew workflow on a non-issue
- Consumer doesn't need to know which mock-shell files port hardcodes
- Consumer can mark any mock-only file with `@slowcook-port-skip` without touching slowcook
- Same-day rewo fix: tag `mock/src/lib/mock-emotions.ts` band-aid with the marker; remove ad-hoc exclusion thinking from the architecture

### Files

- `packages/cli/src/commands/port/transform.ts` — drop layout/page/globals.css exclusions; add `isMockOnlyFile`
- `packages/cli/src/commands/port/index.ts` — `BLOCKED` → `skip-handwritten` / `skip-mock-only` action kinds; no exit 2; updated help + summary
- `packages/cli/src/commands/port/transform.test.ts` — replace shell-exclusion test with collision-resolved-at-write-time + `isMockOnlyFile` cases

---

## 0.16.0-alpha.26 — port skips mock-app-shell scaffolds (layout / page / globals.css)

Cut 2026-05-03. First end-to-end brew --mode plate run on rewo (manual dispatch since brew-auto's branch-name bug also bit) failed at the port step with: "Refusing to port: 2 file(s) at the destination path don't carry the @slowcook-port-from marker." Port correctly refused to overwrite rewo's REAL `src/app/layout.tsx` + `src/lib/emotions/index.ts` — exactly the safety check the architecture is designed for. But it shouldn't have tried these in the first place — they're mock-app-shell files, not story-specific UI.

### Fix

Extended `mockPathToSrcPath`'s exclusion list:

| File | Why excluded |
|---|---|
| `mock/src/app/layout.tsx` | Mounts ScenarioRegistryProvider + SlowcookReviewOverlay. Mock-shell only; consumer's prod layout is THEIR app shell. |
| `mock/src/app/page.tsx` | Picker UI (homepage); consumer's prod homepage is theirs. |
| `mock/src/app/globals.css` | Mock's tailwind directives + tokens copy. |

Already excluded (unchanged):

| File | Why |
|---|---|
| `mock/scenarios/*.ts` | Scenario fixtures — mock-only. |
| `mock/src/lib/scenario-registry.ts` | Consumer-managed registry. |

Nested app routes still port (e.g., `mock/src/app/u/[handle]/page.tsx` → `src/app/u/[handle]/page.tsx`) — those ARE the story-specific UI brew amends.

### Tests

- 16 port-transform tests pass (was 14; +2 covering the new exclusions and nested-route preservation).
- 503 cli tests total.

### Publish state

```
cli@0.16.0-alpha.26           🟡 in-repo
```

### Status of dogfood iter 9 (rewo PR #147 → brew)

- ✅ PR #147 merged 2026-05-03 10:18
- ❌ brew-auto didn't dispatch (branch-name bug → fixed in forge-github@0.11.5; needs publish)
- ❌ manual brew dispatch failed at port step (mock-app-shell files → fixed in cli@α.26; needs publish)
- ⏸ once both publish + rewo bumps to α.26, re-dispatch brew. Cumulative dogfood spend so far: $11.83 across 18 runs (vibe + plate + refine + testgen + earlier brew attempts on the issue).

---

## @slowcook-ai/forge-github@0.11.5 — brew-auto looks up tests PR by title+label, not branch

Cut 2026-05-03. Critical bug caught after merging rewo PR #147: brew-auto's gate logic looked for the tests PR at hardcoded `slowcook/tests/story-N` branch, but recipe/testgen actually creates tests PRs on `slowcook/tests/batch-{timestamp}` branches. Result: brew-auto incorrectly said "waiting for tests PR" even though the tests PR for story-017 was merged 7 days ago. Brew never fired.

### Fix

Replaced branch-based search with title-and-label intersection:

```bash
# was:
gh pr list --head "slowcook/tests/story-$id" --state merged

# now:
gh pr list --label "slowcook-tests" --state merged --json number,title \
  --jq "[.[] | select(.title | contains(\"story-$id\"))] | length"
```

Tests PRs always carry the `slowcook-tests` label + a title containing `story-N` (per recipe's emit conventions); the intersection is robust to branch-naming variation. Same fix applied to the backend-only-detection lookup (any-mockup-PR check).

### Publish state

```
forge-github@0.11.5           🟡 in-repo (brew-auto title+label search)
```

---

## 0.16.0-alpha.25 + @slowcook-ai/forge-github@0.11.4 — itemised cost rollup + preview-deploy graceful-skip

Cut 2026-05-03. User feedback on the iter-9 rollup: "only counted plate runs, four times — each plate run should have mentioned separately btw, with link to the diff if possible. how about ref, testgen and ref runs?" Real gaps:

1. The α.23 rollup walked only the mockup PR's comments — refine + recipe/testgen runs that lived on the issue / spec PR / tests PR were uncounted.
2. Grouped by agent → couldn't see individual run costs or link to diffs.

### Refactor

- `findRelatedPrs(owner, repo, storyId)` — searches `repo:owner/repo is:pr in:title story-{id}` to find every spec / tests / mockup / brew PR for the story in one query.
- Walks **all sources**: source issue body + comments + every related PR's body + comments.
- **Itemises every cost marker** (one row per run) with: `#`, timestamp, agent, model, source link, $, diff link.
- **Diff link** parsed from plate's breadcrumb JSON (`amendment_commit` field). Plate runs link to their commit on GitHub; non-plate runs show `—`.
- **Idempotent update** — looks for the existing `slowcook:on-mockup-approved` marker on the source issue; updates that comment in place. Re-running gives a fresh state, never double-spams.
- **Vibe-prose fallback** for legacy `Generated by ... (spend $X.XXXX)` text in pre-α.24 vibe PR bodies. Catches dogfood spend that would otherwise be invisible.

### Tested live on rewo issue #138

- α.23 version: 4 plate runs / $3.18 total (only mockup PR walked)
- α.25 version: 18 runs / $11.83 total — refine ($2.30 / 6 runs), testgen ($2.13 / 2), brew ($1.62 / 2), plate ($4.05 / 6), vibe ($1.74 / 2)

### Bonus fix bundled (forge-github@0.11.4)

`slowcook-preview-deploy.yml`'s "Stage SSH private key" step previously failed the PR check with `::error::` + `exit 1` when `SLOWCOOK_PREVIEW_SSH_KEY` wasn't set. Many consumers (incl. rewo dogfood) run `slowcook run-mock` locally instead of SSH-deploying to their own box; failing the check on a missing secret was hostile UX. Now it emits `::notice::` + `exit 0` and skips the deploy step. Consumers who DID intend to set up preview-deploy still see the warning visibly in workflow logs.

### Publish state

```
forge-github@0.11.4           🟡 in-repo (preview-deploy graceful-skip)
cli@0.16.0-alpha.25           🟡 in-repo (on-mockup-approved itemised rollup)
```

The deprecation warning on `octokit.rest.search.issuesAndPullRequests()` is non-fatal; the new `searchIssues` endpoint will land in a future patch when octokit's typed bindings catch up.

---

## 0.16.0-alpha.24 — vibe emits cost marker

Cut 2026-05-03. Caught at the first on-mockup-approved cost-rollup on rewo issue #138: the rollup table showed only plate's $3.18 across 4 runs — vibe's initial $0.88 was missing. Vibe was emitting cost as prose ("Generated by `slowcook vibe@…` (spend $0.8791)") but never the structured `<!-- slowcook:cost -->` marker that plate uses + on-mockup-approved parses.

Fix: vibe's PR body now appends `<!-- slowcook:cost agent=vibe usd=X model=Y cli=Z -->` (same shape as plate's marker). Future rollups will sum vibe + every plate run for the canonical total.

### Publish state

```
cli@0.16.0-alpha.24           🟡 in-repo
```

---

## 0.16.0-alpha.23 + @slowcook-ai/forge-github@0.11.3 — mockup PRs link issues + on-mockup-approved cost-rollup

Cut 2026-05-03. Two iter-9 dogfood asks: humans track work via GitHub issues; "story-17" alone in a PR title doesn't help anyone find the issue that originated it.

### vibe (cli@α.23) — `Closes #N` in mockup PR

- New `parseSourceIssueNumber(specYaml)` extracts `source_issue: "#138"` from the spec.
- Mockup PR body now starts with `Closes #138` so GitHub auto-links bidirectionally + auto-closes the issue when the PR merges.
- PR title also gets the issue ref appended: `mockup: story-017 (#138)`.
- Plate amendments don't need this — they comment on the existing PR thread which already carries the link.

### NEW `slowcook on-mockup-approved` (cli@α.23)

CLI subcommand triggered by a workflow on `pull_request.labeled` with `slowcook-mockup-approved`. Walks the mockup PR's comment thread, extracts every `<!-- slowcook:cost agent=X usd=Y ... -->` marker (vibe's initial emit + every plate amendment), groups by agent, sums total, posts an audit comment on the source issue:

```
### slowcook · mockup approved (story-017)

Mockup PR #147 signed off; slowcook-mockup-approved label applied.
Plate refuses further amendments. Next: merge the PR to fire
brew --mode plate (once recipe-tests PR is also merged).

#### Spend so far on this story

| Agent | Runs |     $ |
|-------|-----:|------:|
| plate |    4 | 2.92 |
| vibe  |    1 | 0.88 |
| Total |    5 | 3.80 |

Post-merge brew run will add its own cost line; the on-brew-merged
comment will fire when that lands.
```

### NEW workflow `slowcook-mockup-approved.yml` (forge-github@0.11.3)

Fires on `pull_request: [labeled]` when the label === `slowcook-mockup-approved` AND PR carries `slowcook-mockup`. Calls `slowcook on-mockup-approved --pr N`. Sister to slowcook-spec-merged / slowcook-tests-merged / slowcook-brew-merged so the issue thread tells the full pipeline story end-to-end.

### Tests

- 501 cli tests still pass.
- New on-mockup-approved subcommand needs an integration test against a mock GitHub API; queued for α.24 (the cost-marker regex is exercised by manual review of the live PR #147 thread).

### Publish state

```
forge-github@0.11.3           🟡 in-repo (slowcook-mockup-approved.yml)
cli@0.16.0-alpha.23           🟡 in-repo (vibe Closes-N + on-mockup-approved subcommand)
```

---

## 0.16.0-alpha.22 + @slowcook-ai/mock-runtime@0.3.3 — mobile-responsive APPROVED + run-mock auto-update slowcook deps

Cut 2026-05-03. Two iter-8 dogfood findings:

1. **Mobile scenario cards still tight** even after the corner-ribbon fix. Reserving 96px on the right of the name took the name's available width on a 390px viewport down to ~258px → long story names wrapped to 4 lines.
2. **`npm install` honors the lockfile** when present, so caret pins like `^0.5.1` keep installing the OLD resolved version (0.5.1) even after 0.5.3 publishes. Carets only re-resolve on a fresh dep tree. Consumers had to manually `npm update` to pick up new patches.

### mock-runtime@0.3.3 — responsive APPROVED placement

- Added `isMobile` matchMedia gate (`max-width: 640px`).
- **Desktop**: APPROVED ribbon stays in the top-right corner; name reserves 96px paddingRight.
- **Mobile**: APPROVED renders as its own row above the name (block-level); name flows full-width, no paddingRight reservation.

### cli α.22 — run-mock auto-`npm update`

After `npm install` in `mock/`, run-mock now runs `npm update --silent @slowcook-ai/mock-runtime @slowcook-ai/review-overlay`. This re-resolves the carets against the latest published versions, refreshing the lockfile.

- Best-effort — failure logs a non-fatal warning.
- Eliminates the lockfile-pin-staleness wall every consumer would otherwise hit on every new patch publish.
- `--skip-install` skips both install AND update.

### Publish state

```
mock-runtime@0.3.3            🟡 in-repo (mobile-responsive APPROVED)
cli@0.16.0-alpha.22           🟡 in-repo (run-mock auto-npm-update)
```

---

## @slowcook-ai/mock-runtime@0.3.2 — scenario card top-row layout fix

Cut 2026-05-03. Visual: the APPROVED badge was rendered inline next to the scenario name + the story-id metadata was on the same row, so the three elements elbowed for horizontal space. The name wrapped to 4 lines unnecessarily; the badge sandwiched in awkwardly.

### Layout rework

- Card is now `position: relative`.
- **APPROVED ribbon goes to the top-right corner** (absolutely positioned). No longer competes with the name's flow.
- **Name takes the full content row** with `paddingRight: 96px` when approved (reserves space for the corner ribbon). Reads in 1–2 lines instead of 4.
- **Metadata gets its own row** below the name (`story-N · as handle`). Path stays on the next row.

Same color palette + tokens; pure layout change.

### Publish state

```
mock-runtime@0.3.2            🟡 in-repo
```

---

## @slowcook-ai/review-overlay@0.5.3 — rename "general comment" → "note" in user-facing strings

Cut 2026-05-03. Per dogfood feedback: "general comment" / "general note" was clunky for the un-anchored-comment concept. Renamed in the user-visible strings to **"note"** (with "page note" as the longer form).

| Old | New |
|---|---|
| `+ Add general note (no element anchor)` | `+ Add note (about the page, not an element)` |
| `Add general note` (composer header) | `Add page note` |
| `general note · no element anchor` (popover subtitle) | `page note · no element anchor` |
| `general` (list-panel badge) | `note` |
| `General note posted (#N)` (toast) | `Note posted (#N)` |

Internal code names (`submitGeneralComment`, `<GeneralComposer />`, `generalComposerOpen`, etc.) kept — pure churn to rename without UX benefit.

### Publish state

```
review-overlay@0.5.3          🟡 in-repo
```

---

## 0.16.0-alpha.21 + @slowcook-ai/review-overlay@0.5.2 — approve also submits PR review + run-mock auto-stashes

Cut 2026-05-03. Two real-bug fixes from dogfood:

1. ✅ Approve only applied the label + posted a comment — never submitted an actual GitHub PR review with `event: "APPROVE"`. PR header didn't show the green ✓ check PMs expect.
2. `slowcook run-mock` failed on a dirty working tree (every consumer hits this — Next reformats `tsconfig.json`, lockfiles drift, etc.).

### slowcook run-mock auto-stash (cli@α.21)

- Before the `git checkout <mockup-branch>` step, run-mock now runs `git status --porcelain`. If anything is dirty, it pushes a stash with `-u` (includes untracked) labeled `slowcook-run-mock auto-stash`.
- On clean shutdown (Ctrl-C OR dev-server exit), the stash is popped — working tree restored to pre-run-mock state.
- On checkout failure (e.g., merge conflict that even stash can't resolve), stash is popped before exit so the user's state is intact.

### review-overlay@0.5.2

- **`submitPrApproval`** new exported helper — POSTs to `/repos/{owner}/{repo}/pulls/{pr}/reviews` with `event: "APPROVE"` + body. Returns `{ ok, status?, message? }` so callers can handle GitHub's self-approval rejection gracefully.
- **`submitApproval` in the React overlay** now does three things in order, each degrading independently:
  1. Apply `slowcook-mockup-approved` label (the load-bearing signal plate reads — α.4.2)
  2. Submit PR review with `event: "APPROVE"` (the visible-on-PR-header signal — α.5.2)
  3. Post audit-trail comment summarizing what fired + what didn't
- The audit-trail comment now lists each step's outcome explicitly: `Label X applied; PR review submitted with event=APPROVE; comment #N`.
- The feedback toast in the overlay summarizes: `Approved · label applied · PR approved · comment #N`.

### Self-approval caveat

GitHub forbids approving your own PR by default. On bot-authored mockup PRs (the slowcook-vibe[bot] or slowcook-plate[bot] author), the human PAT-holder can approve cleanly. On hand-authored mockup PRs, the PR review fails — but the label + comment still mark intent + plate still respects the label refusal. The audit comment notes this when it happens.

### Tests

- 37 overlay + 501 cli tests still pass. The new helper is exercised through the existing submit-comment test patterns in github.test.ts (same mock-fetch shape).

### Publish state

```
review-overlay@0.5.2          🟡 in-repo
cli@0.16.0-alpha.21           🟡 in-repo
```

---

## 0.16.0-alpha.20 + @slowcook-ai/review-overlay@0.5.1 — overlay auto-detect + hydration-mismatch fix

Cut 2026-05-03. Two queue items addressed:

### Hydration mismatch (the dev-indicator "1 issue")

The overlay returned `null` during SSR but rendered content on first client render → React hydrator complained server HTML (no overlay) didn't match client HTML (overlay present). Plus `useState<TogglePosition>(loadTogglePosition)` read localStorage on first render — server returned default, client returned saved → second mismatch.

Fixes in review-overlay@0.5.1:

- **`mounted` gate**: `useEffect(() => setMounted(true), [])` runs only client-side after hydration; first client render returns null too (matching SSR), then a re-render shows the pill. Standard pattern.
- **Defer `loadTogglePosition` to a useEffect**: state initialises with the default `{ top: 12, right: 12 }`; localStorage read happens after mount, then `setPos` to the saved value.

### Overlay auto-detect props

The original overlay required all four mounting props (`owner`, `repo`, `prNumber`, `storyId` + `enabled`). Auto-detect from `process.env.NEXT_PUBLIC_SLOWCOOK_*` (Next inlines those at consumer build time) so consumers can write just `<SlowcookReviewOverlay />` and `slowcook run-mock`'s env exports populate the props automatically.

- All five props now optional with env-var fallbacks.
- Short-circuit return null when `owner / repo / prNumber` end up falsy (avoids silent failure on submit).
- `slowcook init mock` template's `layout.tsx` updated to the no-props form. Existing consumers can simplify their layouts on next refresh; old prop-explicit form keeps working.

### Tests

- 501 cli + 37 overlay tests still pass.
- payload.element=null path now exercised through the plate index's classifier feed (anchor preview switches to "general note (no element anchor)" when null).

### Publish state

```
review-overlay@0.5.1          🟡 in-repo
cli@0.16.0-alpha.20           🟡 in-repo (init-mock template + plate null-element handling)
```

### Items still in queue (deferred — not blocking dogfood)

- Localhost gh-proxy → no PAT prompts. ~2-3 hours; large enough to merit its own α.
- `slowcook run-mock` worktree isolation (don't mutate user's branch state). ~1 hour.
- 0.17 branding-logo distribution. Per [`docs/plans/0.17-branding-logo.md`](./docs/plans/0.17-branding-logo.md). Defer until 0.16 brew-mode-plate validates end-to-end.
- Backfill plate-reply breadcrumbs for pre-α.16 comments on existing PRs. User said skip unless it bites.

---

## 0.16.0-alpha.19 + @slowcook-ai/review-overlay@0.5.0 — comments-list panel + general (no-anchor) comments

Cut 2026-05-03. Two dogfood gaps from iter 5:

1. **Comments anchored to elements that get hidden become invisible.** When plate's amendment hides an element (e.g., the empty-state placeholder removed in iter 3), the pin layer can't anchor + the comment vanishes from the PM's view.
2. **Some comments aren't about a specific element.** General behavior asks ("show inline error on duplicate name") had no submission path — the overlay required clicking an element first.

### review-overlay@0.5.0

- **`payload.element` is now optional** (additive schema change; old payloads still parse). General comments persist with `element: null`.
- **`<CommentsListPanel />`** — new side drawer (right, 360px) reachable from a `📋` button in the pill (always visible; shows comment count badge). Surfaces ALL fetched comments regardless of element visibility. Each item shows status icon, prose snippet (3-line clamp), author, time, and a `anchored / hidden / drifted / general` badge.
- **Click a list item** → closes panel, opens the existing thread popover. If the comment is anchored to a visible element, the pin **flashes** (220ms scale + glow expansion) so the eye finds it; otherwise the popover renders with a "general note" or "drifted" indicator.
- **Hidden-element detection** in the pin layer: zero-area `getBoundingClientRect` OR `offsetParent === null` → treat like drifted (render at stored bbox with a `⚠ drifted` indicator). Avoids pins rendering at `(0,0)` on top of the page corner.
- **`<GeneralComposer />`** — new centered modal opened via `+ Add general note` at the top of the list panel. No element preview; just prose. Submits a payload with `element: null`.
- **`buildPayload({ selector?, bbox? })`** — both args now optional; passing neither produces a general-comment payload.
- **`formatReviewComment`** — renders `### Review note (general — no element anchor)` headline when `element === null`; existing element-anchored format unchanged.
- **Pin count badge** on the `📋` button uses the existing `comments` state.

### Tests

- 37 overlay tests still pass. The schema-flexibility (null element) is exercised by the existing `parseReviewComment` test set since the parser was kept additive.

### Publish state

```
review-overlay@0.5.0          🟡 in-repo
cli@0.16.0-alpha.19           🟡 in-repo (no behavioral change; bumped to track)
```

---

## 0.16.0-alpha.18 + @slowcook-ai/review-overlay@0.4.2 + @slowcook-ai/mock-runtime@0.3.1 — approval auto-applies label + visual cues

Cut 2026-05-03. Fixes a real-bug surfaced in dogfood iter 5: clicking ✅ Approve only POSTed an "asking for the label" comment; the label was never actually applied. PR #147 had 2 approval comments but no `slowcook-mockup-approved` label, so plate could still amend + the pill stayed un-greened.

### review-overlay@0.4.2

- **Approval click now applies the label** via `POST /repos/{owner}/{repo}/issues/{pr}/labels` using the same PAT. The comment still fires (audit trail), with body adapted to whether the label add succeeded.
- **`fetchPrLabels` + `addLabelsToPr`** new exported helpers in github.ts.
- **`isApproved` overlay state** wired from a label fetch on mount + on focus-refresh. Persisted across reloads via the existing comments cache flow (label fetch is a sibling request, both run together).
- **Pill renders green when approved**: dark-green background (`rgba(20, 83, 45, 0.92)`), brighter green border + glow shadow, `title` tooltip explaining the state.
- **Approve button replaced with `✓ Approved` pill segment** when isApproved is true. Nav + Comment toggles still work — comment thread stays open for follow-up notes; plate refuses to amend after the label lands (existing α.7 rule).
- **Optimistic state update** after a successful approval click flips the pill green immediately without waiting for the next focus refresh.

### mock-runtime@0.3.1

- **`ScenarioCommentStats.approved?: boolean`** added to the public type.
- **Approved-card visual treatment** in ScenarioPicker: green border (`rgba(34, 197, 94, 0.45)`), tinted green background (`rgba(34, 197, 94, 0.06)`), green-bleed hover state.
- **`✓ Approved` badge** rendered next to the scenario name (uppercase, green pill, prominent — first thing PM's eye lands on).

### review-overlay (data layer)

- **`fetchAllMockupPrs` returns labels** alongside `pr` + `storyId`.
- **`fetchScenarioStats` derives `approved`** per scenario by checking for `slowcook-mockup-approved` in the PR's labels. Sticky-OR across multiple PRs for the same story.
- New constant `APPROVED_LABEL = "slowcook-mockup-approved"` exported.

### Tests

- 501 cli tests still pass; 37 overlay; 9 mock-runtime.

### Publish state

```
review-overlay@0.4.2          🟡 in-repo
mock-runtime@0.3.1            🟡 in-repo
cli@0.16.0-alpha.18           🟡 in-repo (no behavioral change; bumped to track)
```

Next α.19 (already in-flight): comments-list panel + general-comment support (comments not anchored to a specific element). Two open dogfood gaps:
- Comments anchored to elements that get hidden (e.g., empty-state placeholder plate just removed) become invisible — need a list view.
- Some PM comments are about general behavior, not a specific element — need a no-anchor submission path.

---

## 0.16.0-alpha.17 — `slowcook run-mock <story>` (one-command launch + auto-pull on plate amendments)

Cut 2026-05-03. The first slice of the α.15-was-supposed-to-be UX critiques: collapses the manual `git fetch && git checkout && cd mock && npm install && env … npm run dev … wait … git pull` cycle to one command + a background poll loop.

### What it does

```bash
slowcook run-mock 017
```

1. Resolves story id → mockup branch (`slowcook/mockup/story-N`).
2. `git fetch origin <branch>` then `git checkout <branch>`.
3. `cd mock && npm install` (skip with `--skip-install`).
4. Spawns `npm run dev` (next dev :3100) as a child process.
5. **Background poll** every 15s: `git fetch origin <branch>` then if origin moved, `git pull --ff-only`. Next-dev's filesystem watcher hot-reloads automatically. Disable with `--no-poll`.
6. Ctrl-C cleans up both the dev server + the poll loop.

### Env auto-exported into the dev process

The overlay activates without any manual env-var setup:

- `NEXT_PUBLIC_SLOWCOOK_REVIEW=1`
- `NEXT_PUBLIC_SLOWCOOK_OWNER` + `_REPO` — detected from `git remote get-url origin`
- `NEXT_PUBLIC_SLOWCOOK_PR_NUMBER` — looked up via `gh pr list --head <branch> --state open`
- `NEXT_PUBLIC_SLOWCOOK_STORY_ID` — from arg

### On detection mechanism

GitHub doesn't push events to local processes. Compared:

- **Periodic `git fetch` + diff HEAD** ✅ chosen — ~1 net request / 15s, no auth, no rate-limit consumption, works offline-degraded.
- GitHub webhook → needs public endpoint (overkill for local dev).
- `gh api .../commits/<branch>` polling → consumes GH rate limit; same latency as git fetch but worse cost.
- Long-poll Actions events → only fires on workflow events; misses plate's force-push entirely.

### Out of scope (queued for follow-up alpha)

- Worktree isolation (don't change the user's branch state)
- Localhost gh-proxy (PAT prompt remains)
- Overlay auto-detect props inside the React component (env vars from run-mock cover this for the run-mock case; pure-mounted cases still need props)

### Tests

- 501 cli tests still pass. Smoke-test of run-mock itself is end-to-end-shaped (spawns subprocesses); deferred to a manual dogfood validation rather than synthetic test scaffolding.

### Publish state

```
cli@0.16.0-alpha.17           🟡 in-repo
```

---

## @slowcook-ai/review-overlay@0.4.1 — post-submit pin appears immediately

Cut 2026-05-03. UX papercut caught in dogfood iter 4: after submitting a comment via the composer, the new pin didn't appear in the pin layer until the user refreshed AND tab-switched back (which fired the `focus`-refresh listener).

Fix: optimistically push the just-submitted record into local `comments` state inside `submitFromComposer`'s success branch. Background-refresh on next focus catches up with the canonical state (incl. plate's eventual reply). Two-line change; no API surface impact.

### Publish state

```
review-overlay@0.4.1          🟡 in-repo
```

---

## 0.16.0-alpha.16 + @slowcook-ai/review-overlay@0.4.0 + @slowcook-ai/mock-runtime@0.3.0 — per-scenario comment stats on the picker

Cut 2026-05-03. Cards on the scenarios homepage now show comment / applied / unresolved / spec-altering / declined / noop counts so PMs can see at-a-glance which scenarios have outstanding feedback.

### review-overlay@0.4.0

- **`fetchAllMockupPrs`** — lists every PR in the repo with the `slowcook-mockup` label (open + closed), parses story ids from titles.
- **`fetchScenarioStats`** — per-scenario aggregation: walks every mockup PR's comments + groups by `payload.story_id`. Plate's breadcrumb (α.15) provides the status; absent breadcrumb counts as unresolved. One round-trip per PR + one for the listing; Promise.all parallelises.
- **`useScenarioCommentStats`** React hook — wraps the fetch + localStorage cache + focus-refresh. Returns `Record<scenarioId, ScenarioCommentStats>` or `null` until first hit. Doesn't prompt for PAT (picker is the wrong place for that interruption).
- localStorage cache key: `slowcook.review-overlay.scenario-stats.{owner}/{repo}`.

### mock-runtime@0.3.0

- **`ScenarioPicker` accepts `commentStats?: Record<string, ScenarioCommentStats>` prop**. Type re-exported as `ScenarioCommentStats` so consumers can pipe the hook's output through verbatim.
- New **`<CommentStatsRow />`** subcomponent renders per-card badges with the review-pill's color palette (green ✓ applied, coral ● unresolved, yellow ! spec-altering, gray ⊘ declined / · noop, gray 💬 total). Zero-valued categories hidden so the row stays tight on quiet scenarios.
- Stays UI-agnostic — no GitHub dependency. The hook lives in review-overlay; the picker just renders.

### cli@0.16.0-alpha.16

- **`slowcook init mock`** scaffolded `page.tsx` updated to wire `useScenarioCommentStats` by default. Existing consumers patch their `mock/src/app/page.tsx` to:

  ```tsx
  "use client";
  import { ScenarioPicker } from "@slowcook-ai/mock-runtime";
  import { useScenarioCommentStats } from "@slowcook-ai/review-overlay/react";

  export default function Page() {
    const stats = useScenarioCommentStats({
      owner: process.env["NEXT_PUBLIC_SLOWCOOK_OWNER"] ?? "",
      repo: process.env["NEXT_PUBLIC_SLOWCOOK_REPO"] ?? "",
      enabled: process.env["NEXT_PUBLIC_SLOWCOOK_REVIEW"] === "1",
    });
    return <ScenarioPicker commentStats={stats ?? undefined} />;
  }
  ```

### Architecture

- **mock-runtime stays GitHub-free.** The data hook lives in review-overlay; mock-runtime just renders the badges from a plain prop. Keeps mock-runtime's bundle minimal for consumers who don't use the overlay.
- **`payload.story_id` is the join key.** Every overlay payload carries the active scenario's id at submit time; aggregation is `{ story_id → counts }`. PR-title parsing is the fallback when the payload didn't carry the id (older payloads).

### Tests

- 501 cli + 37 review-overlay + 9 mock-runtime tests still pass.
- New regression coverage for `fetchScenarioStats` aggregation queued for α.17 (needs a fetch mock + GitHub fixture; deferred for the dogfood iteration).

### Publish state

```
mock-runtime@0.3.0            🟡 in-repo (commentStats prop + CommentStatsRow)
review-overlay@0.4.0          🟡 in-repo (stats hook + multi-PR aggregation)
cli@0.16.0-alpha.16           🟡 in-repo (init-mock page.tsx wires the hook)
```

---

## 0.16.0-alpha.15 + @slowcook-ai/review-overlay@0.3.0 — Figma-style anchored comment pins

Cut 2026-05-03. The review pill now shows previously-left comments as anchored pins (Figma-style) with status icons reflecting plate's reply, AND plate emits a structured breadcrumb so the pin layer correlates replies to comments by id (no timestamp heuristics).

### review-overlay@0.3.0

- **Mount-time fetch + cache** of overlay comments for the configured PR via `gh`-token-equivalent PAT. Cached in `localStorage["slowcook.review-overlay.comments.{owner}/{repo}/{pr}"]` so the pin layer renders instantly on refresh; background-refresh on `window.focus`. Failures degrade silently to cached state.
- **`fetchOverlayComments`** new exported function returning `OverlayCommentRecord[]` (one record per overlay comment with its parsed payload + correlated plate reply).
- **`resolveStoredSelector`** in selector.ts: 2-level cascade (primary → fallback), null when both miss. Used by the pin layer to anchor each comment to its live element.
- **`<CommentPins />`** React component (only visible in Comment mode):
  - For each fetched record, resolves selector to a live element and renders a 22px pin at the element's top-right.
  - Selector miss → renders at the stored bbox coordinates with a `⚠ drifted` indicator (yellow).
  - Status palette: 🔴💬 unresolved · 🟢✓ applied · ⚪⊘ declined · 🟡! spec-altering · ⚪• noop.
  - Re-renders every animation frame so pins follow scroll/reflow without lag.
  - Runtime `data-slowcook-comment-id="N"` attribute attached to anchored elements (debug aid; never persisted to disk; brew never sees the live DOM).
- **`<CommentThreadPopover />`**: clicking a pin opens a popover with: status badge, selector (monospace), author + timeAgo, original prose, plate's reply summary (when present, in a green-bordered card), and direct GitHub links to both the overlay comment and the plate reply.

### plate (cli@0.16.0-alpha.15) — breadcrumb emit

- **`PlateReplyPayload` JSON block** appended to every plate reply (escalation, no-op, byte-identical, success). One `PlateReplyEntry` per overlay comment plate processed in the run, with: `to_comment_id` (the originating overlay comment's GitHub id), `status` (one of `applied | declined | spec-altering | noop`), `summary` (≤200 chars), and `files_touched[]` (for the success path).
- Comment IDs threaded through the cli's processing path: `fetchTimelineComments` + `fetchInlineComments` now read + carry the GitHub `id` field; the agent prompts don't see ids (no signal-noise added to LLM context).
- Eliminates the timestamp-heuristic correlation — overlay reads the breadcrumb's `to_comment_id` for an O(1) lookup.

### Architectural choices (called out in the design discussion)

- **GitHub PR comments stay the source of truth** — no separate JSON/SQLite store. The PR has durability + auth + threading already; a separate store would need sync logic and would drift.
- **Element marking is runtime-only** — runtime `data-slowcook-comment-id` attribute via DOM API; never written to source. No `slowcook port` cleanup needed because brew operates on `src/` files, not the live DOM.
- **No source modification** for resolution stability — selector cascade + bbox-fallback handles drift.

### Tests

- 501 cli tests still pass. 37 overlay tests still pass.
- New regression coverage for `parsePlateReply` + `resolveStoredSelector` queued for α.16.

### Publish state

```
review-overlay@0.3.0          🟡 in-repo (pin layer + breadcrumb parser)
cli@0.16.0-alpha.15           🟡 in-repo (plate breadcrumb emit)
```

### What this enables for the dogfood

- Refresh `localhost:3100/u/amin?scenario=017`, toggle Comment mode → see your two prior comments as pins on the elements they targeted.
- The first one (the "Pin / Pinned → icon" comment that plate amended) gets a 🟢✓ applied pin; clicking shows your prose + plate's reply summary + links to both GitHub comments.
- The second one (the empty-state hide request, just posted) shows as 🔴💬 unresolved until plate fires again.

---

## @slowcook-ai/review-overlay@0.2.0 + @slowcook-ai/mock-runtime@0.2.0 — review-pill polish + ScenarioPicker structure

Cut 2026-05-03. Four UX critiques from the rewo dogfood addressed in the surfaces consumers actually look at.

### review-overlay@0.2.0 — the "review pill" (the floating Nav/Comment/Approve toggle)

- **Visible border**: 1px white-12% border + tighter inset shadow. Reads as a deliberate UI artifact rather than a floating glyph against varied page backgrounds.
- **Slowcook logo on the left**: inline SVG (slow-cook pot with steam wisps + lid + side handles). Single-color via `currentColor`; reads at 18px in the pill, scales clean to 32/64px for marketing surfaces.
- **Drag-to-move grip handle**: 6-dot vertical grip between logo and buttons. Pointer events (mouse + touch unified). Position persists in `localStorage["slowcook.review-overlay.toggle-pos"]` so PMs can park the pill where it doesn't overlap the UI they're reviewing.
- **Hidden on the picker route** (`pathname === "/"`): the homepage is for picking scenarios, not for review. Pill only appears on actual scenario pages.
- **Mobile collapse to icons-only** (`max-width: 640px`): "Nav" → 🧭, "💬 Comment" → 💬, "✅ Approve" → ✅. Tooltips (`title=`) keep the labels accessible on hover/long-press.
- **Two-step approve confirmation**: clicking ✅ Approve opens a small dialog with Cancel / ✅ Approve. Avoids fat-finger approval; the approval comment + label request only fires after the second click.

### mock-runtime@0.2.0 — ScenarioPicker structure

- **Branded header** with the slowcook logo + wordmark + tagline (`mock — design contract`) + a small `slowcook · mock` pill linking to GitHub.
- **Grid card layout** for scenarios (was a flat list): each card has a 1px border, hover state that bleeds in coral, and a clear story id / handle / path triplet.
- **Subtle background gradient** at top — radial coral wash so the page reads as branded, not bare.
- **Footer line**: scenario count + a one-liner about mock-data semantics.
- **Empty state** rewritten with proper visual hierarchy + matching card styling.
- All styling via inline `style={{}}` + CSS custom properties (`var(--card-bg, fallback)`, etc.) so the picker still works with the consumer's tokens and degrades cleanly when unset.

### Naming

The floating toggle is officially the **review pill** going forward (replaces ad-hoc terms like "floating thingy" / "ModeToggle").

### Tests

- 37 review-overlay tests still pass (selector / format / github — none cover the React component yet; queued for jsdom React Testing setup later).
- mock-runtime tests still pass (9 scenarios.test.ts).

### Publish state

```
review-overlay@0.2.0          🟡 in-repo (review-pill polish)
mock-runtime@0.2.0            🟡 in-repo (ScenarioPicker structure)
```

This is a stand-alone polish patch — independent of the α.14 plate fixes. Can publish either order. After both land, consumers re-`npm install` in `mock/` to pick up.

---

## 0.16.0-alpha.14 + @slowcook-ai/llm-anthropic@0.12.3 + @slowcook-ai/forge-github@0.11.2 — plate v2 fixes (rewo dogfood iter 3)

Cut 2026-05-03. Four plate-pipeline bugs caught when a real review-overlay comment fired the first end-to-end plate amendment on rewo PR #147.

### What dogfood validated working

- ✅ Overlay → POST → PR comment with structured `slowcook:review-overlay` JSON payload
- ✅ Classifier correctly tagged "I prefer an icon here" feedback as cosmetic ($0 — pure heuristic)
- ✅ Plate dispatched, called LLM ($0.52 Opus), generated an amendment
- ✅ Path-safety guard blocked the wrong-path write (architecture's two-filesystems rule firing as designed)

### What dogfood broke

1. **Plate's `listBranchFiles` loaded 0 mock files for context.** Used `git ls-tree -- mock/**/*.tsx` as a literal pathspec; git ls-tree doesn't expand `**` globs by default. With no context, the agent invented a new component name (`PinnedRewosStrip.tsx`) instead of amending the existing `PinnedStrip.tsx` it couldn't see.
2. **Plate's system prompt referenced `src/` paths** from 0.15-era code. Even if context had loaded, the agent's prompt steered it toward `src/components/` output. Path-safety guard caught it but failed the run.
3. **Plate's workflow trigger required `/plate` prefix.** Review-overlay comments don't have it; the user had to manually post `/plate process this` to fire plate. Defeats the overlay's "submit and forget" UX.
4. **No structural check for vibe's emit.** α.13 shipped `slowcook check mock-isolation` but it wasn't wired into vibe's workflow — bad emits still landed on PRs (consumers hit Build Error in browser instead of CI red).

### Fixes

- **`listBranchFiles` rewrite** (`packages/cli/src/commands/plate/index.ts`): drop the broken pathspec, list ALL files in the branch via `git ls-tree -r --name-only`, filter via the existing regex predicates in JS. Also added `mock/src/lib/**/*.tsx?` (was missing — vibe-emitted lib helpers weren't being loaded).
- **Plate prompt rewrite** (`packages/llm-anthropic/src/prompts/plate.ts`):
  - All `<file path>` examples now start with `mock/`. Old `src/components/...` examples removed.
  - New "Hard runtime rules — DO NOT BREAK THESE" section (5 rules): mock/-only paths; reuse existing component file names from the user message; no `.js` extensions; whitelist of seven mock-runtime exports; no `@/` cross-imports.
  - Self-check expanded from 6 → 11 items mirroring the new rules.
  - "Files plate may NOT touch" now lists `src/` (brew's after port) + non-vibe-shipped mock files (consumer's app shell).
- **Plate workflow trigger** (`packages/forge-github/src/templates.ts`):
  - Now also fires when a comment contains the `slowcook:review-overlay` marker — review-overlay submissions trigger plate automatically with no `/plate` prefix.
  - Added `workflow_dispatch` so an operator can rerun plate without comment-spam.
  - Trigger logic split into `(prefix-trigger OR marker-trigger)` per event type so both paths share the user-type / label gates.
- **Vibe workflow post-emit check** (`packages/forge-github/src/templates.ts`): after vibe pushes the mockup branch, the workflow checks out the branch + runs `slowcook check mock-isolation`. On violations, posts a ⚠️ comment on the PR explaining the failure and exits non-zero so the workflow shows red (PR red-flagged → PM doesn't merge a broken mockup).

### Tests

- 501 cli tests still pass (no test changes — plate's fixes are integration-shaped, exercised at workflow run time; new test coverage queued for α.15).

### Publish state

```
forge-github@0.11.2          🟡 in-repo (plate trigger + vibe post-emit check)
llm-anthropic@0.12.3         🟡 in-repo (plate prompt rewrite)
cli@0.16.0-alpha.14          🟡 in-repo (listBranchFiles fix)
```

Next: α.15 — the three UX critiques from the dogfood (overlay auto-detect, localhost gh-proxy, `slowcook run-mock <story>`).

---

## 0.16.0-alpha.13 — `slowcook check mock-isolation` (structural enforcement of mock-vs-prod separation)

Cut 2026-05-03. Hard-signal companion to α.12's vibe-prompt steering: a static check that fails CI when any file under `mock/` imports outside `mock/`. Catches vibe-prompt slippage that would otherwise only surface when a consumer tries to render the mockup in the browser.

### What's new

- **`slowcook check mock-isolation`** (`packages/cli/src/commands/check/`): walks every `.ts/.tsx` file under `mock/`, parses each `import` statement, validates:
  - `@/` imports resolve to a file inside `mock/src/` (NOT the consumer's production `src/`)
  - relative imports stay inside `mock/` (no `../../../src/...` escapes)
  - relative imports resolve to a real file (`.ts`/`.tsx`/`.js`/`.jsx`/`/index.*`)
  - npm imports allowed unconditionally (anything not starting with `.`, `/`, or `@/`)
  - absolute-path imports rejected (almost always wrong)
- Each violation reports `file:line`, the offending `importPath`, and a fix-oriented `reason` ("Inline what you need OR write a file at `mock/src/...`").
- Exit `0` clean / `1` violations / `0` no-mock-dir-yet.
- 10 unit tests in `mock-isolation.test.ts` covering: clean repo, empty repo, `@/` cross-ref violation (the rewo dogfood failure mode), `@/` legal resolution, parent-traversal escape, missing relative target, npm/scoped packages allowed, absolute-path rejected, multi-violation line numbers.

### Why a structural check + not just better prompts

α.12 added "Hard runtime rules" + "Self-check" items to vibe's prompt telling it not to cross-import. Prompts are soft signals — the LLM might comply 95% of the time. The 5% misses cost a consumer their first 30 minutes of dogfood (rewo, this morning). A check that runs in `slowcook-vibe.yml` post-emit (next minor) gives the architectural rule actual teeth: violating PRs fail CI.

For now the command is opt-in (`slowcook check mock-isolation`); next iteration wires it into `slowcook-vibe.yml` as a post-emit step + into a pre-commit hook for hand-edited mocks.

### Publish state

```
cli@0.16.0-alpha.13           🟡 in-repo (slowcook check mock-isolation)
```

Next: α.14 — three UX improvements caught in rewo dogfood:
1. Overlay auto-detect props (no manual env vars)
2. Localhost gh-proxy (no PAT prompts; uses `gh auth token` server-side)
3. `slowcook run-mock <story>` one-command UX (worktree-isolated; cleans up on exit)

Plus: wire `slowcook check mock-isolation` into `slowcook-vibe.yml` so violations fail vibe's PR rather than waiting until the consumer hits Build Error in the browser.

---

## 0.16.0-alpha.12 + @slowcook-ai/llm-anthropic@0.12.2 — vibe-prompt hardening (rewo dogfood iter 2)

Cut 2026-05-03. Three vibe-emit bugs caught when the first generated mockup (rewo PR #147 for story-017) tried to run in the browser:

1. **Vibe wrote `.js` extensions on TS imports.** `import story017 from "../../scenarios/story-017.js"` triggered a Build Error in Next/Turbopack — bundler module resolution doesn't auto-resolve `.js` → `.ts` like Node ESM does. Vibe prompt's example block used `.js` to mirror Node's convention; that was wrong for the mock app's stack.
2. **Vibe hallucinated `useScenarioUser` from `@slowcook-ai/mock-runtime`.** The package has never exported that hook. The right pattern is `const scenario = useScenario(); const user = scenario?.user;`. Hallucination probably came from "useScenarioFixture" being a real hook + the model generalising the naming.
3. **Vibe imported `@/lib/emotions` from `mock/src/components/`.** That alias resolves to `mock/src/lib/`, NOT the consumer's production `src/lib/`. The emotions module exists in the consumer's `src/`; the mock has its own filesystem with no cross-import path. Vibe should inline the constants OR write a fresh `mock/src/lib/<name>.ts`.

Fixes (in `vibe.ts` system prompt as a new "Hard runtime rules — DO NOT BREAK THESE" section):

- "NEVER use `.js` extensions in TypeScript imports." Examples corrected to extensionless.
- Whitelisted the seven `mock-runtime` exports vibe may use; explicit ban on inventing hooks like `useScenorioUser`. Right pattern for "active user" + "fixtures" spelled out.
- "DO NOT import from `@/` paths" unless the file lives inside `mock/`. If a consumer's prod helper is needed, INLINE it.
- "Use `next/link` for navigation, not `<a href>`" (defensive — caught while reviewing prompt; observed in some past rewo runs).
- Self-check list extended from 8 → 11 items mirroring the new rules.

Init-mock template README + scenario-registry comment also updated to drop the `.js` example (cosmetic but consistent with the new rule).

10 init/mock tests still pass. No new regression tests for the prompt rules — they're steering, not mechanical guards (would need an LLM-output evaluator to catch via tests).

### Why the vibe prompt is the right fix

These are pure prompt-steering bugs. Brew's heuristic guards (frozen-paths, marker-aware reject) protect the production filesystem; they don't apply to mock/. The mock has no compile-time enforcement of mock-runtime exports beyond TypeScript's own type-checker (which the agent satisfies by hallucinating the wrong types too). Hardening the prompt's hard rules + self-check list catches these at emit time so consumers don't hit them.

### Publish state

```
llm-anthropic@0.12.2          🟡 in-repo (vibe.ts hardened)
cli@0.16.0-alpha.12           🟡 in-repo (init-mock README cosmetic)
```

The vibe-emitted scenario-registry on rewo PR #147 was hand-patched (drop `.js`); the page.tsx + components still have bugs 2 + 3 unfixed in that branch. Those are dogfood waste but the prompt fix prevents a recurrence on the NEXT vibe run.

---

## 0.16.0-alpha.11 — `slowcook init mock` bug fixes (caught at first rewo dogfood)

Cut 2026-05-02. Two bugs caught immediately when running `init mock` on rewo for the first time:

1. **`mock/package.json` pinned `@slowcook-ai/mock-runtime` to `^0.1.1`** — but only `0.1.0` is published on npm. `npm install` would fail until `0.1.1` ships. Changed pin to `^0.1.0`; semver caret picks up patches when they publish.
2. **`mock/package.json#name` was the literal `${REPO_NAME}-mock`** — a placeholder that never got substituted (the source had `${"$"}{REPO_NAME}-mock` which renders as the literal string). npm rejects names with curly braces, so `npm install` would fail. Replaced with `detectMockPackageName()` that reads the parent `package.json#name`, strips any leading `@scope/`, and appends `-mock` (falls back to `slowcook-mock`).

Both bugs would have stopped any consumer cold on the first `cd mock && npm install`. The fix is mechanical — no spec changes, no workflow changes — just template-output corrections.

10 init/mock tests still pass (they assert structure, not these two specific values; adding regression assertions for them next session).

### Publish state

```
cli@0.16.0-alpha.11           🟡 in-repo (init-mock fix)
```

Next: actually run vibe end-to-end on rewo's story-017 once the publish queue clears + ANTHROPIC_API_KEY is available.

---

## 0.16.0-alpha.10 + @slowcook-ai/forge-github@0.11.1 — orchestration trigger chain

Cut 2026-04-26. **Final α before 0.16 cuts.**

Closes the pipeline: `slowcook-brew-auto.yml` now waits for BOTH the mockup PR AND the tests PR to be merged on main for the same `story-N` before dispatching brew. Operating-guide ships the consumer-side `slowcook-brew.yml` snippet with the mandatory `slowcook port` step for plate-mode.

### What's new

- **Updated `slowcook-brew-auto.yml`** (in `forge-github@0.11.1`):
  - Trigger expanded: fires on PR merged with EITHER `slowcook-tests` OR `slowcook-mockup` label.
  - For each story id from the merging PR's branch (preferred — unambiguous since branches are `slowcook/{kind}/story-N`) or title:
    1. Looks up the OTHER half by querying `gh pr list --state merged --head slowcook/{otherKind}/story-N`.
    2. Both halves merged → dispatches `slowcook-brew.yml` with `mode=plate`.
    3. Only tests merged + no mockup PR ever existed (`--state all` shows zero matches) → dispatches with `mode=legacy` (backend-only / non-UI story).
    4. Otherwise → posts a `::notice::Waiting for $OTHER_LABEL PR (branch ...) to merge before brew can fire for story-N` and exits cleanly. The next merge of the missing half re-fires this workflow, which finds both halves and dispatches.
  - Concurrency: keyed per-story so simultaneous merges don't double-fire.
- **Operating guide section "Brew workflow changes for 0.16"** (in `docs/operating-guide.md`): the consumer-maintained `slowcook-brew.yml` needs a new `mode` workflow_dispatch input + a conditional `slowcook port --story` step before brew when `mode=plate`. Snippet inline; older brew workflows silently ignore `mode` and run in their default mode (backwards-compatible — no consumer break, just no plate-mode benefits until the snippet is adopted).

### Why the gating logic

The 0.16 architecture has vibe + recipe running in parallel from spec-merge; both produce PRs that merge independently in arbitrary order. The PM might merge the mockup PR first (after PM approval via the review-overlay), or the tests PR first (when CI flips green). Brew can only fire once both arrived because:

- **Brew --mode plate needs the ported src/** (from the mockup) AND the **tier-1 tests** (from recipe).
- **Brew --mode legacy** is fine without a mockup, but only when there's no mockup track at all (vibe's eligibility gate skipped the spec — backend-only).

The auto-trigger handles both cases; the PM doesn't have to think about merge order.

### Architectural notes

- **Branch-name-first parsing** for story id extraction (vs title scan): branches are mechanically named (`slowcook/{spec,mockup,tests,brew}/story-N`); titles are LLM-authored prose and could plausibly mention multiple stories. Branch is canonical.
- **Closed-cleanly when waiting** — the auto-trigger writes a `::notice::` and returns success when the other half hasn't merged yet. Avoids GitHub Actions failure-noise spam in the merging PM's notifications.
- **Documentation, not template change, for slowcook-brew.yml**: that workflow is consumer-maintained today (it varies wildly by stack — install steps, secrets, etc.), so we ship the snippet rather than overwrite. Future work could add a `slowcook init brew-workflow` scaffold that generates a known-good shape.
- **No new tests**: the workflow YAML doesn't have unit-test infrastructure (would need an Actions runner to validate). End-to-end validation lands when a real consumer runs the new auto-trigger; rewo dogfood is the natural gate.

### Publish state

```
forge-github@0.11.1           🟡 in-repo (slowcook-brew-auto.yml replaced)
cli@0.16.0-alpha.10           🟡 in-repo
```

### 0.16 ARC at α.10 — what's the picture?

Ten alphas across four days. The architecture went from "data-layer seam in src/" (0.15 — abandoned) to "singular mock app + element-anchored review + deterministic port + brew --mode plate" (0.16). What's shipped:

| Α | Brings |
|---|---|
| α.1 | mock-runtime package + slowcook init mock |
| α.2 | Scenario types lifted to core |
| α.3 | BUG-F refine-synth fixes |
| α.4 | vibe v2 (writes mock/) + recipe-blind-to-mock testgen tweak |
| α.5 | SSH preview deploy + operating-guide.md |
| α.6 | review-overlay package (selector + comment + GitHub PAT) |
| α.7 | plate v2 (overlay parser + classifier + escalation) |
| α.8 | slowcook port (deterministic mock → src copy) |
| α.9 | brew --mode plate v2 (marker-aware reject + SPEC_AMBIGUITY halt) |
| α.10 | brew-auto gating + operating-guide brew-workflow snippet |

What's NOT yet validated end-to-end: a real rewo run. That's the next milestone — pick a small story and run it through refine → vibe ‖ recipe → preview deploy → PM review via overlay → plate amendment → mockup-merged + tests-merged → port → brew → served. Expected catches: the heuristic classifier's spec-altering false-positive rate (or false-negative — the dangerous one), the `mock_dir` Caddy proxy specifics, and brew's actual cost in plate-mode (target $0.50–$2 per story). Any of those would be a follow-up alpha; the architecture itself is now structurally correct.

---

## 0.16.0-alpha.9 + @slowcook-ai/llm-anthropic@0.12.1 — brew --mode plate v2 (post-port)

Cut 2026-04-26.

Tightens `brew --mode plate` for the post-α.8 world where the `src/` UI was deterministically copied from `mock/` by `slowcook port`. Brew now rejects edits to any file carrying the `@slowcook-port-from` marker (defense-in-depth alongside the path-based check), and the system prompt addendum names two distinct halt classes for tests-vs-UI mismatches.

### What's new

- **Marker-aware path protection** (`packages/cli/src/commands/brew/agent.ts`): the plate-mode reject check now reads each changed file's first 2 KB and bails if it sees `@slowcook-port-from`. Catches edits a future path regex might miss; survives renames + relocations of UI files. Fails open on read errors (path-based checks still run).
- **`SPEC_AMBIGUITY_DETECTED` halt class** (in `BREW_PLATE_MODE_ADDENDUM`): a new framing for "test queries `/Pinned/`; UI renders `Saved`" — both internally consistent (recipe wrote the test from spec; vibe wrote the UI from spec; they interpreted ambiguity differently). Distinct from `MOCKUP_DESIGN_CONFLICT`, which is "the UI shape itself doesn't render this affordance at all". Same XML shape; the difference is in framing the PM reads.
- **Plate-mode addendum rewritten** for the new architecture:
  - Explicit "ported via `slowcook port`" framing instead of "plate writes UI directly".
  - Names the `useDataDomain<T>("domain")` import as the brew-side body to fill (matches α.8's transform output).
  - "MUST NOT edit" list now includes "ANY file with the `@slowcook-port-from` marker" alongside the path-based `src/**/*.tsx` and `src/components/**`.
  - Forbids edits to anything under `mock/` (vibe + plate territory).
  - Two halt examples — MOCKUP_DESIGN_CONFLICT (Pin button missing entirely) vs SPEC_AMBIGUITY_DETECTED (label says "Saved" instead of "Pinned").

### Architectural notes

- **Why marker + path**: the path regexes are good enough today, but as the project layout evolves they could miss (e.g., a new `src/widgets/` directory). The marker is structural — it doesn't depend on the path naming convention staying constant. Cheap (<1ms per file head read) so it's worth keeping both.
- **Two halt classes, same shape**: the PM acts on the *recommendation* in the halt body, not the class name. Distinct names help the recommendation stay precise — "amend the spec OR /plate the UI" is different from "pick which spelling the spec means".
- **No new tests**: the change is in steering (prompt addendum) + a structural guard (marker check). The path-based reject already had test coverage in the existing brew agent tests; adding marker coverage would require simulating a full brew iteration, which is not unit-testable in this architecture. End-to-end validation lands when α.10 wires the pipeline + a real brew runs against rewo.

### Publish state

```
llm-anthropic@0.12.1          🟡 in-repo (BREW_PLATE_MODE_ADDENDUM rewritten)
cli@0.16.0-alpha.9            🟡 in-repo
```

Next: α.10 — orchestration trigger chain. `slowcook-mockup-merged.yml` (mirrors slowcook-spec-merged) + a both-merged trigger that fires `slowcook port` then brew once both the mockup PR and the recipe-tests PR are in.

---

## 0.16.0-alpha.8 — `slowcook port`: deterministic mock → src copy

Cut 2026-04-26.

The reconciliation step between vibe's mock and brew's production work. No LLM; same input → same output; auditable diff in the brew PR. Runs as a CI step before brew so brew's allowed-paths can shrink dramatically (UI shape becomes fixed at port time).

### What's new

- **`slowcook port --story <id>`** (`packages/cli/src/commands/port/`):
  - Walks `mock/src/components/` + `mock/src/app/` (recursive .ts/.tsx).
  - For each file, computes the destination via `mockPathToSrcPath`: `mock/src/<rest>` → `src/<rest>`. Excludes `mock/scenarios/`, `mock/src/lib/scenario-registry.ts`, anything outside `mock/src/`.
  - Applies the deterministic transforms in `transform.ts`:
    1. `import { useScenarioFixture } from "@slowcook-ai/mock-runtime"` → `import { useDataDomain } from "@/lib/data"`.
    2. `useScenarioFixture<T>("domain")` → `useDataDomain<T>("domain")` at every call site.
    3. Strip `// @slowcook-mock-only` markers.
    4. Prepend port-provenance header: `// @slowcook-port-from mock/ (story-N)` (placed AFTER `"use client";` if present).
  - Idempotent: re-running on a previously-ported file is a no-op.
  - Refuses to overwrite an existing `src/` file that does NOT carry the `@slowcook-port-from` marker (signals a hand-edited prod file). `--force` overrides.
  - `--dry-run` prints planned actions without writing.
  - Exit codes: `0` success / `2` blocked-conflict.
- **CLI dispatch + USAGE updated**: `slowcook port --story <id> [--cwd <path>] [--dry-run] [--force]`.

### What brew (--mode plate, α.9) inherits

Because port is deterministic + auditable + runs first:

- Brew's allowed-paths can be narrow: `src/lib/data/**`, `src/app/api/**`, `supabase/migrations/**`, `tests/**`. Frozen-paths guard rejects writes to `src/**/*.tsx` and `src/components/**` because port owns them.
- The placeholder import target `@/lib/data#useDataDomain` is brew's territory: brew writes the actual hook against the real Supabase data layer per spec's `api_contract` response shapes.
- The port-provenance header gives brew a clear "DO NOT TOUCH" signal in every UI file.

### Tests

- 14 new tests in `packages/cli/src/commands/port/transform.test.ts`:
  - `mockPathToSrcPath` — happy paths + every excluded shape (scenarios, registry, non-mock paths, mock subtrees outside `src/` like Dockerfile / package.json / README).
  - `transformForPort` — useScenarioFixture rewrite (import + call site); preserved sibling imports from mock-runtime; no-op on irrelevant files; mock-only marker stripping; port-provenance header insertion (with + without "use client"); idempotent on re-run; full integration (real mock component → ported src component, all 4 transforms firing).
- 491 cli tests pass total (was 477; +14).
- 528 across the workspace.

### Architectural notes

- **Why deterministic**: brew's reward function is "tests pass". If brew owned the UI port, every iteration could subtly redesign the component to make a test pass. With port being a string-rewrite step that runs once before brew, the UI shape is frozen at brew's start. Brew's only paths to green are: write better data layer / fix handler / add migration. That's the wiring problem brew is good at.
- **Why a stub `useDataDomain` rather than direct Supabase**: keeps the port transform regex-only. Brew writes the real `@/lib/data` body with the typed hook signature derived from the spec's `api_contract`. The port's output compiles against a stub barrel; brew fills it.
- **Block-on-conflict default**: catches the consumer's hand-merged production code before port silently overwrites it. The `@slowcook-port-from` marker is the bright line — files that have it are port-owned; files that don't are off-limits without `--force`.

### Publish state

```
cli@0.16.0-alpha.8            🟡 in-repo
```

Next: α.9 — brew --mode plate v2 with narrower allowed-paths (port-fronted), `SPEC_AMBIGUITY_DETECTED` halt class for tests-vs-rendered-DOM mismatch, no UI writes (frozen-paths guard rejects).

---

## 0.16.0-alpha.7 — plate v2: element-anchored comment classifier + escalation

Cut 2026-04-26.

Plate now consumes the structured review-overlay comments from α.6, classifies each as cosmetic / spec-altering / mock-divergence, and escalates spec-altering ones instead of silently amending the mock against them. Also moves plate's allowed-paths into the new mock/ filesystem (was src/), and refuses any amendment after the `slowcook-mockup-approved` label is set.

### What's new

- **Approval-label refusal**: plate exits 0 with a clear message when the PR carries `slowcook-mockup-approved`. PM removes the label to reopen iteration. Stops a stray `/plate` or review-overlay comment from bouncing a finalized mockup.
- **Review-overlay parsing**: each timeline comment is run through `parseReviewComment` (from `@slowcook-ai/review-overlay`). Hits become structured `{ payload, classification, rationale }` records; misses fall back to the existing prose-comment path.
- **Three-way classifier** (`packages/cli/src/commands/plate/classify.ts`):
  - **Spec-altering** — spec term + structural verb ("remove the pinned strip", "replace pinned with bookmarked"). Highest priority; ESCALATE rather than amend.
  - **Cosmetic** — any cosmetic word (color/padding/font/spacing/etc.), with or without a spec term, no structural verb. The PM is restyling a known element. Plate amends with min-diff.
  - **Mock-divergence** — spec terms with no structural verb and no styling cue. Likely "mock shows X but spec says Y". Plate amends to align mock to spec.
  - **Default fallthrough** is mock-divergence (rather than cosmetic) — false-positive cost is low; keeps the agent's LLM in the reasoning loop.
  - Heuristic is intentionally conservative on spec-altering to favor PM-confirm rounds over silent spec weakening.
- **Escalation reply** for each spec-altering comment: posts a structured PR comment naming the matched spec terms + the rationale + three-option resolution path (amend the spec via `/refine`; keep the spec via `/plate keep-spec`; confirm via `/plate confirm-spec-change` — the third lands in α.7.1).
- **Cosmetic + mock-divergence comments** are forwarded to the existing plate agent as `[cosmetic] selector \`#x\`: …` / `[mock-divergence] selector \`#y\`: …` prose with the classifier rationale appended in italic. Agent gets full context to decide the right amendment.
- **mock/-only allowed paths**: `listBranchFiles` now scans `mock/scenarios/story-*.ts`, `mock/src/lib/scenario-registry.ts`, `mock/src/components/**/*.tsx`, `mock/src/app/**/page.tsx`. The pre-0.16 `src/` patterns are gone — that filesystem is now brew + slowcook-port territory.

### Tests

- 14 new tests in `packages/cli/src/commands/plate/classify.test.ts` covering: spec-term extraction (acceptance / invariants / api_contract / ui_behavior), each classification rule with realistic story-017 prose, conservative escalation when cosmetic + structural verb collide, fallthrough behavior. Crystal example: "Replace pinned with bookmarked" → spec-altering; "background tint for the strip card" → cosmetic with spec-term context noted.
- 477 cli tests pass total (was 463; +14 classify).
- 537 across the workspace (cli 477 + review-overlay 37 + others).

### Architectural notes

- The classifier is **pure deterministic** (no LLM) at α.7. False-negatives on spec-altering would let plate silently weaken the spec — exactly the failure mode the architecture is designed to prevent — so the heuristic favors escalation. LLM-backed classifier is queued for α.7.1 if the heuristic shows real misses on rewo dogfood.
- The classifier feeds rationale into the agent's prose context for cosmetic/divergence comments. Plate's LLM still has the final amendment decision; the classifier adds a hint, not a hard gate.
- Escalation comments are NOT marked with the cost-rollup marker (no LLM spend); they're free informational posts.

### Publish state

```
review-overlay@0.1.0          🟡 in-repo (NEW since α.6)
cli@0.16.0-alpha.7            🟡 in-repo
```

Next: α.8 — `slowcook port`: deterministic CLI that copies new `mock/` components into `src/` before brew runs. No LLM; same input → same output; auditable diff.

---

## 0.16.0-alpha.6 + @slowcook-ai/review-overlay@0.1.0 — element-anchored review overlay

Cut 2026-04-26.

The PM-feedback surface for the mockup PR. Mounted into the consumer's mock app, it floats a Nav / 💬 Comment / ✅ Approve toggle; in Comment mode, clicking any element opens a sidebar where the PM types prose. On submit, a structured review-comment lands in the mockup PR — markdown for humans, JSON-payload-in-HTML-comment for plate to parse in α.7.

### What's new

- **NEW package `@slowcook-ai/review-overlay@0.1.0`**:
  - **Two entry points**: `/` (framework-free core — selector extraction, comment formatter, GitHub submit, PAT storage) and `/react` (the mounted overlay component).
  - **Selector strategy** in priority order: `id` (skipping React `useId`/Radix/Headless UI patterns) → `data-testid` → `role + accessible-name` (aria-label, aria-labelledby, `<label for>`, button/link textContent) → `tag.classes:nth-child(N)` (filtering Tailwind utilities + emotion `css-XXXX` + CSS-modules hashes) → XPath fallback. Always non-empty.
  - **Comment payload** carries: selector + fallback selector + strategy + tag + text hint + bbox; viewport (width/height/colorScheme/dpr); URL; user agent; timestamp; story id; prose. Marker `slowcook:review-overlay` lets plate find the JSON via grep.
  - **Approve mode** posts a comment requesting the `slowcook-mockup-approved` label; plate refuses to amend after the label lands so a stray comment doesn't bounce a finalized mockup.
  - **PAT storage** via `localStorage["slowcook.review-overlay.pat.{owner}/{repo}"]`. Per-repo scoping; first submit prompts; `clearPat()` for revocation.
  - **Submit** via direct `POST /repos/{owner}/{repo}/issues/{pr}/comments` (Mode A from the 0.13.1 design). Returns tagged result for per-failure-mode UI rendering. Mode B (consumer-hosted submit endpoint) deferred.
- **Preview-deploy env-var injection** (`cli@0.16.0-alpha.6`): `slowcook preview deploy` now writes `.env.production` in the mock dir before `docker build`, populating `NEXT_PUBLIC_SLOWCOOK_REVIEW=1` + `_OWNER` + `_REPO` + `_PR_NUMBER`. Next inlines `NEXT_PUBLIC_*` at build time so the overlay component's `enabled={...}` gate resolves to true in preview builds.
- **Mock-layout scaffold update** (`slowcook init mock`): the `mock/src/app/layout.tsx` placeholder comment now includes the actual import + JSX snippet for `<SlowcookReviewOverlay />`. Consumers opt in by uncommenting after `npm install @slowcook-ai/review-overlay` — production builds keep the env var unset and the overlay tree-shakes.

### Architectural notes

- **Bundle weight target met**: `/` core ~3 KB gz; `/react` overlay ~6 KB gz. No html2canvas (auto-screenshot deferred); α.6 captures bbox + selector + viewport, which is enough for plate to anchor + the PM can paste a screenshot manually.
- **Three-mode design** preserved from 0.13.1: Nav (default — pure pass-through), Comment (red-orange tint + crosshair-style click capture), Approve (green tint + one-click approval). ESC + the toggle exit any non-Nav mode.
- **Inline styles** (not Tailwind classes) on every visible element so the overlay renders correctly even in mock apps that strip unknown classes.

### Tests

- 37 new tests in `packages/review-overlay/src/`:
  - `comment-format.test.ts` (10): payload build + markdown render + parse round trip + payload-marker handling.
  - `github.test.ts` (10): PAT storage scoping + per-repo isolation; `submitComment` URL/headers/body shape; 401/500/network-error result tagging; apiBase override.
  - `selector.test.ts` (17): full priority cascade, React `useId`/Radix/Headless UI skip, Tailwind/emotion/CSS-modules class filtering, nth-child disambiguation, accessible-name fallbacks, XPath fallback, text-hint truncation/whitespace.
- 463 cli tests still green; 37 new in review-overlay; 500 total across the workspace.

### Publish state

```
review-overlay@0.1.0          🟡 in-repo (NEW package)
cli@0.16.0-alpha.6            🟡 in-repo
```

Next: α.7 — plate v2: parse the JSON payloads off the PR thread; classify each comment as cosmetic / spec-altering / mock-divergence; amend mock with min-diff for cosmetic; escalate spec-altering to PM for confirm; refuse all amendments after `slowcook-mockup-approved` lands.

---

## 0.16.0-alpha.5 + @slowcook-ai/forge-github@0.11.0 — SSH preview deploy CI

Cut 2026-04-26.

Closes the loop for the mockup-PR workflow: PMs no longer have to checkout the branch and `npm run dev` to review a vibe-generated mock. Slowcook ships the docker build remotely to the consumer's box, runs it on a free port, and posts the live URL back to the PR.

Slowcook stays **stateless** about hosting — each consumer provides their own SSH-reachable box (Docker engine + reverse proxy + wildcard cert). This release adds the CLI plumbing + workflow templates that talk to it; `docs/operating-guide.md` covers the box-side setup.

### What's new

- **`.brewing/preview.yaml` schema + parser** in the cli (no separate package; flat schema, hand-parsed). Required: `type: ssh`, `host`, `user`, `key_secret`, `url_template` (must contain `{port}`), `remote_root`. Optional: `port` (default 22), `port_range` (default `[4000, 4099]`), `mock_dir` (default `mock`).
- **`slowcook preview deploy --pr <n>`** — tar the local `mock/` dir → scp to `${remote_root}/pr-N/` → `docker build` remotely → allocate a free port from `port_range` via `ss -ltn` → `docker run -d --name slowcook-mock-pr-N --restart unless-stopped --label slowcook.pr=N -p $PORT:3100` → upsert a preview-URL comment on the PR (idempotent on re-deploy).
- **`slowcook preview teardown --pr <n>`** — `docker rm -f` the per-PR container, `rm -rf` the staging dir, mark the PR comment as torn-down. Idempotent. `--prune-image` also removes the per-PR image (default off so reopened PRs redeploy fast).
- **Workflow templates** (in `forge-github@0.11.0`):
  - `slowcook-preview-deploy.yml` — fires on `pull_request: [opened, reopened, synchronize, labeled]` for PRs with the `slowcook-mockup` label. Stages the SSH key from `secrets.SLOWCOOK_PREVIEW_SSH_KEY` into `~/.ssh/id_slowcook_preview`, then runs `slowcook preview deploy --pr $PR_NUMBER`.
  - `slowcook-preview-teardown.yml` — fires on `pull_request: [closed]`. Optional `prune_image` workflow_dispatch input.
  - Both keyed on `concurrency: slowcook-preview-${pr}` so each push supersedes the prior deploy.
- **`docs/operating-guide.md`** — box-side recipe: deploy user + docker group, SSH key generation, GitHub secret setup, Caddy reverse-proxy config (with wildcard DNS-01 cert via Let's Encrypt), firewall, capacity planning (~250 MB image + ~100 MB extracted source per PR; 4 GB / 50 GB box handles ~30 concurrent), troubleshooting (publickey rejected / docker permission denied / port range exhausted / Caddy cert pitfalls).

### Architectural decisions

- **Build remotely**, not locally. Avoids docker registry dep + scp-ing 200+ MB of layers per push. The mock app already has a Dockerfile from `slowcook init mock`; we just ssh + `docker build` against it.
- **Shell out to `ssh` + `scp`**, not a JS ssh library. When deploys fail, the failing command is something an ops person can copy + paste. Saves a maintenance surface.
- **Container labels for traceability**. Every preview container gets `--label slowcook.pr=N`, so `docker ps --filter label=slowcook.pr` enumerates them without snagging unrelated containers.
- **Port allocation via `ss -ltn`**, not deterministic-from-PR. Universal on modern Linux; collision-free; trivial to reason about. Workflow scans the configured range on each deploy.

### Tests

- 23 new unit tests in `packages/cli/src/commands/preview/`: config parser (12), arg parsers (7), URL + naming helpers (4). All boundary cases covered (missing fields, malformed port_range, type ≠ ssh, url_template without `{port}`, `_id`-suffix and quote-stripping behaviors).
- 463 cli tests pass total.

### Publish state

```
cli@0.16.0-alpha.5            🟡 in-repo
forge-github@0.11.0           🟡 in-repo
```

Next: α.6 — `@slowcook-ai/review-overlay` package (floating toggle on the preview deploy with nav/comment/approve modes + element-anchored selectors + screenshot via canvas API + GitHub PAT submit).

---

## 0.16.0-alpha.4 + @slowcook-ai/llm-anthropic@0.12.0 — vibe v2 + recipe-blind-to-mock

Cut 2026-04-26.

First agent rewrite for the 0.16 mock-app architecture. Vibe now writes into `mock/` (extending the consumer's singular mock app); recipe (testgen) is explicitly told it is BLIND to the mock — author behavior assertions, never import scenario files.

### What's new

- **`vibe` v2** — emits scenarios + extends the mock-side scenario registry:
  - New `VIBE_SYSTEM` (in `@slowcook-ai/llm-anthropic@0.12.0`) targets `mock/scenarios/story-N.ts` + extends `mock/src/lib/scenario-registry.ts`. Hard rules: REUSE existing mock components by import path, REUSE existing tokens by name, click handlers must mutate local React state (no `fetch`), no test-writes, no production-src writes.
  - Eligibility gate switched from the old `proposals.fixtures.by_domain` heuristic to a structural sniff for a non-empty top-level `ui_behavior:` block in the spec. Backend-only specs skip vibe with exit 0.
  - Project-context blob now includes a "Mock app inventory" section listing scenarios already registered + components already in `mock/src/components/` (recursive walk). The single most important steering signal: vibe sees what's there and reuses instead of duplicating.
  - PR body rewritten for the new architecture — points at the local-dev preview URL (`http://localhost:3100/?scenario=N`) until α.5 brings SSH preview deploy.
- **`emit.validateAndResolveVibePath`** — structural guard rejects any write whose path doesn't start with `mock/`. Slowcook's emit logic now refuses to leak vibe output into `src/` even if the agent's prompt steering fails. Defense-in-depth alongside the prompt-level rule.
- **`recipe` (testgen)** — new "0.16.0-α.4 — recipe is BLIND to the mock app" addendum in `TESTGEN_SYSTEM`: never import from `mock/`, `@/scenarios/`, or `scenario-registry`; write behavior assertions against the production component path; author from spec's `ui_behavior` block alone (don't peek at vibe's emitted JSX); fixtures are local to the test, not imports of mock scenarios. Recipe runs in parallel with vibe from spec-merge — the parallelism only works if recipe stays blind.

### Why blind?

If recipe over-fits to vibe's exact JSX tree (e.g., asserts on the same prop names vibe invented), brew has no degrees of freedom to reconcile mock vs production. Behavior assertions ("clicking Pin toggles the button text") survive the deterministic `slowcook port` step in α.8 and the brew reconciliation in α.9.

### Tests

- 8 new tests for the `ui_behavior`-based `hasUiSurface` (block-style, inline-mapping, single viewport, absent, empty, blank-only, prose mention, real story-017-shaped spec).
- New regression test `0.16.0-α.4: rejects writes outside mock/` in `emit.test.ts`.
- 440 cli tests pass total.

### Publish state

```
core@0.13.0                   ✅ published
mock-runtime@0.1.0            ✅ published
llm-anthropic@0.12.0          🟡 in-repo (changes in vibe.ts + testgen.ts)
cli@0.16.0-alpha.4            🟡 in-repo
```

Next: α.5 — SSH preview deploy CI (`slowcook preview deploy/teardown`, workflow templates, `docs/operating-guide.md`).

---

## 0.16.0-alpha.3 — BUG-F fix: schema synth no longer treats `_id` columns as tables

Cut 2026-04-27.

Last residual bug from 0.15-era validation. Refine's `proposals-synth.ts` heuristic-2 (any backticked snake_case identifier mentioned >=2 times with action context becomes a candidate table) was too permissive: it caught column FK references like `member_id` (mentioned in trigger conditions, RLS policies, FK constraints) and emitted `create table member_id (...)`.

### Fixes

- **Skip column-suffix shapes** from heuristic-2 candidates: identifiers ending in `_id` / `_at` / `_count` / `_url` / `_email` / `_name` / `_path` / `_slug` / `_by` / `_to` / `_from` are conventional column suffixes, not tables.
- **Reject English prose words** from `apiColumns` extraction (the column-name regex was matching freeform response descriptions like `"object containing fields: ..."` → `containing` became a column). Added `containing | representing | describing | indicating | listing | showing | including | excluding | matching | the | with | without | when | where | which | whose` to the response-prose blocklist.
- **3 new regression tests** covering the `member_id`-as-table case, the `_at`/`_count` column-suffix case, and the `containing`-as-column English-prose case. All 26 proposals-synth tests pass; 438 cli tests pass total.

This was the last 0.15-era bug carried into the 0.16 era. Refine's synth now stays clean on UI-light specs that previously tripped it.

---

## 0.16.0-alpha.2 + @slowcook-ai/core@0.13.0 + @slowcook-ai/mock-runtime@0.1.1 — Scenario types in core

Cut 2026-04-27. mock-runtime ships as 0.1.1 (0.1.0 went out with local types before this changeset; 0.1.1 re-exports from core).

### Why

Agent code (vibe in α.3, plate in α.6, brew --mode plate in α.8) needs to reason about Scenario shapes to write/amend/read them. Today's mock-runtime owned the types, but mock-runtime carries React + Next peer deps — agents shouldn't pull React just to use types. Lifting Scenario / MockUser / ScenarioRegistry into core lets agents import them cleanly.

### What's new

- **`@slowcook-ai/core@0.13.0`** exports `Scenario`, `MockUser`, `ScenarioRegistry` from `core/src/scenario.ts`. Same shape as the mock-runtime types they replace. JSDoc lives here as the source of truth.
- **`@slowcook-ai/mock-runtime@0.1.1`** (0.1.0 was the first publish with local types; 0.1.1 collapses them into re-exports from core): `src/types.ts` becomes a thin re-export from `@slowcook-ai/core`. Public API unchanged for consumers (still `import { Scenario } from "@slowcook-ai/mock-runtime"` works).
- **`@slowcook-ai/cli@0.16.0-alpha.2`**: no behavior change — bumped to track core. `slowcook init mock`'s scaffolded `package.json` keeps its `^0.1.0` mock-runtime pin.

435 cli tests + 9 mock-runtime tests pass.

### Publish state after α.2 lands

```
core@0.13.0           ✅ published — has Scenario types
mock-runtime@0.1.0    ✅ published with local types; the in-repo 0.1.1
                         (collapsed to core re-exports) does NOT need to
                         ship until mock-runtime needs a publish for
                         some other reason. Public API is identical.
cli@0.16.0-alpha.1    ✅ published; in-repo alpha.2 is queued for the
                         next bundle (α.3+ will bring vibe v2 with it)
```

The in-repo mock-runtime@0.1.1 (re-exporting from core) is internally cleaner — single source of truth for Scenario types — but consumers can't tell the difference. We'll roll it out alongside the next legitimate mock-runtime change.

---

## 0.16.0-alpha.1 + @slowcook-ai/mock-runtime@0.1.0 — singular mock app foundation

Cut 2026-04-27.

Architectural reset after the 0.15 data-layer-seam approach was rejected (PR #145 closed). New shape: **a per-consumer singular mock app at `mock/`, evolving incrementally**, totally separate from `src/`. Vibe + plate write into `mock/`; brew copies to `src/` and wires real data. Full architecture in [`docs/plans/0.16-mock-app.md`](./docs/plans/0.16-mock-app.md) (drafting next).

### What's new

- **NEW package `@slowcook-ai/mock-runtime@0.1.0`** — runtime for the per-consumer mock app:
  - `Scenario`, `MockUser`, `ScenarioRegistry` types
  - `defineScenarios([...])` builder (validates id-uniqueness)
  - `resolveScenario(registry, queryParam)` resolver (env / default fallback)
  - `<ScenarioRegistryProvider registry>` React context
  - `useScenario()` + `useScenarioFixture<T>(domain)` hooks
  - `<ScenarioPicker />` default homepage component
  - 9 unit tests covering the non-React surface

- **NEW CLI subcommand `slowcook init mock`** in `cli@0.16.0-alpha.1`:
  - Scaffolds the consumer's `mock/` directory (~12 files): `package.json` (depends on `@slowcook-ai/mock-runtime`), `Dockerfile`, `tsconfig.json`, `next.config.js` (with turbopack-root fix baked in), `postcss.config.mjs`, `layout.tsx`, `page.tsx`, `globals.css` (copied from `src/app/globals.css` if present, else minimal Tailwind directives), `scenario-registry.ts`, `.gitignore`, `README.md`
  - Refuses to overwrite existing files unless `--force`
  - `--dry-run` lists planned actions
  - 10 unit tests covering arg parsing, file plan, dry-run, write, force, skip-existing

### Key architectural rules now structurally enforced

1. **Mock + production are separate filesystems.** Mock has its own `package.json`, own `Dockerfile`, own `next.config.js`. Brew never touches `mock/`; vibe/plate never touch `src/`.
2. **Mock is UI-only — NO backend.** No Supabase shape, no API. Scenarios are plain TS modules; React hooks read them; mutations are local component state.
3. **Mock is singular and grows incrementally.** No per-story shadow copies. Stories add scenario files; rarely add components.
4. **Slowcook owns the runtime; consumer owns the shell.** Runtime updates ship via `npm bump @slowcook-ai/mock-runtime`. Consumer-side files (layout, page, globals.css, scenario-registry.ts) are owned + customizable.
5. **Slowcook is stateless re: hosting.** Each consumer provides their own SSH-reachable box (Docker + reverse proxy). 0.16-α.4 ships the SSH preview-deploy CI tooling.

### What's NOT in α.1 (per the 9-alpha plan)

- α.2: `Scenario` types in `@slowcook-ai/core` (today they live only in `mock-runtime`)
- α.3: vibe rewritten to write `mock/scenarios/story-N.ts` + extend `scenario-registry.ts`
- α.4: SSH preview-deploy CI; consumer provides box
- α.5: `@slowcook-ai/review-overlay` package (per the 0.13.1 plan)
- α.6: plate v2 — element-anchored comments + spec-vs-mock classifier
- α.7: `slowcook port` deterministic copy step (mock → src)
- α.8: brew --mode plate v2 — real-data wiring on top of ported UI
- α.9: orchestration (mockup-merged → recipe runs in parallel; brew waits)

### Test count

435 cli tests pass (10 new for `init mock`); 9 mock-runtime tests pass.

### What 0.15 leaves behind

- The data-layer-seam pattern (`<domain>.{mock.ts, ts}` in `src/lib/data/`) — superseded; 0.16 separates mock + production filesystems entirely
- `slowcook vibe`, `slowcook plate`, `brew --mode plate` from 0.15 — the agents work mechanically but emit to the wrong filesystem (`src/` instead of `mock/`). Will be rewritten in 0.16-α.3 / α.6 / α.8 to target the correct paths
- The 0.13.1 review-overlay plan resurfaces in 0.16-α.5 unchanged in spirit, paired with a "spec-vs-mock classifier" extension on plate

---

## 0.15.0-alpha.4 + llm-anthropic 0.11.1 — `brew --mode plate` + MOCKUP_DESIGN_CONFLICT halt

Cut 2026-04-26.

α.4 closes the brew side of the plate-pipeline. With this version, the failure mode that produced rewo PR #117 + PR #142 is structurally impossible.

### What's new

- **`slowcook brew --mode plate|legacy|auto`** — new flag (default `auto`). Mode resolution:
  - `auto`: spec has populated `proposals.fixtures.by_domain.*` AND a merged `slowcook-mockup` PR for the story exists → `plate`. Otherwise `legacy`.
  - `plate`: brew's allowed-paths restricted to `src/lib/data/**`, `src/app/api/**`, `supabase/migrations/**`, `tests/**`. The agent CANNOT edit `src/**/*.tsx`, `src/components/**`, or `src/lib/data/<domain>.mock.ts` — those are plate's frozen design contract.
  - `legacy`: today's behavior, unchanged. For backend-only stories.
- **Hard-signal frozen-paths check in plate-mode** — even though `src/lib/data/**` is in allowed-paths so brew can swap stubs, a runtime check in the agent's iteration loop rejects any write to `*.mock.ts`, `src/components/**`, or `src/**/*.tsx`. The agent's diff is reverted with `note: "plate-mode protects UI: <path>. Mockup files are owned by plate."`
- **`BREW_PLATE_MODE_ADDENDUM`** in `@slowcook-ai/llm-anthropic@0.11.1` — appended to `BREW_SYSTEM` when mode=plate. Tells the agent: the mockup is on main, treat it as frozen, your job is data-layer + API + migrations only. Documents the `<halt class="MOCKUP_DESIGN_CONFLICT">` shape for when a test cannot be satisfied without editing a frozen file.
- **New halt class `MOCKUP_DESIGN_CONFLICT`** with three suggested PM resolutions: `/plate <prose>` to amend the mockup, `/refine <prose>` to relax the invariant, or manual override-merge.
- **Vibe PR body now includes local-pull instructions** — `git fetch + checkout + npm install + npm run dev` snippet so PMs can review the running mockup on localhost without waiting for a preview-deploy infrastructure (which doesn't exist on rewo yet).

### Three layers of defense (now all live)

| Layer | Where | Effect |
|---|---|---|
| 1: mechanical allowed-paths | brew agent's diff scope check + frozen-paths guard | Agent diff that touches a UI file gets reverted before commit |
| 2: structural — recipe runs after plate's PR merges | (recipe runs unchanged; tests target plate's actual DOM) | Recipe never references a stub path that doesn't exist; brew can't be tricked into "fleshing out" a stub |
| 3: prompt steering | `BREW_PLATE_MODE_ADDENDUM` | Agent instructed to halt with `MOCKUP_DESIGN_CONFLICT` instead of fighting the guard |

### What's NOT in α.4

- α.5: full orchestration trigger chain (mockup-merged → recipe → brew --mode plate). Each piece is shipped independently; the auto-fire glue lands α.5.
- α.6+: docker-on-the-runner preview deploys (per session conversation; will be added to the 0.15 plan as a separate slice).

### Test count

425 cli tests pass (no new tests this cut — α.4 is mostly threading + a system-prompt addendum; the existing brew test suite covers the mode dispatch via the `mode` context field being optional/defaulted).

---

## 0.15.0-alpha.3 + llm-anthropic 0.11.0 + forge-github 0.10.3 — `plate` agent (mockup amendment loop)

Cut 2026-04-26.

α.1 + α.2 shipped vibe (initial mockup emit). α.3 closes the iteration loop with `plate` — the agent that processes PM feedback and amends the mockup with minimum diff.

### What's new

- **New CLI command** `slowcook plate --pr <number>` — reads a slowcook-mockup PR, fetches PM feedback (timeline + inline comments) since the last plate commit, runs the LLM with vision-capable Claude (Opus default), parses the `<file>` block output, writes amended files, force-pushes the same branch, posts a `<plate_summary>` PR reply.
- **New prompt** `PLATE_AMENDMENT_SYSTEM` in `@slowcook-ai/llm-anthropic@0.11.0`. Same hard rules as vibe (REUSE existing components + tokens; no new hex/rgb; click handlers must work locally) plus iteration-specific rules (minimum diff; address every feedback item in the summary; surface structural-change requests for shared primitives instead of forking them; soft-fail when feedback contradicts spec).
- **New workflow template** `.github/workflows/slowcook-plate.yml` in `forge-github@0.10.3`. Mirror of `slowcook-refine`'s `/refine`-comment trigger pattern: fires on issue_comment, pull_request_review_comment, and pull_request_review where the body starts with `/plate` on a PR labeled `slowcook-mockup`.
- **Vision-message scaffolding** — `PlateImageAttachment` + `buildPlateAmendmentPrompt` produce Anthropic `image` content blocks alongside text. The CLI doesn't fetch image attachments from PR comments yet (α.3.1 follow-up); the prompt + agent are wired so the addition is a CLI-only change.
- **5 new tests** in `plate/agent.test.ts` covering summary parsing + multi-file emission edge cases. 425 cli tests pass total.

### What's NOT in α.3

- Image-attachment fetching from PR comments (α.3.1 — small, additive)
- Threaded `--review-comment-id` reply implementation (the flag is parsed; the index doesn't yet pass it through to the comment-post call — same gap as α.3.1)
- α.4: `brew --mode plate` allowed-paths constraint enforcement
- α.5: Auto-detection trigger chain (mockup-merged → recipe → brew)

### Iteration shape (PM perspective)

```
1. PM reviews preview deploy of slowcook-mockup PR
2. PM comments: /plate make the strip cards wider, the empty-state copy is too long
3. slowcook-plate workflow fires
4. plate reads the comment + every prior unresolved one + PR's current files
5. plate amends src/components/.../strip.tsx + page.tsx with minimum diff
6. plate force-pushes; posts a `### slowcook · plate amendment` reply with bullet-per-feedback summary
7. Cloudflare/Vercel rebuilds preview (~60s)
8. PM re-reviews → approves OR /plate again
```

---

## 0.15.0-alpha.2 + forge-github 0.10.2 — vibe workflow + eligibility gate

Cut 2026-04-26.

α.1 shipped the agent + CLI; α.2 wires it into CI.

### What's new

- **New workflow template** `.github/workflows/slowcook-vibe.yml` in `forge-github@0.10.2`. Auto-fires when a PR with label `slowcook-spec` merges; also exposes `workflow_dispatch` for manual retry. Steps:
  1. Resolve slowcook CLI pin from `.brewing/slowcook-cli-version` (per the existing pattern)
  2. Run `slowcook extract` (brownfield extracts — vibe's reuse-vocabulary)
  3. Run `slowcook map generate` (code-map — vibe's component-reuse inventory)
  4. Detect story id from the merged PR's branch name (`slowcook/spec/story-N`) or the workflow_dispatch input
  5. Skip if the mockup branch already exists (don't overwrite plate's iteration)
  6. Run `slowcook vibe --spec <id>` — emits mockup + opens draft PR
- **Eligibility gate in `slowcook vibe`** — `hasUiSurface(specYaml)` returns true only when `proposals.fixtures.by_domain` has at least one domain entry. Backend-only specs skip vibe with a soft-success exit so the workflow doesn't fail spuriously. Synth-shell fixtures (with empty `seed`) still trigger vibe — the spec implies UI even if the agent didn't populate fixture rows.
- **Rewo dogfood workflow** at `.github/workflows/slowcook-vibe.yml` — manual `workflow_dispatch` only, builds slowcook from source so we can iterate on alphas without round-trips through npm publish. Mirrors the `slowcook-investigate (alpha)` pattern.
- **8 new tests** in `vibe/index.test.ts` covering the eligibility gate. 420 cli tests pass total.

### What's NOT in α.2

Same as α.1 list minus the workflow piece (now shipped):
- α.3: `plate` amendment loop with `/plate` PR-comment trigger
- α.4: `brew --mode plate` allowed-paths constraint enforcement
- α.5: Auto-detection trigger chain across the merged-mockup → recipe → brew flow

### Upgrade path

For consumers using slowcook-init scaffolding: re-run `slowcook init` to get the new `.github/workflows/slowcook-vibe.yml` template (skips other already-installed templates). Manual install: copy the workflow file from `node_modules/@slowcook-ai/forge-github/dist/templates.js` (search for `slowcook vibe`).

For rewo specifically: bump `.brewing/slowcook-cli-version` to `0.15.0-alpha.2` after publish; the existing `slowcook-vibe (alpha)` workflow file is committed alongside this release for source-build validation.

---

## 0.15.0-alpha.1 — `vibe` agent: design-first mockup generator (plate-pipeline α.1)

Cut 2026-04-26.

First slice of the 0.15 plate-brew architecture (see [`docs/plans/0.15-plate-brew.md`](./docs/plans/0.15-plate-brew.md)). Pairs with `@slowcook-ai/llm-anthropic@0.10.0`.

### What's new

- **New CLI command** `slowcook vibe --spec <id>` — reads `specs/story-<id>.yaml` + brownfield extracts (`.brewing/diagrams/{schema.mmd,tokens.md}`) + code-map summary; calls Claude with a single-shot mockup-generation prompt; parses XML-tagged file blocks; writes mockup files to `slowcook/mockup/story-<id>` branch + opens a draft PR labeled `slowcook-mockup`. `--dry-run` skips git/PR ops for offline validation.
- **New module** `packages/cli/src/commands/vibe/{index,agent,emit,prompts}.ts` + tests.
- **New prompt** `VIBE_SYSTEM` in `@slowcook-ai/llm-anthropic@0.10.0`. Emphasizes: REUSE existing components by import path; REUSE existing tokens by name; click handlers must work locally; no real API calls; no tests.
- **New emit format** — multi-artifact XML blocks: `<file path="...">contents</file>` plus optional `<component_change_request component="..." path="...">prose</component_change_request>` for surfacing structural-change asks plate handles separately.
- **Path safety** in `validateAndResolveVibePath` — rejects absolute paths, parent-dir escapes, and paths that normalize outside `repoRoot`.
- **Format-compliance retry** — single nudge if the agent's first round emits no `<file>` blocks (mirrors investigate's α.2c pattern).

### What's NOT in α.1

- `slowcook-vibe.yml` workflow template (α.2)
- `plate` amendment loop (α.3)
- `brew --mode plate` constraint enforcement (α.4)
- Auto-detection trigger chain (α.5)

α.1 is locally validatable via `--dry-run`; full workflow integration ships α.2.

### Test count

412 cli tests pass (15 new for vibe — emit-parsing edge cases, path safety, file writing).

---

## 0.14.0-alpha.6 — Spec-emit validator catches LLM truncation (BUG-E)

Cut 2026-04-26.

V6 PM-judgment validation arc found a real LLM-truncation bug — story-016 spec emit ended its 12-token list mid-entry with `var(--tint-in` (unterminated). YAML parsed (valid string) so Zod shape-validation didn't catch it; downstream brew/testgen would see a fake project token.

- **New module** `packages/cli/src/commands/refine/spec-validate.ts` exporting `validateAndRepairSpec(spec)`. Walks `proposals.ui_layout.{tokens_to_reuse, tokens_to_add, components_to_reuse}` for: unterminated `var(...)`, class-prefix-only entries (`bg-`, `text-`), empty / non-string entries. Mutates spec in place; returns findings for caller to log.
- **Wired into both refine call sites** (initial emit + amendment) right before `writeSpec`. Findings logged via console.warn, prefixed `[refine]` or `[refine amend]`.
- **6 new unit tests** in `spec-validate.test.ts` (397 cli total).
- **Live-validated** by re-running `/refine` on PR #140 — the amendment correctly emitted all 12 emotion tints by name (`var(--tint-celebrate)` … `var(--tint-mourn)`). With α.6 deployed, even a re-truncated emit would prune the bad entry instead of writing it.

Pairs with V6 validation arc that drove story-015 → story-016 from `slowcook-refine@0.14.0-alpha.2` to `0.14.0-alpha.5`. The alpha.5 schema/route/UI synth was already much better; α.6 closes the remaining content-validation gap.

---

## 0.14.0-alpha.5 — Two ui_layout-synth polish items

Cut 2026-04-26.

- **POLISH-1**: ui_layout synth no longer puts standard Tailwind utility classes in `tokens_to_add`. Filters `text-{xs,sm,base,lg,…}`, `font-{thin,…,bold}`, `border-{dashed,dotted,solid,none,2,4,8}`, alignment, opacity, etc. They're framework primitives, not project tokens.
- **POLISH-2**: ui_layout synth filters PascalCase component candidates by recognized suffix (Card/Page/Form/List/Item/Picker/…) — prevents button-label strings (`Pin`, `Pinned`, `Unpin`) from polluting `components_to_reuse`. Was caught on story-015 re-validation.
- 2 new tests (391 cli total).

α.5 leaves the data-layer seam track ready. Next slice is α.6 (the actual mockup generation: `src/**/page.tsx` + components) which is the first user mockup-feedback checkpoint.

---

## 0.14.0-alpha.4 — α.3 follow-up bugs (route / schema synth false positives + ESM require)

Cut 2026-04-26.

α.3 synth changes were validated against rewo story-015 — three new bugs surfaced and were fixed:

- **BUG-C: schema synth invented English words as table names.** `for (member_id, rewo_id)` and `delete (...)` matched the table-column regex because backticks were optional. Required leading backtick. Also expanded the SQL-reserved-words skip-list. **Then**: api error codes (`pin_limit_reached`, `pin_requires_reaction`) appeared as fake CREATE TABLEs because they're backticked snake_case identifiers mentioned >=2 times. Fix: extract `code: "..."` values from `api_contract.responses` + `raising/raises X` from invariants → blacklist.
- **BUG-D: route synth invented `/[handle]` from `/feed`.** α.3 added an api_contract dynamic-name lift that rewrote EVERY literal path's last segment. Reverted; the `:name` regex extension alone (added in α.3 for BUG-A) is sufficient.
- **Split-form `(cols)` in `<table>` convention not recognised.** story-015 used "Unique constraint on `(member_id, rewo_id)` in `rewo_pins`" — column list and table name in separate backticks. New heuristic 1b handles this; previously dropped `member_id` from the synthesised table.
- **`require()` under ES modules silently returned empty entity catalog.** `readExistingEntities` + `readExistingTokens` lazy-required `node:fs` which throws ReferenceError under ESM — the swallowing try/catch left the brownfield extracts unused. Switched to top-level `import { existsSync, readFileSync } from "node:fs"`. Foreign keys now actually appear in synthesised CREATE TABLEs (`member_id uuid not null references profiles(id) on delete cascade`).
- **3 new tests** in `proposals-synth.test.ts` (21 total in that file; 389 cli total).

End-to-end re-validation against story-015's actual spec produces:
- 1 right table (rewo_pins) with 7 real columns, 2 FKs validated against ERD
- 3 routes (no /[handle] noise)
- ui_layout with 5 reuse tokens, 4 add candidates (3 are tailwind built-ins → polish opportunity logged)
- empty-shell fixtures for the data-display story

---

## 0.14.0-alpha.3 — Hard-signal synthesizers + two spec-body-synth bug fixes

Cut 2026-04-26.

End-to-end validation against rewo (issue #138 + PR #129) revealed three problems caught autonomously while testing the brownfield foundation. Fixed in this cut.

### Bugs fixed

- **`/u/alice` route bug**: `spec-body-synth` produced `path: /u/alice, file: src/app/(main)/u/alice/page.tsx` for story-015 because the dynamic-segment regex didn't recognize Express-style `:handle` segments — only `[handle]` (Next.js) and `<handle>` (spec shorthand). The story-015 spec used `:handle` throughout (api_contract: `/api/profiles/:handle/pins`), so `/u/:handle` got truncated and `/u/alice` from a prose example became the only `/u/*` route. Fix: regex accepts `:name` segments + lifts dynamic names from api_contract paths to synthesise `/u/[handle]` siblings of literal `/u/alice` mentions, then coalesces.
- **Schema TODO bug**: `deriveSchema` bailed to a `-- TODO` placeholder when invariants clearly implied a new table. Fix: proper `CREATE TABLE` synthesis from invariants + api_contract response shapes. Type inference by suffix convention (`_id` → uuid + FK to existing entity from `.brewing/diagrams/schema.mmd`, `_at` → timestamptz, `_count` → integer, default → text). Brew can now act on the proposal; previously it had to bail.

### V7 — hard-signal backstop for `ui_layout` + `fixtures`

Per the "soft steering vs hard signals" memory, the 0.13.6 prompt steering to elevate brownfield context into structured proposals proved **soft**: on rewo story-015 the agent put real tokens in prose `ui_behavior` (`bg-tint-celebrate`, `text-foreground/60`, `border-card-border`) but skipped the structured `proposals.ui_layout` block. Same with fixtures — clear data-display story, no `proposals.fixtures` block.

Two new synthesizers in `proposals-synth.ts`:

- **`deriveUiLayout`**: scans `ui_behavior` prose for token usage (`bg-…`, `var(--…)`) and component path mentions (`src/components/...`); validates each against `.brewing/diagrams/tokens.md`; classifies as `tokens_to_reuse` vs `tokens_to_add`. Backtick-wrapped PascalCase names get a weak-signal entry `\`Foo\` (path TBD)`.
- **`deriveFixtures`**: detects "data display" stories (api_contract has GET + ui_behavior implies listing); emits an empty-seed shell. The shell still triggers `writeMockFixtures` to emit `.mock.ts` + `.ts` stub files (with empty arrays), unblocking the data-layer seam. Real fixture rows still need LLM/PM authoring.

8 new tests in `proposals-synth.test.ts` (15 total in that file; 387 cli total).

---

## 0.14.0-alpha.2 — Sibling stub `<domain>.ts` (data-layer seam, brew-target side)

Cut 2026-04-25.

α.1 wrote `<domain>.mock.ts` (the fixture data). α.2 writes the sibling `<domain>.ts` stub that pages will actually import from. The stub re-exports the mock fixtures verbatim so the generated mockup renders during PM review; brew detects the `@slowcook-stub` marker and replaces the file with a real fetch implementation.

- New `renderStubFile(domain, storyId)` exported from `mock-fixtures.ts`. One-line `export * from "./<domain>.mock.js"` body, with `@slowcook-stub` in the header comment.
- `writeMockFixtures` now returns BOTH paths per domain (e.g. `notifications.mock.ts` + `notifications.ts`). Updated tests to expect 4 files per 2-domain spec.
- New marker constant `SLOWCOOK_STUB_MARKER` exported for brew (later) to grep against when deciding what to replace.
- 2 new tests + updated existing test (10 tests in mock-fixtures.test.ts; 378 cli total).

The data-layer seam pattern is now complete on the refine side. Pages import from `@/lib/data/<domain>` (the stub); during mockup review the stub re-exports fixtures; when brew kicks in it replaces the stub body with real fetches and the import path stays stable.

α.3 (the actual mockup generation: `src/**/page.tsx` + components) is the next slice and the first user mockup-feedback checkpoint.

---

## 0.14.0-alpha.1.5 — Refine prompt steering for `proposals.fixtures`

Cut 2026-04-25.

α.1 added the schema field + writer infra; α.1.5 teaches the agent when to populate it.

`REFINEMENT_ANALYST_SYSTEM` (in `@slowcook-ai/llm-anthropic`) gains category 9: `fixtures`. Steering covers:

- **When** to emit: story has `api_contract` GET endpoints AND `ui_behavior` implies displaying that data.
- **Domain naming**: lowercase, hyphen/underscore, one per primary resource (`notifications`, `member-reactions`, `feed`).
- **Seed shape**: keys become named exports of `<domain>.mock.ts` (`list`, `count`, `byId`).
- **Coverage**: 3–5 sample items mixing edge cases the spec calls out (read/unread, paginated/empty, owned/not-owned).
- **Naming alignment**: field names match `api_contract` response schemas (so generated UI imports + future real data layer agree).
- **Skip when**: styling polish, backend-only, settings UI with no list/feed surface.

Pure prompt change. Pairs with α.1 to make the data-layer seam self-driving.

---

## 0.14.0-alpha.1 — Mockup-first data-layer seam (mock fixtures)

Cut 2026-04-25.

First slice of the 0.14 mockup-first refinement plan. Refine now writes hand-authored mock fixture files alongside the spec, so the generated mockup (later α.3) can be behaviorally complete without a real backend.

- **New schema field** `proposals.fixtures.by_domain.<domain>.seed` in `@slowcook-ai/core@0.12.0`. Each domain's seed is a record of named exports the generated `<domain>.mock.ts` will emit verbatim.
- **New module** `packages/cli/src/commands/refine/mock-fixtures.ts` exporting `writeMockFixtures(repoRoot, spec)` + `renderMockFile(domain, storyId, seed)`. Pure deterministic JSON.stringify-based emission. Idempotent.
- **Wired into refine** at both call sites: initial spec emit + amendment. Skipped silently when `proposals.fixtures` is absent / rejected, so this is a no-op for pre-α.1 specs.
- **Path safety:** domain names must match `^[a-z][a-z0-9_-]*$`; export names must be valid TS identifiers. Rejects `../escape`, `Notifications`, `bad-name` etc.
- 8 new tests in `mock-fixtures.test.ts` (header rendering, primitives/arrays/objects, validation, two-domain emission, idempotence, status=rejected skip).

What's next:
- **α.1.5** — refine prompt steering to populate `proposals.fixtures` when api_contract entries imply data shapes.
- **α.2** — sibling `<domain>.ts` stub with `@slowcook-stub` body that throws (brew's ratchet target).
- **α.3** — generated `src/**/page.tsx` + components for the story (first user mockup-feedback checkpoint).

---

## 0.13.6 — Refine system prompts steered to use brownfield extracts

Cut 2026-04-25.

The brownfield context (0.13.4) was reaching the agent but the prompts didn't tell it what to DO with it. 0.13.6 adds explicit steering inside `REFINEMENT_ANALYST_SYSTEM` + `AMENDMENT_SYSTEM` (in `@slowcook-ai/llm-anthropic`):

- For `schema` proposals: foreign keys MUST reference entity names that appear in the extracted ERD verbatim (same case, same plural form). New tables proposed only with explicit one-line rationale.
- For `ui_layout` proposals: every entry in `tokens_to_reuse` MUST exist in the extracted token catalog. New tokens go into `tokens_to_add` only after confirming the existing palette can't express the design intent.
- When PM describes a color in prose ("warm yellow", "an alert red"), agent maps to closest existing token and SAYS which one it picked: "I'll use `var(--sunshine)` (#FFD93D) for warm yellow."
- Amendment prompt: extracts override prior YAML when they conflict — the extract is what's actually deployed, the prior proposal may have predated the extraction.

Pure prompt change — no schema / API surface change. Pairs with 0.13.2–0.13.5 to make the brownfield foundation actually steer agent behavior.

---

## 0.13.5 — `slowcook extract` + workflow auto-extraction (`forge-github@0.10.1`)

Cut 2026-04-25.

The brownfield extracts now run automatically before refine + investigate, so consumers don't have to remember.

- **New top-level command** `slowcook extract [--schema] [--tokens]` — focused brownfield extraction without paying for `map generate`'s ts-morph code-map scan or requiring `npm ci`. Pure regex/filesystem walk over `supabase/migrations/*.sql` + `**/*.css`. Measured: ~315ms total against rewo (10 entities + 21+21+10 tokens). Default with no flag = run both.
- **forge-github@0.10.1**: refine + investigate workflow templates gain a "Brownfield extracts" step before the agent step. Both extracts skip silently on greenfield, so the templates are safe defaults for non-Supabase / no-CSS-vars consumers.
- **rewo workflows updated to match** (paired per the slowcook/rewo template-drift convention).
- 4 new unit tests for the extract command (default, --schema only, --tokens only, greenfield skip messages).

This closes the brownfield-extraction loop opened in 0.13.2: map produces → refine consumes → CI runs the extract step automatically before every refine. Foundation for 0.14 mockup-first refinement is now ready end-to-end.

---

## 0.13.4 — Refine reads brownfield extracts (the missing wire-up)

Cut 2026-04-25.

`buildProjectContext` (refine's system-prompt grounding) now appends a "Brownfield project awareness" section when `.brewing/diagrams/schema.mmd` and/or `.brewing/diagrams/tokens.md` exist. Without this, the 0.13.2/0.13.3 extracts sat unused. With it, refine's proposals align with the consumer's existing entity vocabulary + design tokens instead of inventing.

- Schema is wrapped in a fenced ` ```mermaid ` block so the agent can both read the entity names and (if it pastes the section into a PR body) GitHub renders the diagram.
- Tokens markdown is included verbatim with a steering note: "reuse these tokens by name (`var(--coral)`, `bg-coral`) instead of inventing".
- Both extracts are optional — silently skipped on greenfield or pre-extraction state.
- Wiring flows automatically into both `buildProjectContext` call sites in `refine/agent.ts` (initial + amendment).
- 6 new unit tests in `refine/context.test.ts`.

Pairs with 0.13.2 (`--emit-schema`) and 0.13.3 (`--emit-tokens`). The full brownfield foundation for 0.14 mockup-first refinement is now wire-complete.

---

## 0.13.3 — Brownfield extraction: `slowcook map --emit-tokens`

Cut 2026-04-25.

Second brownfield slice for 0.14 mockup-first refinement. `slowcook map generate --emit-tokens` walks `**/*.css` (skipping `node_modules`, `.next`, `.open-next`, `.claude`, build dirs), parses `:root { --var }` and `@theme { --var }` blocks, classifies tokens by name + value, and writes `.brewing/diagrams/tokens.md`.

- Detects light vs dark variants by checking if `:root` lives inside `@media (prefers-color-scheme: dark)`.
- Captures Tailwind v4 inline `@theme` blocks separately from raw `:root` definitions.
- Heuristic classification: `color` / `typography` / `spacing` / `other` based on token name, value pattern, or transitive `var()` resolution.
- 9 unit tests (light/dark routing, @theme capture, comments, regression for the `@import "tailwindcss";` Tailwind v4 idiom that used to swallow the next selector head, skip-dir walking).
- Validated against rewo: 21 light + 21 dark + 10 @theme tokens from `src/app/globals.css`. Refine can now reference `var(--tint-celebrate)` rather than inventing hex.

Bug fix in the parser worth calling out: bodyless at-rules (`@import`, `@charset`) used to be glued onto the head of the next block. Now stripped before head matching. This was caught only by running the live extractor against rewo — synthetic tests passed but the real Tailwind v4 file produced 0 light tokens.

---

## 0.13.2 — Brownfield extraction foundation: `slowcook map --emit-schema`

Cut 2026-04-25.

Foundation piece for 0.14 mockup-first refinement. `slowcook map generate --emit-schema` walks `supabase/migrations/*.sql`, concatenates the DDL, hands it to the existing `ddlToMermaidErd` from refine, and writes `.brewing/diagrams/schema.mmd`. Refine reads this later as project-awareness so its proposals (new tables / FKs) align with the consumer's existing entity vocabulary instead of inventing.

- Skipped silently (no error) when `supabase/migrations/` is missing or empty — not every consumer uses Supabase.
- Files processed in lexical order (`00001_…sql` before `00002_…sql`) so the rendered ERD reflects the migration timeline.
- Output is annotated with a generated-by header so reviewers know not to hand-edit.
- 4 new unit tests in `packages/cli/src/commands/map/emit-schema.test.ts` cover: missing dir, empty dir, valid migrations, lexical ordering.

Next brownfield slices (`--emit-tokens`, `--emit-components`) follow the same shape.

---

## 0.13.0 — Bug-flow + chef orchestrator + `testgen` → `recipe` rename

Cut 2026-04-25 (tag `0.13.0`). Pairs with `forge-github@0.10.0`. Six alphas (α.1–α.5c) plus α.3b LLM-backed regression-test emitter consolidated into the final cut.

### New parallel pipeline for bugs

```
Story flow:  refine        → recipe                → brew
Bug flow:    investigate   → recipe --regression   → sift
                              ↓
                            chef (watches all PRs, classifies + acts)
```

- **`investigate`** — bug-flow analogue of refine. Reads the issue body, runs read-only repo tools (read_file, outline_file, find_references, find_definition, grep, list_directory) to find the failure locus, emits a `bug-profile.yaml` at `.brewing/bug-profiles/B-N.yaml`, opens a PR. Auto-trigger on issues labelled `bug`. Live-validated against rewo issues #135 + #88; both produced sound profiles ($1.74–$1.76 per Opus run).
- **`recipe --regression --bug B-N`** — new mode on the recipe (formerly testgen) command. Two emitters: deterministic stub (no LLM, `expect.fail` body) and LLM-backed real test (Sonnet default). Output: single vitest file at `tests/regression/B-N-<slug>.test.ts`.
- **`sift`** — bug-flow analogue of brew. Narrow red→green ratchet bounded by `bug-profile.fix_scope`. Defaults: Sonnet model, $0.50 budget cap, 3 iterations cap. Test-runner scoped to the regression file only.
- **`chef`** — pipeline orchestrator. Watches slowcook-bot PRs. Pure classifier (`classifyPrFailure`) decides between four classes: `self-conflict` (rebase needed), `self-fail` (PR's own diff caused it; dispatch retry), `external-fail` (pre-existing red on base; comment + escalate), `infra-fail` (rerun once, escalate if persists). Loop protection: refuses to act after 3 prior chef-bot comments.

### `testgen` → `recipe` rename

`recipe` is the new canonical name (kitchen-metaphor consistency with refine + brew + sift + investigate + chef). `testgen` keeps as a hidden alias through 0.13.x; removed in 0.14.0.

### New schemas + workflows

- `bug-profile.schema.json` — TypeScript types + `validateBugProfile` runtime check.
- `slowcook-investigate.yml` — fires on `bug` label OR workflow_dispatch.
- `slowcook-sift.yml` — manual workflow_dispatch (auto-trigger ships in 0.13.x).
- `slowcook-chef.yml` — fires on `check_suite.completed` (failure) for slowcook-bot PRs.

### Stats

- 26 test files / 345 tests green (was 24 / 319 at 0.12.13).
- ~2.6k LOC of new agents + tests across `commands/{investigate,sift,chef,recipe-regression}/`.

### Deferred (planned for 0.13.x or 0.14)

- Auto-rebase + structural-conflict resolver in chef (currently surfaces a manual recipe).
- Auto-dispatch of retries from chef via `gh workflow run` (currently posts a comment).
- Brew/sift shared iteration engine — sift owns its own narrow loop (~1.1k LOC); merge if duplication bites.

### Migration for consumers

Bump `.brewing/slowcook-cli-version` to `0.13.0`. Run `slowcook init --force` to install the three new workflow files.

---

## 0.12.x rollup — brownfield-retrieval Phase 2 + tier-1 prevention checks + cost-marker fixes

The 0.12 line landed in 13 patches (0.12.0 → 0.12.13) over 2026-04-24 → 2026-04-25. Highlights:

- **0.12.7–0.12.12 — Phase 2 brownfield-retrieval.** Code-map gained `line` + `callers` per symbol (2A); brew now writes a per-target slice at `.brewing/code-map.target.md` every iteration (2B); `.brewing/patterns/` directory loads team-authored recipes into the cached prefix (2C).
- **0.12.9 — page-link static check (slowcook#6).** Testgen emits a `tests/integration/story-N-page.test.ts` assertion that every literal `fetch('/api/...')` URL in a wired-in component resolves to a real route file. Catches the gap observed on rewo PR #117 (story-004 brew shipped a /feed page wired to `/api/feed` which never existed).
- **0.12.10 — schema-presence check (slowcook#7).** Testgen emits a `tests/schema/story-N-column-presence.test.ts` assertion that every `.from(t).select(c)` reference exists in `supabase/migrations/`.
- **0.12.11 — multi-column ALTER TABLE fix.** schema-presence check now correctly handles `ALTER TABLE foo ADD COLUMN a, ADD COLUMN b`.
- **0.12.13 + forge 0.9.8 — cost-marker fixes.** `slowcook · shipped` rollup renders as a fixed-width restaurant bill and correctly includes testgen + brew. Two underlying bugs fixed: testgen workflow was missing `issues:write`; brew's halt comment was fire-and-forget without `await`.
- **0.12.0–0.12.6** — refine retrieval Phase 1 (cross-brew provenance), refine validators, code-map gitignore, sanitiser regex fix.

Latest stable on npm: `cli@0.12.13`, `forge-github@0.9.8`. The `0.13.0` tag is committed but not yet published.

---

## 0.11.7 — Ingestion-side normaliser for emit variance

0.11.6's prompt tightening wasn't enough — agent (Opus 4.7 on 2026-04-24) kept emitting `acceptance_scenarios[1]` as a Given/When/Then object despite the explicit "must be strings" instruction. Third failure in the prompt-only pattern (styling 0.7.20, proposals 0.11.2, scenarios 0.11.6) — same answer each time: normalise at ingestion.

New `normalizeEmittedSpec()` runs before zod validation:

- Object entries with `given` / `when` / `then` (or title-case) keys → coerced to "Given … When … Then …" prose string
- Other object entries → `[NORMALIZED_OBJECT] {...}` marker with JSON-stringified content (so operators see the malformed emit in the spec file instead of a crash)
- Applied to `acceptance_scenarios`, `preconditions`, `invariants`, `non_goals`

Well-formed input passes through unchanged.

### Measurable scope

- **`@slowcook-ai/cli`**: `0.11.6 → 0.11.7` — new `normalizeEmittedSpec` helper, wired before `EmittedSpecSchema.safeParse` in `parseAgentOutput`
- 168 tests green (unchanged)
- No other package changes

---

## 0.11.6 — Amendment prompt enforces field shapes

0.11.5's first real `/refine` dogfood on rewo PR #73 emitted a spec where `acceptance_scenarios[1]` was an object instead of a string (agent "helpfully" structured a Given/When/Then into sub-fields). Zod rejected; refine failed.

Fix: `AMENDMENT_SYSTEM` prompt gains an explicit "Field shapes (load-bearing)" section listing every field's expected type, with a specific callout that multi-line Given/When/Then prose stays as prose STRINGS (with YAML pipe-block scalars for long text), not structured objects.

Same discipline the main `REFINEMENT_ANALYST_SYSTEM` already had; amendment mode was treating schema as inherited-by-reference. Shipping it explicitly in both places now.

### Measurable scope

- **`@slowcook-ai/cli`**: `0.11.5 → 0.11.6` — amendment prompt only
- 168 tests green (unchanged)
- No other package changes

---

## 0.11.5 — `/refine` PR-comment resubmit (cli + forge-github)

Closes the iteration loop for refinement proposals. PM can reply `/refine <any prose>` on an open spec PR and the agent will amend the spec on the same branch — no need to close the PR and re-run refine from scratch.

Paired release: CLI adds the new flag + runResubmitRefinement path; forge-github adds the `slowcook-refine.yml` template so `slowcook init` emits the workflow with both trigger modes.

Closes the iteration loop for refinement proposals. PM can now reply `/refine <any prose>` on an open spec PR and the agent will amend the spec on the same branch — no need to close the PR and re-run refine from scratch.

### CLI

New flag on `slowcook refine`:

```
slowcook refine --pr <number>    # 0.11.5+ PR-driven resubmit
```

Mutually exclusive with `--issue`. Routes to a new `runResubmitRefinement` path in `agent.ts`:

1. Detect story id from current branch (expected: `slowcook/spec/story-N`)
2. Load current spec YAML from disk
3. Fetch PR comments via `listIssueComments`; filter out agent's own brand-header output
4. Call LLM with new `AMENDMENT_SYSTEM` prompt: current spec + PM feedback → amended spec
5. Parse emitted YAML through same pipeline as `--issue` (proposal validation, synth fallback, zod strict)
6. Write updated spec, stage, commit, force-push
7. Post summary comment on the PR with cost marker

### Workflow

`slowcook-refine.yml` gets a second trigger path:

- **Mode A (existing)**: issue labeled `needs-refinement` → issue-driven refine
- **Mode B (new)**: `/refine` comment on a PR labeled `slowcook-spec` → resubmit

Workflow detects mode via `github.event.issue.pull_request` + comment body; checks out the PR's head branch for Mode B (instead of main); invokes CLI with appropriate flag. One `slowcook-refine.yml` handles both modes.

### Amendment prompt

New `AMENDMENT_SYSTEM` in prompts.ts. Single-shot:

- Does NOT re-run relationship analysis (spec already exists)
- Does NOT ask clarifying questions (amendment is single-shot; if ambiguous, best-interpret + note in rationale)
- Preserves story_id / title / supersedes / source_issue / refined_by
- Flips proposal `status` based on feedback: approved → `approved` + approved_by/at, rejected → `rejected`, new-constraint-emerges → re-open as `pending`

### What's NOT in 0.11.5

- **Automatic approval-invalidation cross-reference** — prompt asks the agent to re-open approved proposals when related invariants change, but there's no mechanical enforcement. 0.11.6.
- **Unit tests for resubmit** — manual dogfood only in 0.11.5.

### Measurable scope

- **`@slowcook-ai/cli`**: `0.11.4 → 0.11.5` — new `--pr` flag, `runResubmitRefinement`, `AMENDMENT_SYSTEM` prompt
- **`@slowcook-ai/forge-github`**: `0.9.0 → 0.9.1` — new `slowcook-refine.yml` template (two-mode: issue-driven refine + PR-driven resubmit), registered in `getGitHubCiArtifacts`. Before this, consumers had to hand-author their refine workflow; `slowcook init` now emits one by default.
- Rewo `slowcook-refine.yml` already hand-updated to match the new template shape (committed earlier in this cycle).
- 168 cli tests green

---

## 0.11.4 — Defensive rendering + strict proposal validation upstream

0.11.3's dogfood on rewo #25 tripped a new failure: the LLM emitted a `proposals.schema` without a `sql` field, and `renderProposalsSection` called `.trim()` on undefined → crashed in `draftPrBody`, the whole emit round failed with "Cannot read properties of undefined".

Two-layer fix:

1. **Upstream validation**: `parseAgentOutput` now runs LLM-emitted proposals through `SpecProposalsSchema.safeParse` before downstream consumers see them. Malformed proposals get dropped silently (the synth layer fills gaps from traditional fields anyway; spec stays valid without them).
2. **Defensive rendering**: `renderProposalsSection`'s schema branch now guards the `sql` access — `typeof p.schema.sql === "string"` before `.trim()`. Belt-and-braces against any future shape variance.

`SpecProposalsSchema` is now exported from `spec-yaml.ts` so `agent.ts` can use it as the single source of truth for proposal validity.

### Measurable scope

- **`@slowcook-ai/cli`**: `0.11.3 → 0.11.4` — hardening only, no new functionality
- 168 tests green (unchanged — guards validated via manual re-test)
- No other package changes

---

## 0.11.3 — Deterministic proposals synthesis from spec body

Prompt-only steering (0.11.0, 0.11.2) failed to get the LLM to emit proposals reliably when the PM gave detailed answers in the question round. Two dogfoods on rewo #22 produced rich specs with empty `proposals:` blocks — all decisions inlined into `invariants` / `api_contract` / `ui_behavior`. The PR-body review surface (Mermaid ERD, routes table) never triggered.

**Structural fix** matching the pattern 0.7.21 took for styling: stop relying on LLM cooperation for things we can compute. New `packages/cli/src/commands/refine/proposals-synth.ts` runs after `parseAgentOutput` and fills in categories the LLM left empty, sourcing content from the spec's traditional fields:

- **Routes** — extract non-/api/ paths from `api_contract` + `ui_behavior` prose. Map to Next.js App Router file paths (`src/app/(main)/<segments>/page.tsx`). High confidence.
- **Auth** — scan invariants for `authenticated` / `RLS policy` / `member_id = auth.uid()` / `ownership check` patterns. Synthesize requirements list. High confidence.
- **Schema** — when invariants mention `unique constraint` / `alter table` / `add column` / table.column references but no structured DDL was emitted in proposals, synthesize a `pending` schema proposal with placeholder SQL citing the relevant invariants and flagging "regenerate or hand-author." Real DDL reconstruction from prose needs another LLM call; flagging the gap is honest partial progress.

All synthesized proposals carry `proposed_by: "spec-body-synth"` so reviewers can distinguish from LLM-emitted ones. **LLM-emitted proposals always win** — synth never overrides, only fills gaps.

Also fixed: `EmittedSpecSchema` in `parseAgentOutput` now accepts a `proposals` passthrough. 0.11.0/0.11.2's zod schema was stripping the `proposals` field during emit parse, which meant even if the LLM DID emit proposals they'd be dropped before reaching the Spec object. Now they pass through intact; synth fills remaining gaps; strict validation lives in `spec-yaml.ts` at read time.

### Measurable scope

- **`@slowcook-ai/cli`**: `0.11.2 → 0.11.3`
- New `refine/proposals-synth.ts` (+ test file, 8 tests)
- `agent.ts` loosens EmittedSpecSchema + runs synth after spec assembly
- 168 tests green (+8)
- No other package changes

---

## 0.11.2 — Proposals REQUIRED in their categories (don't hide in invariants)

0.11.1 unblocked the emit round; dogfood on rewo issue #22 showed a new shape of the problem. Refine produced a rich spec with all the DDL + route + API decisions encoded in `invariants` + `api_contract` + `ui_behavior` — but the `proposals:` block stayed empty. The rendered PR body had no Mermaid ERD, no routes table, no status lifecycle — exactly the review surface 0.11.0 was built to provide.

**Root cause**: the prompt framed proposals as "for gaps the PM didn't close." When the PM gave detailed answers, refine inlined every decision into traditional spec fields and skipped proposals entirely. Two places to capture the same thing; refine chose one.

**Fix**: prompt tightening to make proposals REQUIRED when their scope applies, even when a traditional field could also carry the decision. Proposals and traditional fields coexist — proposals are the review surface (Mermaid ERD, routes table, status lifecycle) and downstream allowed-path signal; traditional fields are the canonical spec text. They hold the same info on first emit; once PM approves proposals, brew gets the right allowed-paths expansion.

Concrete rules now in the §Proposals section:

- If the story introduces or alters a DB table → `proposals.schema` MUST emit (even if `invariants` mentions constraints)
- If the story introduces a new page URL → `proposals.routes` MUST emit (even if `ui_behavior` describes it in prose)
- If the story requires a new auth / RLS rule → `proposals.auth` MUST emit (even if invariants states the rule)
- If the story introduces APIs without explicit request/response in the issue → `proposals.api_shape` MUST emit alongside `api_contract`

### Measurable scope

- **`@slowcook-ai/cli`**: `0.11.1 → 0.11.2` — one-section prompt tightening; no code change
- 160 tests green (unchanged)
- No other package changes

---

## 0.11.1 — Refine emit-round YAML robustness

Hot-fix to 0.11.0's emit round. Two fixes shipped together:

### Prompt: forbid prose preamble before the YAML

0.11.0's new §Proposals section added an encouragement to include a "short summary line at the top of your emit response." That conflicted with the existing instruction "output ONLY the YAML, nothing before or after, starting with `---`." The agent tried to satisfy both — emitted a preamble line, then `---`, then YAML — and the YAML parser either tripped on the unexpected leading prose or choked on a stray `---` elsewhere in the output.

**Fix:** §Proposals now explicitly re-asserts the strict YAML-only rule at emit time. The YAML's own top-level fields (`title`, `invariants`, `acceptance_scenarios`, `proposals`) are the summary — no prose wrapper.

### Parser: tolerate multi-document + prose preamble

Defense-in-depth for LLM emit variance:

- `extractYamlBlock` now recognises a `---` line anywhere in the output (not just the start) when followed by spec-shaped content. Prose preambles no longer crash parsing.
- `parseAgentOutput` uses `YAML.parseAllDocuments` + picks the first valid spec doc. An accidentally doubled `---` separator, or a literal `---` inside a pipe block scalar, no longer throws `MULTIPLE_DOCS`.

### Caught by

Dogfood on rewo issue #22 (R3-002: Myself timeline / bookmarks). Refine's question round worked perfectly (5 sharp questions for $0.38); the emit round tripped the parser. 0.11.1 unblocks.

### Measurable scope

- **`@slowcook-ai/cli`**: `0.11.0 → 0.11.1` — prompt clarification + parser hardening.
- 160 tests green (unchanged).
- No other package changes.

---

## 0.11.0 — Refinement proposals (detect missing context → propose defaults)

Refine agent graduates from "translate issue to spec" to "translate issue to spec **+ propose what the issue author didn't specify**." First slice of the refinement-proposals arc (0.11 → 0.12). See [`docs/plans/0.11-refinement-proposals.md`](./docs/plans/0.11-refinement-proposals.md).

### What ships

- **8-category proposal block in spec YAML** — `schema`, `ui_layout`, `routes`, `auth`, `perf_budget`, `observability`, `infra`, `api_shape`. Each carries `status` (pending/approved/rejected/deferred/blocked_on_clarification), `proposed_by`, `approved_by`, `approved_at`, `rationale`, and category-specific fields.
- **Mermaid ERD generator** (`ddlToMermaidErd`) — shallow Postgres-DDL → `erDiagram`. Parses `create table` + `alter table add column`; captures FK relationships, column types (uuid/text/int/timestamptz/…), PK/NN/FK hints.
- **Refine prompt extension** — new §Proposals section instructs the agent in the detect/propose/defer/ask rubric. Propose when project context supplies grounding; defer when the gap genuinely doesn't matter; ask when proposing would be speculation.
- **PR body rendering** — draft spec PR now has a "## Proposals" section with status badges (⏳ pending / ✅ approved / 🟡 deferred / ❌ rejected / ❓ blocked), Mermaid ERD for schema, markdown tables for routes, token lists for UI layout. Humans review + resolve each.
- **Non-breaking schema evolution** — `Spec.proposals` is optional; pre-0.11 specs keep validating without modification.

### What's NOT in 0.11.0 (deferred)

- **`/refine` resubmit workflow** — PM comments `/refine` on the spec PR → agent reads feedback → amends proposals on the same branch. Landing in 0.11.1.
- **Brew reading proposals for allowed-paths** — 0.11.1. Brew's `supabase/migrations/**` allowed-path is already open (0.7.17+), so approved schema proposals don't need new allowed-path wiring to close — but the brew prompt should be updated to reference `proposals.schema.sql` as authoritative DDL. Small change; defer.
- **Mockup generation** — 0.12.0. Draft plan at `docs/plans/0.12-mockup-first-refinement.md`.
- **Review overlay package** — 0.12.1. Draft plan at `docs/plans/0.12.1-review-overlay.md`.
- **Brownfield extraction** — 0.12.2. Covered in 0.12's Brownfield section.

### Measurable scope

- **`@slowcook-ai/core`**: `0.8.0 → 0.11.0` — additive `Spec.proposals` interface + per-category shapes (schema/ui_layout/routes/auth/perf_budget/observability/infra/api_shape). Non-breaking.
- **`@slowcook-ai/cli`**: `0.9.1 → 0.11.0` — prompts.ts gains §Proposals + `renderProposalsSection`; new `refine/mermaid.ts` DDL-to-ERD; spec-yaml.ts zod extension; agent.ts passes spec into `draftPrBody`.
- **Tests**: 160 green across 7 packages (+16 new: 8 Mermaid parser, 8 proposals PR rendering).
- `@slowcook-ai/stack-ts`, `@slowcook-ai/forge-github`, `@slowcook-ai/llm-anthropic`, `@slowcook-ai/recorder`, `@slowcook-ai/gates` unchanged.

---

## 0.10.0 — Gate 1: deterministic mechanical UI checks (`@slowcook-ai/gates`)

New workspace package `@slowcook-ai/gates@0.10.0`. Wraps Playwright's `Page` API with three deterministic checks that run alongside the screenshot capture from 0.9.2. Gate 2 (AI vision) and Gate 3 (HITL via PR comments) land in 0.10.1 and 0.10.2.

### Checks

- **`checkContrast(page)`** — WCAG 2.1 AA contrast on visible text. Inline relative-luminance algorithm; no axe dependency. Thresholds: 4.5:1 normal text, 3.0:1 large (≥24px or ≥18.66px bold).
- **`checkTapTargets(page, { minSize: 44 })`** — flags interactive elements (`button`, `a[href]`, `input`, `select`, `[role="button"]`, `[onclick]`) below 44×44 CSS px. Override threshold per-call.
- **`checkNoOverflow(page)`** — `document.scrollWidth > window.innerWidth` → report + name the three widest offenders by `right` edge.

Plus a `runGate1(page)` orchestrator that runs all three in parallel.

Every check returns `GateViolation[]` with `{ gate, selector, evidence, category }`. Empty array = clean; caller asserts `toEqual([])`.

### What's NOT in 0.10.0

- **Gate 2 (AI vision)** — Claude vision review of 0.9.2's screenshots vs spec `ui_behavior` prose. Ships in 0.10.1. Requires extending `LlmClient` with a vision-capable variant.
- **Gate 3 (HITL)** — PR-comment delivery + PM reply loop + `aesthetic-sensitive` label gating. Ships in 0.10.2.
- **Focus-ring visibility** — noted in the Gate 1 design but not implemented in 0.10.0 (needs keyboard-nav simulation, more fragile than the three shipped checks). Follow-up.

### Consumer adoption

```ts
import { runGate1 } from "@slowcook-ai/gates";

test("mobile Gate 1 clean", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/u/alice");
  expect(await runGate1(page)).toEqual([]);
});
```

Peer dep `@playwright/test ^1.40.0` — consumers already installed it in 0.9.0. No new devDependency churn.

### Measurable scope

- **New package**: `@slowcook-ai/gates@0.10.0` — 5 source files (index, types, contrast, tap-targets, overflow) + README. First publish.
- 244 workspace tests green (no new gate tests shipped in 0.10.0 — checks exercise Playwright's `page.evaluate` which requires a real browser; integration tests live in consumer repos like rewo's tier-2 suite).

---

## 0.9.2 — Screenshot capture helper (tier-2 matrix)

Third slice of the 0.9 track. Ships the helper that captures per-viewport × colour-scheme screenshots during tier-2 runs — the inputs Gate 1/2/3 (0.10) will consume.

### New helper in `@slowcook-ai/stack-ts@0.9.2`

- **`getAcceptanceScreenshotHelper()`** — emits `tests/acceptance/_setup/screenshots.ts` template.
- **`captureScreenshots({page, storyId, matrix?})`** — iterates `DEFAULT_MATRIX` (desktop-light 1440×900, mobile-light 390×844, mobile-dark 390×844 with `prefers-color-scheme: dark`). Outputs to `test-results/screenshots/story-<id>/<viewport>-<scheme>.png`. Consumers extend the matrix per-story.
- Playwright's default `test-results/` dir is already in `.gitignore` and uploaded as artifact on failure by the 0.9.0 workflow — no new CI wiring needed.

### What's NOT in 0.9.2

- **MinIO storage** — deferred. GHA artifacts (30-day retention) are sufficient until Gate 1/2/3 needs longer retention.
- **Init-plan wiring** — the helper is exported but `slowcook init` doesn't emit it yet. Consumers hand-copy from `getAcceptanceScreenshotHelper()` output or wait for a future `init` refresh. No blocker for rewo (already hand-scaffolded).

### Measurable scope

- **`@slowcook-ai/stack-ts`**: `0.9.0 → 0.9.2` — one new template function.
- Full plan: [`docs/plans/0.9-tier-2-acceptance.md`](./docs/plans/0.9-tier-2-acceptance.md) §0.9.2.

---

## 0.9.1 — Recorder + scrubber + fixture staleness

Second slice of the 0.9 track. Makes tier-2 tests deterministic: record real service calls once, replay them offline on every CI run. Catches secret-leak-into-committed-fixtures at the registry level.

### New package `@slowcook-ai/recorder@0.9.1`

- **`createRecordingFetch({storyId, service, mode?})`** — wraps a `fetch`-compatible function with three modes:
  - `record` — call the real service, save request + response (scrubbed) to `tests/fixtures/<story>/<service>/<hash>.json`
  - `replay` — match request by stable hash, return fixture; error if no match
  - `passthrough` — unchanged fetch (default)
  Mode auto-selected from env: `SLOWCOOK_RECORD=1` / `SLOWCOOK_REPLAY=1` / unset.
- **`hashRequest({method, url, body?})`** — 12-char hex hash. Order-insensitive for query params and body keys; value-sensitive for everything else.
- **`scrub(value, config?)`** — replaces UUIDs, ISO timestamps, emails, JWTs, Supabase keys (`sbp_`/`sb_`), Bearer tokens with placeholders. Configurable via `{ allowList, custom, skip }`.
- **`detectUnscrubbed(value, config?)`** — returns patterns still present in a value. Empty = clean.
- **`findStaleFixtures({maxAgeDays?, storyId?})`** — scans fixture files' `recorded_at` field, returns fixtures older than threshold. Default 14 days.

### New CLI command `slowcook fixtures check`

Added to `@slowcook-ai/cli@0.9.1`. Runs in CI to fail PRs where:
- Fixtures are stale (older than `--max-age-days`, default 14)
- Fixtures contain unscrubbed patterns (leaked secrets, PII, volatile timestamps)

Honours a per-story exemption: if a spec contains a `@fixtures-frozen <reason>` marker, the story's staleness check is skipped. The scrub guard always runs.

### Consumer adoption

Consumers integrate by passing `createRecordingFetch({...})` into their Supabase client factory:

```ts
import { createRecordingFetch } from "@slowcook-ai/recorder";
const recording = createRecordingFetch({ storyId: "005", service: "supabase" });
const supabase = createClient(url, key, { global: { fetch: recording } });
```

Then run acceptance tests once with `SLOWCOOK_RECORD=1` to capture fixtures, commit them, and subsequent CI runs use `SLOWCOOK_REPLAY=1` to stay offline + deterministic.

### Measurable scope

- **New package**: `@slowcook-ai/recorder@0.9.1` — 4 source files (hash, scrub, fetch-recorder, staleness) + 3 test files. First publish.
- **`@slowcook-ai/cli`**: `0.9.0 → 0.9.1` — new `fixtures check` subcommand; adds `@slowcook-ai/recorder` as dependency.
- 268 tests green across 6 packages (+24 new recorder tests).
- Full plan: [`docs/plans/0.9-tier-2-acceptance.md`](./docs/plans/0.9-tier-2-acceptance.md) §0.9.1.

---

## 0.9.0 — Tier-2 acceptance runner: Playwright scaffolds + workflow

Adds the runner + templates for tier-2 acceptance tests. Catches the gap class tier-1 can't: "feature works end-to-end against real Supabase + real Next." First slice of the three-release 0.9 track (see [`docs/plans/0.9-tier-2-acceptance.md`](./docs/plans/0.9-tier-2-acceptance.md)).

### What ships in 0.9.0

- **`slowcook-acceptance.yml` workflow** (via `@slowcook-ai/forge-github@0.9.0`): fires on brew PRs + nightly cron + manual dispatch. Runs Playwright against a real dev server + real staging Supabase. Skips cleanly with a notice if `ACCEPTANCE_SUPABASE_URL` / `ACCEPTANCE_SUPABASE_KEY` secrets aren't set — lets consumers adopt tier-2 gradually. Uploads Playwright report as artifact on failure.
- **Stack config extensions** (via `@slowcook-ai/stack-ts@0.9.0`):
  - `.brewing/stack.json` now declares an `acceptance` test suite with Playwright runner
  - `playwright.config.ts`, `playwright.config.mjs`, `playwright.config.js` added to frozen files
  - `tests/acceptance/` added to frozen directories — brew can't silently rewrite tier-2 specs
  - New scaffold helpers:
    - `getPlaywrightConfig()` — minimal chromium-only Playwright config scaffold
    - `getAcceptanceSandboxHelper()` — `tests/acceptance/_setup/sandbox.ts` re-exports `test`/`expect` so consumer tests converge on one import path
    - `getAcceptanceEnvExample()` — `.env.acceptance.example` template

### What DOESN'T ship in 0.9.0 (see 0.9.1 / 0.9.2)

- **Recorder + scrubber + fixture staleness** — 0.9.1. Tier-2 in 0.9.0 hits live Supabase with hand-seeded data; flakiness is a known-known until fixtures replace live calls.
- **Screenshot capture + MinIO storage** — 0.9.2. 0.9.0 uses GHA artifact for report bundles; 0.9.2 promotes to persistent storage.
- **Testgen for tier-2** — deferred to 0.11 (needs the recorder first).
- **Gates 1/2/3** — 0.10 (they GRADE inputs 0.9 captures).

### Consumer adoption

Consumers that run `slowcook init` after the 0.9.0 release get the scaffolds automatically. Existing consumers can:

1. Add the workflow template manually, or re-init.
2. Provide staging Supabase credentials as GitHub Actions secrets (`ACCEPTANCE_SUPABASE_URL`, `ACCEPTANCE_SUPABASE_KEY`, optional `ACCEPTANCE_TEST_EMAIL` / `ACCEPTANCE_TEST_HANDLE`).
3. Author first acceptance test at `tests/acceptance/story-N.spec.ts` — Playwright's standard API.

Workflow no-ops silently without secrets — safe to commit the template before wiring credentials.

### Measurable scope

- **`@slowcook-ai/stack-ts`**: `0.7.16 → 0.9.0` — acceptance suite in stack config; Playwright-config / sandbox / env-example scaffold helpers; frozen paths extended.
- **`@slowcook-ai/forge-github`**: `0.7.12 → 0.9.0` — new `slowcook-acceptance.yml` template, registered in `getGitHubCiArtifacts`.
- **`@slowcook-ai/cli`**: `0.8.0 → 0.9.0` — re-pulls the new stack-ts + forge-github templates through `slowcook init`. No CLI-surface change.
- `core` + `llm-anthropic` unchanged at `0.8.0`.
- 220 tests green.

---

## 0.8.0 — LLM adapter refactor: `@slowcook-ai/llm-anthropic` extracted

New workspace package `@slowcook-ai/llm-anthropic` carrying the Anthropic `LlmClient` implementation + Anthropic-specific cost accounting (`PRICING_PER_M_TOKENS`, `costUsdForUsage`, `costMarker`, `parseCostMarkers`). The `LlmClient` interface itself moves to `@slowcook-ai/core` so agents can depend on the shape without dragging in a specific provider's SDK.

### Why

The CLI's `refine/llm.ts` accumulated the Anthropic SDK, the `LlmClient` interface, the pricing table, and the cost-marker plumbing in one file. That worked while there was only one provider, but (a) made swapping providers a source-edit rather than a package-boundary change, and (b) forced everyone importing the interface to transitively depend on `@anthropic-ai/sdk`. 0.8 cleanly decouples those.

User framing (2026-04-23): *"not asking for IMPLEMENTATION for other llm models, I am asking for ABSTRACTION that enables DECOUPLING."*

### What changed

- **New package `@slowcook-ai/llm-anthropic@0.8.0`** — first publish. Exports `AnthropicClient` + cost helpers. Depends on `@slowcook-ai/core` + `@anthropic-ai/sdk`.
- **`@slowcook-ai/core@0.8.0`** — gains `LlmClient`, `LlmMessage`, `LlmRequest`, `LlmResponse`, `LlmUsage` types (from `packages/core/src/llm.ts`). Additive export; no breaking change.
- **`@slowcook-ai/cli@0.8.0`** — `packages/cli/src/commands/refine/llm.ts` becomes a thin re-export shim so existing call sites (`from "../refine/llm.js"`) keep working unchanged. Adds `@slowcook-ai/llm-anthropic` as a dependency.

### What DIDN'T change

- **Brew's tool-use path.** Brew imports `@anthropic-ai/sdk` directly for `Anthropic.Messages.Tool` / `ToolUseBlock` / `ToolResultBlockParam` / cache_control. That surface is Anthropic-specific and hasn't been generalised yet — a provider-agnostic tool-use interface is a larger design exercise for 0.9+. Brew continues to import the SDK directly as a documented temporary boundary.
- **Behaviour.** Same models, same prompts, same costs, same output. Pure package split.
- **Consumer commands.** `slowcook init`, `refine`, `testgen`, `brew`, `dispatch` — identical CLI surface.

### Publish order

1. `@slowcook-ai/core@0.8.0` — additive interface export.
2. `@slowcook-ai/llm-anthropic@0.8.0` — first publish. Depends on core.
3. `@slowcook-ai/cli@0.8.0` — depends on both.

`prepublishOnly: tsc -b` on all three guarantees fresh `dist/` per the build-before-publish rule.

### Measurable scope

- **220 tests green** across all packages (+13 pricing tests moved to llm-anthropic; 0 net loss).
- Full plan doc: [`docs/plans/0.8-llm-adapter-refactor.md`](./docs/plans/0.8-llm-adapter-refactor.md).

### What this unlocks

A second provider becomes an additive package (`@slowcook-ai/llm-openai`, say) — not a refactor of the CLI. Pricing is now per-provider data, not a central registry. Cost markers stay uniform across providers.

---

## 0.7.21 — Styling presence assertions + fake-timers correction

Two fixes pulled from the story-005 dogfood post-mortem (2026-04-23):

### 1. Styling presence assertions (the proper structural fix)

0.7.20 leaned on prompt steering for visual conventions. User pushback: why don't we add styling tests? Right answer. Prompt steering is a soft signal; a test is a hard one. Added a third deterministic tier-1 assertion file — joins page-link (0.7.17) and schema (0.7.18):

**`tests/integration/story-N-styling.test.ts`** — static source-file scan of the component named in `<page_link>`. Three assertions:

1. Component file exists.
2. At least 4 `className=` occurrences (raw unstyled HTML has 0-1; a real styled component has many).
3. At least one class from the project's design-token family (`bg-|text-|border-|rounded|px-|py-|space-y-|flex|grid|mt-|mb-|gap-`).

**Presence** checks, not pixel-perfect visual regression. Doesn't couple to specific tokens — brew can pick `bg-coral`, `bg-primary`, whatever the consumer's design system uses. No jsdom, no fixture required. Closes the "brew ships zero-className components" failure mode directly at the measured-signal level.

Brew's prompt gains a corresponding section telling the agent that when the target is a `-styling.test.ts`, the fix is to add Tailwind classes (reading `.brewing/context.md`'s Visual conventions section for the specific tokens, or imitating neighbouring files if context.md is silent).

### 2. Fake-timers correction in testgen prompt

Testgen's UI-test prompt previously said "Fake timers for anything debounced". The LLM read this as permission to declare `vi.useFakeTimers()` in a shared `beforeEach`. Vitest v4 fakes `queueMicrotask` by default → `await fetch(...)` promises never resolve → `findByText` times out at 5s.

Observed on rewo story-005: 6 of 11 UI tests timed out; brew halted `AGENT_STALLED_NO_EDITS` after 2 consecutive zero-edit iters because `tests/` is frozen — brew couldn't fix the buggy test file. (Brew's report was accurate: 80 green was real; the 6 reds were structurally unreachable.)

**Fix:** tighter guidance in `TESTGEN_SYSTEM` — default to real timers at the describe level; flip to fake timers ONLY inside the specific `it()` that needs them; always `await vi.advanceTimersByTimeAsync(ms)` + `vi.useRealTimers()` before the test body ends. Never in shared `beforeEach`.

### Measurable scope

- **`@slowcook-ai/cli`**: `0.7.20 → 0.7.21`.
- 157 tests (+2 new regression guards).
- No other package changes.

---

## 0.7.20 — brew prompt: steer toward project visual conventions

Third recurring gap class (after page-integration + schema): brew shipping zero-className components because tier-1 tests don't assert visual style. Observed twice on rewo on 2026-04-23 (story-006 ProfileEditForm shipped via PR #61, story-005 MemberReactionsPage shipped via PR #66). Both components were functionally correct, axe-clean, tests-green — and visually unusable. User restyled both by hand.

**Fix:** the "UI component tests" section of brew's prompt gains a bullet:

> Match the project's visual conventions. Tier-1 tests query by role/label/text and don't assert styling — but the user STILL has to look at what you ship. A component with zero `className` attributes is incomplete even if every test passes. Read `.brewing/context.md` for the project's design-token names + reusable class patterns (buttons, inputs, alerts, labels) before writing the component body. If context.md is silent on styling, imitate neighbouring files in `src/components/` / `src/app/(main)/` — match their spacing, border, focus-ring, and colour-token choices.

The consumer-side of this is a "Visual conventions" section in `.brewing/context.md` listing the project's design tokens + reusable patterns. Rewo's was updated manually (commit 05d4f91); other consumers should add one.

**Why this might not be enough:** prompt steering is a soft signal. The hard signal is still "tests pass." If brew is rushed or fighting a red test, it may ignore styling guidance. The durable answer is **tier-2 screenshot review** (slowcook 0.8) — Playwright screenshot + LLM "does this look like the rest of the app?" gate. Until then, steering is the cheapest available correction.

### Measurable scope

- **`@slowcook-ai/cli`**: `0.7.19 → 0.7.20` — one bullet in `packages/cli/src/commands/brew/prompts.ts`.
- No other package changes.

---

## 0.7.19 — page-link test names are static literals; forge-github drops `cache: npm`

### cli: static test-name literals in page-link assertion

0.7.17's `buildPageLinkTestContent` used runtime string concatenation in `it(...)` names:
```ts
it("imports " + component + " from " + importFrom, () => { ... })
```

Testgen's manifest extractor parses the file statically and records the first literal ("imports "). Vitest resolves the full concat at runtime ("imports ProfileEditForm from @/components/profile/ProfileEditForm"). IDs diverge → `MANIFEST_DRIFT` halt on brew.

Caught on the story-005 dogfood run (2026-04-23, 21:06 UTC): brew halted at iteration 0 ($0.00 spent) citing "2 of the story's tests are invisible to the runner. First missing: `... > imports `".

**Fix:** testgen inlines `component` + `importFrom` into literal strings at generation time. Manifest IDs now match vitest's runtime IDs verbatim.

### forge-github: drop cache: npm (carried over from 0.7.19 pre-publish)

Same as previously documented — `actions/setup-node@v4` with `cache: npm` captured `~/.npm/_npx` and produced 55k-line tar-restore spam on consumer CI. Template no longer opts in.

### Measurable scope

- **`@slowcook-ai/cli`**: `0.7.18 → 0.7.19`.
- **`@slowcook-ai/forge-github`**: `0.7.11 → 0.7.12`.

155 tests green (+1 new regression guard on static test-name emission).

---

## 0.7.18 — Schema assertion widens to preconditions + acceptance_scenarios

Dogfood of 0.7.17 on rewo story-005 (2026-04-23 ~20:47 UTC) caught the schema assertion MISSING the column the spec described. Diagnosis:

- Story-005's DDL signal lives in `preconditions`, not `invariants`: `` "`profiles.handle` column exists, is unique, and is populated for every profile (backfill migration part of this story)" ``.
- 0.7.17's `extractDdlColumnsFromInvariants` only scanned `spec.invariants` and only matched the explicit `Migration adds …` phrasing. Story-005 used the implicit shape — the scanner walked past it.

**Fix:**
- Renamed `extractDdlColumnsFromInvariants` → `extractDdlColumnsFromStrings` (operates on arbitrary strings); added `extractDdlColumnsFromSpec(spec)` that scans `invariants + preconditions + acceptance_scenarios` in one pass. Kept a shim for the old name so existing callers don't break.
- Widened the regex with a second matching path: any `` `table.column` `` reference counts as DDL intent **when the same string also carries a migration keyword** (`migration`, `backfill`, `alter table`, `add column`, `not null`, `unique`). Avoids false positives on incidental `profiles.id` prose references.
- Mode-instruction for testgen's LLM now explicitly names `<page_link>` in both `full` and `ui-only` modes (empirically the 0.7.17 LLM emitted it anyway, but the instruction was ambiguous).

### Measurable scope

- **`@slowcook-ai/cli`**: `0.7.17 → 0.7.18` — `extractDdlColumns*` + mode-instruction text.
- No other package changes.

---

## 0.7.17 — Pipeline-gap static assertions (page-link + schema)

Closes two recurring gaps where the autonomous pipeline shipped green while the feature was invisible to the user. Both hit on rewo story-005/006 on 2026-04-23; the hand-patches to recover are the "why this release exists" evidence.

### Gap 1 — page-to-component wiring

Tier-1 UI tests render the component directly (`renderWithProviders(<ProfileEditForm .../>)`), so a page that never imports the component still passes tier-1. On rewo story-006, `ProfileEditForm` shipped + tested + merged, but `src/app/(main)/profile/page.tsx` never mounted it. User navigated to `/profile` → blank section.

**Fix:** testgen now parses an optional `<page_link>` block from the LLM bundle:

```
<page_link>
  <page>src/app/(main)/profile/page.tsx</page>
  <component>ProfileEditForm</component>
  <import_from>@/components/profile/ProfileEditForm</import_from>
</page_link>
```

When present, it deterministically templates `tests/integration/story-N-page.test.ts` asserting the named page file imports AND mounts the component via regex. Brew's iteration closes the test by editing the page — allowed-paths already covers `src/app/**/*.tsx`, and brew's prompt now has a dedicated "Page-link assertion" section.

### Gap 2 — DB migrations

Handler tests mock the DB via `mockSupabase`; tier-0 acceptance is HTTP-loopback with seed fixtures. No pipeline stage interacts with a real schema. Story-005 and story-006 each described required DDL in their spec invariants (`Migration adds profiles.handle_confirmed boolean not null default false`, etc.) — neither migration ever landed. User's `/profile` query returned `null` and the form didn't render until the migrations were hand-written.

**Fix:** testgen deterministically scans `spec.invariants` for DDL keywords (`Migration adds`, `alter table … add column`) and emits `tests/schema/story-N.test.ts`. The test reads every `.sql` in `supabase/migrations/` and asserts each named column appears in an `add column` statement. No LLM cost — the scan + template is mechanical. Brew's prompt now carries a "Schema-assertion tests" section instructing the agent to append a new numbered migration file. Allowed-paths needed no change (`supabase/migrations/**` was never frozen).

### Drive-by fixes (same release)

- **`--spec story-005` no longer silently no-ops.** The CLI normalises a leading `story-` prefix before path lookups (`readSpec`, `handlerTestPathFor`) and throws — instead of silently skipping — when `--spec <id>` names a non-existent spec. Tripped this on the story-005 dogfood run the same day.
- **`slowcook-testgen.yml` template accepts `workflow_dispatch.inputs.spec`.** Empty = `--all`; non-empty = `--spec <id>`. Brings the template into parity with rewo's 2026-04-23 divergence.
- **Brew prompt gains two new "target-test-class" sections.** Schema-assertion tests and page-link assertions each get their own short guide so the agent knows the right file-class to edit (new migration under `supabase/migrations/`; existing page under `src/app/`).

### Measurable scope

- **`@slowcook-ai/cli`**: `0.7.15 → 0.7.17` — testgen agent + prompts + CLI args + brew prompt.
- **`@slowcook-ai/forge-github`**: `0.7.10 → 0.7.11` — testgen workflow template.
- No `core` / `stack-ts` changes.

### Detailed plan doc

`docs/plans/0.7.17-pipeline-gap-assertions.md` — enumerates the two-gap theory, the acceptance cases, and the dogfood validation plan.

---

## 0.7.16 — UI testing helpers: auto-cleanup between tests (identified by brew agent)

Silent bug in Phase A (0.7.5) render helper. The scaffolded \`tests/helpers/render.tsx\` wrapped \`@testing-library/react\`'s \`render\` but didn't register \`afterEach(cleanup)\`. Result: components from a prior test linger in jsdom's DOM; the next test's \`getByRole / queryByRole\` sees stale elements. Manifests as "the assertion doesn't match the code" false-positive failures across tests that render the same component with different props.

**Diagnosed by the brew agent** on rewo story-006 UI (2026-04-23):

> "Maybe the issue is that the story-006-ui.test.tsx file itself uses beforeEach / afterEach but doesn't call cleanup(). In React Testing Library, cleanup should be called after each test to unmount components. In Vitest, by default, @testing-library/react auto-cleanup might not be configured."

Observed during the rationale capture added in 0.7.15 (the agent burned 12 tool rounds reading test infra — previously invisible; now the \`ITER N TOOLS\` trace made the reasoning legible).

**Measurable impact on rewo:**

- Before fix: 10 / 21 story-006 UI tests passing
- After fix: 20 / 21 passing (+10 unmasked by cleanup)

The one remaining red test is a genuine component gap (avatar emoji picker renders multiple buttons matching a regex the test expects to match one) — actually-brewable signal now that the DOM-leak noise is gone.

**Fix:**

\`stack-ts\` \`renderHelper()\` template now includes:

\`\`\`tsx
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => { cleanup(); });
\`\`\`

Registered at module-top level, so any test file importing \`renderWithProviders\` gets cleanup automatically for every test in that file.

**Version jump:** \`@slowcook-ai/stack-ts 0.7.11 → 0.7.16\`. CLI / core / forge-github unchanged.

**Adoption (existing consumers):**

Same choice as 0.7.11 — hand-edit \`tests/helpers/render.tsx\` to add the three lines above, OR \`slowcook init --force\` regenerates all helpers from 0.7.16. Rewo takes the hand-edit route per the same override-freeze pattern.

## 0.7.15 — Brew log richness + diagnostic fixes

Surfaced by the 0.7.14 test run on rewo story-006 UI:
- Agent halted via \`AGENT_STALLED_NO_EDITS\` (Fix 4 worked — saved \$5/run).
- But rationale was **empty** on both halted iterations. Operator couldn't see what the agent was thinking.
- CI log showed only \`ITER N/M START\` + \`HALT\` lines — no visibility into what the agent did during the turn.

Three fixes:

**1. Capture rationale on tool-loop-cap exit.** Previously rationale was only set when the model produced a text-only completion block (i.e., stopped calling tools). If the agent hit the 12-round tool-loop cap without ever going text-only, rationale stayed empty — the halt report had nothing to show. Now we track \`latestTextBlock\` across all rounds; if the cap hits with no text-only completion, fall back to the last text we saw with a prefix noting what happened. Halt report always has diagnostic content.

**2. Per-turn tool-call trace.** Every tool call in \`runTurn\` now appends to a \`toolCallTrace\` array. After the turn, appended to the iter log as \`ITER N TOOLS K/N calls: outline_file(path), read_file(path), ...\`. Reveals the agent's exploration pattern on a stuck turn — the difference between "agent did nothing" and "agent spent 12 rounds exploring without ever editing." \`summarizeToolInput()\` helper keeps the line compact (no JSON payloads, just the relevant path/method).

**3. \`appendRunLog\` for every iteration outcome.** Added missing log lines for:
- \`NO-EDITS\` case (0 tool edits) — shows spend_delta + consecutive_no_edits + stagnation counters
- \`REJECT frozen-path\` — which frozen path, with spend
- \`REJECT scope-violation\` — which outside-allowed path
- \`REJECT overflow\` — lines × files vs caps, note that agent didn't justify

Combined with 0.7.13's appendRunLog-to-stdout mirror, every iteration now produces at least one informative line in CI logs.

**Expected impact on the rewo story-006 re-run:** operator sees the agent's exploration pattern (outline_file, read_file calls) within each stuck iteration — can diagnose whether the agent is reading the wrong files, re-reading the same files, or genuinely looking at the right place but not committing.

**Version:** \`@slowcook-ai/cli 0.7.14 → 0.7.15\`. 136 cli tests still green. No API-contract changes.

## 0.7.14 — Brew analysis-paralysis fixes (4 leverage points)

User report after two stuck brew runs on rewo story-006 UI (\$3.39 + \$5.48 total, 0 of 11 remaining UI tests turned green): "what's your plan to avoid analysis paralysis on the DOM?"

Root cause identified: brew's turn prompt tells the agent which tests are green/red by ID, but not what the failures actually looked like. When a vitest UI assertion fails with *"expected no \`role=alert\`; Received: \`<div role=\"alert\" ... />\`"*, the agent sees only "this test ID is red." It then reasons abstractly about its own code (*"line 47 says \`!handle_confirmed && ...\` — shouldn't render"*) and can't reconcile with the test's verdict. Paralysis.

Four fixes in ascending leverage:

**Fix 1 (biggest lever): pipe test failure messages into the turn prompt.** Brew's test runner already captures \`failure_message\` per test (up to 500 chars of the vitest assertion output including the \`Received:\` payload). \`runTurn\` now passes the target test's failure message + 5 peripheral red failures into a new prompt section \`### Why the target failed last run\`. Agent reads the actual DOM snippet vitest saw → can't hide from ground truth. Failure-message lookup map (\`failureMessagesByTestId\`) seeded from baseline + refreshed after every iteration's test run.

**Fix 2: prompt addition for diagnostic probing.** \`BREW_SYSTEM\` gains a new "When you're stuck" section teaching the agent:
- Read the \`Received:\` payload FIRST, before re-inspecting your own code
- If still unclear, insert \`console.log(screen.debug())\` OR a \`data-testid="probe-iter-N"\` attribute as a **one-iteration diagnostic**. The ratchet reverts it; the NEXT prompt's failure message will show the DOM output.
- Specific anti-pattern called out: *"the code LOOKS like it shouldn't render X, but the test says X is in the document"* — almost always means another element matches the same selector, not a JSX evaluation bug.

**Fix 3: voluntary-halt escape hatch.** \`BREW_SYSTEM\` instructs the agent: if stuck 3+ iterations on the same target, end rationale with \`"Considering halting voluntarily"\` + a concrete description of the mismatch. Ratchet detects the string (case-insensitive regex) on a no-edits iteration + halts immediately with new halt reason \`AGENT_SELF_REPORTED_STUCK\` + the description in the halt report. Saves ~15 iterations of silent spend.

**Fix 4: early-halt on 2 consecutive zero-edit iterations.** Mechanical safety-net when the agent goes silent (produces no tool calls despite burning context tokens). New halt reason \`AGENT_STALLED_NO_EDITS\`. Previously iters 14+15 of the second story-006 UI run were zero-edit burns worth ~\$0.60; this halt catches after the second zero-edit iter.

Both new halt reasons get suggested-actions entries in \`defaultSuggestedActions()\`.

**Deferred to later: Fix 5.** A \`render_and_debug(component_path, props)\` tool that spawns a vitest helper + returns the rendered DOM directly. Higher leverage than Fixes 1-2 but significantly more work. Memory saved at \`project_brew_render_debug_tool.md\` — revisit if 1-4 don't resolve residual paralysis.

**Version:** \`@slowcook-ai/cli 0.7.13 → 0.7.14\`. 136 cli tests still green (no API-contract changes).

**Expected impact on a re-run of story-006 UI brew:** the stuck test was \`does NOT show the auto-assigned warning when handle_confirmed=true\`. With Fix 1, the agent will see vitest's \`Received:\` payload identifying WHICH element has \`role=alert\` in the rendered DOM. With Fix 2's prompt guidance, if the payload doesn't suffice, it'll probe. With Fix 3, if still stuck, it self-reports after 3 iters instead of 15. Fix 4 catches any residual silent-agent pathology.

## 0.7.13 — Brew iteration log mirrors to stdout (visible in CI)

User reported: "what do you see in the brew log? why don't I see better output in the GitHub Actions output? just iterations, nothing about progress."

Root cause: `appendRunLog()` wrote iter-level progress (spend deltas, files touched, green-count deltas, ratchet outcomes, broken-test IDs on regressions, push/PR-open results, code-map regen events) ONLY to the rolling file at `.brewing/runs/<ts>/iterations.log`. Stdout only got:

- `→ baseline test run…`
- `→ baseline: X green, Y red / Z total`
- `=== iteration N/M — target: ... ===` headers
- Final halt report

Everything BETWEEN iteration headers was invisible unless you downloaded the halt artifact. On a 10-iteration brew that halted at ITERATION_CAP, operators had to wait until the end + download the artifact to see what happened per-iteration.

Fix: `appendRunLog` now also writes each line to stdout (prefixed with two spaces for indent). 15 call sites across brew's ratchet loop + halt path.

Example of the new CI log shape per iteration:

```
=== iteration 3/20 — target: tests/integration/story-006-ui.test.tsx > ... warning banner ===
  ITER 3/20 START  target=...  spend=$0.84/10.00
  ITER 3 CHECKPOINT  +2 green  total_green=62/128  files=[src/components/profile/ProfileEditForm.tsx] +12/-4  spend_delta=$0.14
  CODEMAP regenerate after iter 3
```

Halt-path events (push failures, PR-open failures, code-map errors, HALT reason + totals) also surface in stdout now. The iter-log file is unchanged; it's still the canonical record for post-hoc aggregation.

**Version:** `@slowcook-ai/cli 0.7.12 → 0.7.13`. No API / behavior changes outside the new stdout stream. 136 cli tests still green.

## 0.7.12 — `slowcook dispatch` — trigger workflows remotely from the CLI

Ops-UX win observed during rewo's story-006 UI brew cycle: 5× \`gh workflow run slowcook-brew.yml -f story_id=006 -f budget_usd=10 -f max_iterations=20 -f model=claude-sonnet-4-6\` invocations, every flag remembered by hand. The CLI now wraps it:

```bash
slowcook dispatch brew --story 006 --max-iterations 20
slowcook dispatch testgen
slowcook dispatch refine --issue 47   # once the slowcook-refine.yml template gains workflow_dispatch (scheduled for 0.7.13+)
```

Under the hood: Octokit POST to `/repos/{owner}/{repo}/actions/workflows/{file}/dispatches`. Auto-detects `owner/repo` from the `origin` remote. After dispatch, polls briefly for the newly-created run and prints its URL so the operator can click through without hunting.

**Why a new command instead of `--remote` on existing ones:** `slowcook brew --story 006` runs brew LOCALLY on your workstation with your \`$ANTHROPIC_API_KEY\` against your local git state — legitimate dev-cycle usage. `slowcook dispatch brew --story 006` TRIGGERS the remote workflow. Different semantics; separate commands keeps intent clear ("flag changes modifier, not identity").

**Supported steps today:** \`brew\`, \`testgen\`. \`refine\` is scaffolded but will 404 gracefully until \`slowcook-refine.yml\` gains \`workflow_dispatch\` (out of scope for this release; tracked for 0.7.13+).

**Not supported:** \`on-*-merged\` hooks — they fire from \`pull_request.closed\` events and need a PR number, which is ambiguous to "dispatch manually."

**Version:**

- \`@slowcook-ai/cli 0.7.10 → 0.7.12\` (skipping 0.7.11 — that was \`stack-ts\` only; CLI version was already at 0.7.10).
- Other packages unchanged.

+5 new tests for arg parsing + error paths. 136 cli tests green.

## 0.7.11 — Wire jest-dom matchers into the UI tier-1 a11y helper

**Silent-bug fix.** The 0.7.5 Phase A helper scaffolding shipped with a missing one-liner that made every UI test using a jest-dom matcher (toBeInTheDocument, toHaveTextContent, toHaveClass, toBeDisabled, toBeVisible, toHaveAccessibleName, …) fail with a misleading:

```
Error: Invalid Chai property: toBeInTheDocument
```

Root cause: `tests/helpers/a11y.ts` only did `expect.extend(toHaveNoViolations)` for jest-axe, never `import "@testing-library/jest-dom/vitest"` for the DOM matchers. The jest-dom devDep was installed correctly, just never wired into `expect`.

**Blast radius observed on rewo.** First UI brew run (story-006 UI, 37 tests, $3.39 spent) halted with the brew agent stuck in analysis paralysis: 16 tests "failed" with the misleading Chai error; agent read each one as "my component renders this element wrongly," re-inspected its correct code, couldn't reconcile, gave up editing by iter 9. Without this fix, every UI brew run would hit the same wall.

**Fix.** `stack-ts` `a11yHelper()` template now includes `import "@testing-library/jest-dom/vitest"` as a side-effect import above the jest-axe wiring. Auto-extends vitest's `expect` and registers TypeScript augmentations (no per-test `///<reference>` needed).

**Version jump:**

- `@slowcook-ai/stack-ts 0.7.5 → 0.7.11` (template change only; no API surface change)
- `@slowcook-ai/cli`, `@slowcook-ai/core`, `@slowcook-ai/forge-github` unchanged at 0.7.10 / 0.7.1 / 0.7.10 respectively.

**Adoption (existing consumers):**

Option A — hand-edit `tests/helpers/a11y.ts` to add the one-line import above the existing `import { axe as axeCore, toHaveNoViolations } from "jest-axe";`. Single-line change; `tests/helpers/` is a frozen-path directory so needs `override-freeze` label on the PR.

Option B — `npx @slowcook-ai/cli@latest init --force` regenerates all helpers from the 0.7.11 template; clobbers any consumer customisations.

131 cli tests still green (no CLI change); template change verified by the rewo smoke test `phase-a-smoke.test.tsx` once the matcher wiring lands.

## 0.7.10 — Brew PR-open visibility + skip Run-tests on testgen PRs

Two unrelated small fixes surfaced by rewo story-006 UI brew run:

**1. Brew halted with 1 checkpoint but silently failed to open a PR.** Root cause in `haltFor()`: the call was fire-and-forget (`openBrewPullRequest(...).catch(() => {})`) and not awaited. Any error path in forge.createPullRequest got swallowed; the `appendRunLog` WARN inside the inner try/catch landed AFTER the run log was rescued to halts/, so operators had no trace. Fix: `haltFor` is now `async`, `openBrewPullRequest` is awaited, an outer try/catch prints `WARN PR open path threw: ...` to stderr + appends `HALT_PR_OPEN_FAILED` to the iter log. Errors surface loudly, in sequence with everything else.

**2. Run-tests step on PR gate skips testgen PRs.** Rewo PR #56 failed the 0.7.3 PR-gate's `Run tests` step because its new UI tests import component stubs that throw by design (the whole TDD-first invariant). Labels: testgen PRs have `slowcook-tests`; brew PRs have `slowcook-brew`; human PRs have neither. The workflow template now gates the step on `!contains(labels, 'slowcook-tests')` — testgen PRs skip, brew + human PRs still run.

- Observed impact: PR #56 merged with UNSTABLE status (branch protection was off on rewo). After 0.7.10, the step won't even run on testgen PRs, so CI stays green where it should.
- Brew PRs stay gated — by then all tests should be green, and a red here would be a genuine regression.

**Version jumps:**

- `@slowcook-ai/cli 0.7.9 → 0.7.10` (haltFor async + visible PR-open error path)
- `@slowcook-ai/forge-github 0.7.6 → 0.7.10` (workflow template's `Run tests` step gets the label gate)
- core/stack-ts unchanged.

131 cli tests still green.

## 0.7.9 — Cost stats + pipeline-total aggregator

Every agent (refine / testgen / brew) now records its Anthropic spend on the source issue's comment trail as a hidden HTML marker, and `on-brew-merged` sums them into a pipeline-total line on the "shipped 🎉" comment. Makes each issue self-describing: anyone reading the comment trail can see exactly what the autonomous pipeline cost to ship that story.

**What humans see on the source issue:**

```
slowcook · tests opened
[PR #56] — story-006, 37 tests in tests/integration/story-006-ui.test.tsx. Testgen cost: $0.0823.

slowcook · brew opened (SUCCESS)
[PR #57] — story-006, 37/37 green across 4 checkpoints / 6 iterations, $0.41 spent.

slowcook · shipped 🎉
[PR #57] merged — story-006 is now on main.

Pipeline cost:
- refine (3 runs): $0.0471
- testgen: $0.0823
- brew: $0.4112
- Total: $0.5406

Pipeline trail:
...
```

**Under the hood** (hidden from rendered markdown, visible in comment source):

```
<!-- slowcook:cost agent=refine usd=0.0234 tokens_in=1823 tokens_out=567 cache_read=14900 cache_create=0 model=claude-sonnet-4-6 round=questions -->
<!-- slowcook:cost agent=testgen usd=0.0823 tokens_in=4231 tokens_out=8123 cache_read=21000 cache_create=5600 model=claude-sonnet-4-6 -->
<!-- slowcook:cost agent=brew usd=0.4112 iterations=6 checkpoints=4 model=claude-sonnet-4-6 -->
```

Aggregator walks issue comments via GitHub's REST API, parses markers via regex, groups by agent, sums.

**What changed in CLI:**

- `refine/llm.ts` — `LlmClient.complete` now returns `{ text, usage, costUsd, model }` instead of a bare string. Anthropic impl normalizes the SDK's usage counters into the `LlmUsage` shape (inputTokens/outputTokens/cacheReadTokens/cacheCreateTokens). `costUsdForUsage(model, usage)` pure helper lives in the same file.
- `costMarker(...)` + `parseCostMarkers(body)` — shared helpers that emit / read the hidden HTML markers. Covered by 13 new unit tests.
- **refine** accumulates cost across the relationship call + the refinement call; embeds a marker in every comment it posts (questions, overlap-blocker, contradiction-blocker, spec-submitted).
- **testgen** embeds a marker per source-issue comment, one per spec.
- **brew** embeds a marker in both success and halt comments. Uses the existing spend tracker (no new cost math).
- **on-brew-merged** aggregates all three agents' markers from the source issue's comment trail and appends a `**Pipeline cost:**` block to the shipped comment.

**Prep for 0.8 LLM adapter refactor:** the `LlmClient` signature + pricing table now live behind one interface (`refine/llm.ts`). 0.8 lifts this into `@slowcook-ai/core/llm` + `@slowcook-ai/llm-anthropic` as part of the decoupling work. No breaking changes in this release — pure additive.

**Version jumps:**

- `@slowcook-ai/cli 0.7.7 → 0.7.9` (skipping 0.7.8; reserved for the separate Run-tests-on-testgen-PR fix in `feedback_build_before_publish` territory)
- Other packages unchanged.

131 cli tests green (+13 new for cost markers + pricing).

## 0.7.7 — Testgen Phases B + C: UI test bundle + brew UI-aware + Vitest 4 pragma fix

Completes the 0.7.5 bundle ([detailed plan](docs/plans/0.7.5-tier-1-ui.md)): Phase A helpers shipped in 0.7.5; Phases B (testgen UI emission) + C (brew UI-aware prompt) land here, alongside a small post-init text fix.

**Phase B — testgen emits UI tier-1 bundle.**

- New `TestgenMode` union: `"full"` | `"handler-only"` | `"ui-only"`. `collectTargetSpecs` infers the mode per spec based on what already exists on disk: handler test missing → `"handler-only"` or `"full"`; handler present but UI missing and spec has `ui_behavior` → `"ui-only"`. Unlocks the brownfield case — apply UI tests retroactively to a story whose handler was built pre-0.7.5.
- `parseTestgenBundle` gains two new block kinds: `<ui_test_file>` (the `.tsx` test body) and `<ui_stub path="…">` (React component stubs). Signature extended with an optional `mode` parameter that gates which blocks are required; callers passing no mode get `"handler-only"` (back-compat with pre-0.7.7).
- `TESTGEN_SYSTEM` prompt gets a full UI test-file shape spec: jsdom pragma on line 1 (Vitest 4 dropped `environmentMatchGlobs`), import conventions for `renderWithProviders` / `mockFetch` / `realShapedFetch` / `axe`, mandatory axe test per component, derived coverage from `ui_behavior` + `acceptance_scenarios`, UI stub shape with `@slowcook-stub` marker. The user message tells the LLM which mode it's running in.
- `buildProjectContext` now also lists existing `src/components/**/*.tsx` + client `src/app/**/page.tsx` so the LLM doesn't emit `<ui_stub>` blocks for real components.
- PR body + audit-trail comment mention UI tests + stubs separately when present, and tag `"ui-only"` mode explicitly.
- `+4 unit tests` for the new parser behavior (full-mode bundle parse; ui-only mode requires `<ui_test_file>`; handler-required + UI-required in full mode; empty UI stubs ignored). 118 cli tests total.

**Phase C — brew is UI-aware.**

- `BREW_SYSTEM` prompt gains a "UI component tests" section: how `.test.tsx` targets differ (edit `src/components/` or client pages at `src/app/**/*.tsx`), the `@slowcook-stub` replace-me pattern, that helpers under `tests/helpers/` are fixed infra, how `vi.stubGlobal("fetch", …)` works in tier-1 UI, axe invariants, `"use client"` directive requirement, props inferred from test usage.
- `allowedPaths` remains empty (permissive default) — UI paths under `src/` were already writable; the prompt just makes the expectation explicit to the agent.

**Post-init text fix.**

Older 0.7.5/0.7.6 `slowcook init` told consumers to add `environmentMatchGlobs: [["**/*.test.tsx", "jsdom"]]` to their `vitest.config.ts`. That option was removed in Vitest 4. The output now instructs: add `.tsx` to `test.include` + add a per-file `// @vitest-environment jsdom` pragma. Testgen prompts testgen-emitted UI test files to include the pragma.

**Version jumps:**

- `@slowcook-ai/cli 0.7.6 → 0.7.7`
- `@slowcook-ai/core`, `@slowcook-ai/stack-ts`, `@slowcook-ai/forge-github` — unchanged.

**Adoption:** bump pin to 0.7.7. On the next refine → testgen → brew cycle with a spec that has `ui_behavior`, the pipeline produces handler tests + UI tests + handler stub + component stub; brew then ratchets both into real code.

**Brownfield specifically:** story-006 on rewo currently has handler tests + handler impl but no UI. With 0.7.7, re-running testgen on story-006 detects the missing UI test, emits `"ui-only"` mode (handler tests untouched), emits a component stub + UI test file; brew fills in the component.

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
