# Slowcook cleanup items + roadmap (post-0.17.0-α.4 dogfood)

Compiled 2026-05-04 after the rewo issue #149 dogfood validation of the 0.17 brownfield pipeline. Every item below was discovered or surfaced during that run.

---

## 🔴 BLOCKING — fix in 0.17.x

These items either prevent the pipeline from being usable end-to-end OR cause silent corruption.

### 1. brew-auto branch-name mismatch — tests PRs use `batch-N` not `story-N`

**Where:** `packages/forge-github/src/templates.ts` line ~88-92 (slowcook-brew-auto.yml template)

**Symptom:** When mockup PR for story-018 merged, brew-auto looked for the OTHER half on branch `slowcook/tests/story-018` — but testgen now batches output to `slowcook/tests/batch-1777829319754`. Match failed → "waiting for the other half" notice → brew never auto-dispatched.

**Memory:** referenced in `project_milestone_2026_04_25_session_2` ("brew-auto branch-name lookup failed; switched to title+label search"). The fix landed in forge-github 0.11.5 BUT the rewo workflow was generated from an older template. Need to either:
- Re-emit the workflow on rewo (`slowcook init` re-run touches `.github/workflows/`)
- OR audit forge-github 0.11.5 for whether the fix ACTUALLY went in (the template I read still uses `--head "slowcook/tests/story-$id"`)

**Fix:** template's "find OTHER half" query → `gh pr list --label slowcook-tests --state merged --jq "[.[] | select(.title | contains(\"story-$id\"))] | length"`. Title+label is unambiguous regardless of branch naming.

### 2. Mockup PR runs full test suite + gates merge on it

**Where:** `slowcook-checks` workflow (consumer-maintained) runs `npm test` on every PR. Story-N tests are red until brew completes — but the mockup PR doesn't write the implementation, so it shouldn't gate on tests-green.

**Symptom:** PR #152 (story-018 mockup) had `slowcook checks` red because story-018 tests are red. Required `--admin` force-merge.

**Memory:** `project_skip_tests_for_testgen_prs` shipped 0.7.10 to skip `slowcook checks → Run tests` on testgen PRs. Same exemption needed for mockup PRs (label `slowcook-mockup`).

**Fix:** template + rewo workflow: `if !contains(labels, 'slowcook-tests') && !contains(labels, 'slowcook-mockup')` for the test-running step.

### 3. mock-isolation check scans whole `mock/` (not just PR diff)

**Where:** `slowcook check mock-isolation` walks all of `mock/src/`. When PR #152 (story-018 mockup) ran the check, it failed on PRE-EXISTING leftover files from story-017's old vibe (`MemberReactionsWithPins.tsx`, `PinnedStrip.tsx` cross-importing `@/lib/emotions`).

**Symptom:** vibe-018 emitted clean files but the check failed on unrelated debris. Required `mock/src/lib/emotions.ts` band-aid push.

**Fix:** scope `check mock-isolation` to the PR's added/modified files only when run from a PR context. OR have it report ALL violations but only FAIL on those introduced by the current PR (compute base..head diff first).

### 4. forge-github@0.11.6 still pending publish

OTP needed. Memory `feedback_pnpm_publish_for_workspace_deps` reminds: use `pnpm publish --no-git-checks`.

---

## 🟠 HIGH — fix in 0.17.x or early 0.18

### 5. Refine emit writes `src/lib/data/*.mock.ts` scaffolds

**Where:** Refine is generating scaffold files in `src/lib/data/` (e.g., `reactions_remaining.ts` + `reactions_remaining.mock.ts`) as part of the spec PR.

**Why bad:** That's brew's territory (write data layer when wiring is needed). Refine should emit ONLY the spec yaml + index update. The scaffold is a holdover from a pre-0.16 era when refine pre-allocated stubs.

**Fix:** remove the scaffold-emit code path from refine; brew's existence-check will create the file when needed.

### 6. Recon not yet wired into brew-auto

**Where:** Slowcook 0.17.6 shipped `slowcook recon` as a standalone command. brew-auto template doesn't yet call it as a pre-step.

**Fix:** in `slowcook-brew-auto.yml` template, between "both halves merged" check and "dispatch brew", run `slowcook recon --story $id`. If recon exits 2 (escalate), don't dispatch brew; post the recon-result.json contents as a PR comment.

### 7. Vibe extracted `MemberProfileHeader` as a new component instead of editing inline

**Observed:** Vibe-018 emitted `mock/src/components/members/MemberProfileHeader.tsx` AND `ReactionRationBadge.tsx`. Testgen wrote tests against `MemberReactionsPage` (existing). Tests will pass IF MemberReactionsPage renders MemberProfileHeader — but if vibe didn't UPDATE MemberReactionsPage to mount MemberProfileHeader, the badge never renders.

**Fix:** vibe prompt should require: when adding a child component, also update the PARENT to mount it. Recon should detect this (no integration test passes if the import isn't there).

### 8. brew-auto's "no mockup → assume backend-only → mode=legacy" branch removed but consumers still on old workflow

**Where:** rewo's local `slowcook-brew-auto.yml` was patched on main (commit 1469751). Future consumers will get the fixed template once they re-init. Existing consumers (rewo + future early adopters) need to manually re-pull the workflow file.

**Fix:** add a `slowcook check workflows` command that diffs consumer's `.github/workflows/slowcook-*.yml` against the current template and surfaces drift.

### 9. perfect-mock migration PR (`chore/perfect-mock-migration`) still open

The hand-built mock-perfect/ → mock/ migration is on a branch but not merged. Once merged, the legacy story-017 vibe-emit files (cross-import bug) disappear from main.

**Fix:** review + merge `chore/perfect-mock-migration` PR.

---

## 🟡 MEDIUM — 0.18.x scope

### 10. `slowcook init from-prod` automation gaps

α.4 ships the strategy classifier + skeleton emitter. Still hand-finished after the scaffold:

- Per-table fixture handlers from `supabase/migrations/`
- Per-endpoint api-client function bodies extracted from src/'s `fetch()` call sites
- Fluent supabase mock generated from prod-side `supabase.from(...).method().method()` chain extraction
- mock/package.json + next.config + tsconfig auto-emission with prod's dep major versions

### 11. History-index could be richer

Today emits: components + props + tests_covering, api_routes + methods, migrations + tables/columns, test_helpers + purpose, test_files + imports + test_names.

**Could also emit:**
- RLS policies per table (refine often needs this)
- Routes mapping (which route file mounts which top-level page component)
- Cross-component imports (which components import which others — answers "what would extending X cascade to?")
- Test-helper-import frequency (which mocking idiom is most common)

### 12. Refactor command (task #64)

Cost/benefit-per-proposal + codebase scope (not just diff). Still pending. ~1 day work.

### 13. parsePlaywrightList full implementation

α.4 made it return `[]` (degrade-don't-halt). Still doesn't actually discover Playwright tests. Needed if any consumer wants Playwright-driven acceptance tests in the manifest.

---

## 🟢 LOW — 0.19+ or "as needed"

### 14. Drift detection (`slowcook check-mock-drift`)

Read-only CI check that compares structural hashes of prod files vs mock files (excluding the strategy-B/C swap lines). Fails CI if drift exceeds threshold.

### 15. `slowcook-no-mock-required` label opt-out

Per `feedback_brew_requires_mock`: cron / admin endpoints with truly no UI can bypass the mockup gate via explicit label. Today brew-auto doesn't check for this label; consumers can't opt out.

### 16. `slowcook check workflows` (drift detection for consumer-maintained workflows)

Called out in item #8 above.

---

## 🔥 NEW HIGH PRIORITY — recon emits structural shape tests; drop file-level edit lock

**Updated** per `feedback_shape_tests_belong_to_recon_not_testgen` (supersedes the testgen-shape-emit plan from earlier).

Cleanest architecture: testgen STAYS blind to mock (preserves the 0.16 design intent); recon takes on shape-test emission. Three agent-level layers:

| Agent | Sees | Writes | Why |
|---|---|---|---|
| Testgen | Spec + history-index + existing tests | Behavioral contract (text, click → fetch, prop shapes, color rules) | Spec-driven; can't accidentally lock in mock implementation |
| Recon | Spec + mock + testgen output | (1) renaming map; (2) NEW: `tests/integration/story-N-shape.test.tsx` | Has full view; emits shape-only assertions |
| Brew | All test files + mock + history-index | Implementation | Full edit freedom; file-level lock can come down |

### Implementation

1. **Revert testgen prompt's shape-emit additions** ✅ done in llm-anthropic@0.13.4
2. **Extend recon command** (`packages/cli/src/commands/recon/index.ts`):
   - Read `mock/src/` files for the story's surface area (story-NNN scenarios + their imports)
   - Emit `tests/integration/story-N-shape.test.tsx` with structural assertions:
     - Layout containment (`closest('header')`)
     - CSS token presence (`var(--mint)` etc.; no inline hex)
     - Visual className tokens (`rounded-full`, `min-h-[44px]`)
     - DOM-order constraints
     - Cardinality
     - Element-kind preservation
   - Recon prompt has explicit "shape only, never wiring" rule + the do-not-assert list (`feedback_testgen_must_not_over_assert_mock`)
3. **Drop the file-level edit lock** in brew (`packages/cli/src/commands/brew/agent.ts`) once recon's shape tests reliably catch corruption on dogfood:
   - Remove the `plate-handwritten-ui` REJECT
   - Brew can edit ANY file
   - Structural shape tests + full-suite gate are the safety net

### Effort

- Recon shape-emit: 2-3 hours
- Recon prompt: 30 min
- Validate on fresh dogfood: 1 brew run (~$2 + ~10 min)
- Drop the lock: 5 min code change + tests update

Total: ~half-day. Eliminates Gap A (parent-mounting), Gap B (port-elevation), and Gap C (Server Component edit) all at once.

## 🔥 HIGH PRIORITY (separate roadmap slot — already memory'd)

### 17. supersedes is too coarse → side-effects audit replaces block-on-contradiction

See `project_supersedes_too_coarse_HIGH_PRIORITY.md` (the original gap) + `feedback_side_effects_audit_replaces_blocking.md` (the proper resolution).

Today: refine detects contradiction → posts "blocked; add change-of-mind label" → PM authorizes wholesale supersede (loses other invariants' protection) OR drops the issue.

Proposed: refine runs a 2nd LLM pass to enumerate the EXACT assertions that contradict; emits a side-effects table for PM review; on approval, spec gets `supersedes_assertions: [{story, file, line, before, after}]`; testgen MODIFIES only those assertions in the existing test files.

**Three implementation pieces (~1-1.5 days):**

1. Refine 2nd LLM pass after contradiction verdict — emits structured side-effects list + posts as PR-comment table. ~half-day. ~$0.30 extra refine cost per contradictory issue.
2. Spec yaml gets `supersedes_assertions` field (alongside or replacing the coarse `supersedes`). ~2 hrs.
3. Testgen MODIFY existing test files via ts-morph (find assertion → swap before-text/after-text). ~half-day.

**Inputs already available**: history-index reverse-coverage map (`components.tests_covering`); spec yamls of conflicting stories; test file contents.

**Push to 0.18.0**, ahead of mocking-agent automation. This is the highest-leverage architectural fix remaining for the brownfield pipeline.

---

## Sequencing recommendation

| Release | Items | Effort |
|---|---|---|
| 0.17.0-α.5 | #1 (branch-name fix audit), #2 (mockup-PR test gate exemption), #3 (mock-isolation diff scope) | half-day each |
| 0.17.0-α.6 | #5 (drop refine scaffolds), #6 (recon in brew-auto) | half-day each |
| 0.17.0 STABLE | #4 (publish forge-github 0.11.6), #8 (`slowcook check workflows`) | half-day |
| 0.18.0 | #17 (invariant supersedes) — HIGH | 3-5 days |
| 0.18.x | #10, #11, #12, #13 — mocking-agent automation + refactor + history-index richness | 1-2 weeks |
| 0.19.0 | #14, #15, #16 | 2-3 days |

---

## Status of in-flight dogfood

- Issue #149 (reactions-left badge): ✅ refine + testgen + vibe all worked correctly with new pipeline; brew dispatched manually (auto-gate hit item #1); awaiting brew completion
- Issue #148 (pinned-strip retry): correctly blocked by refine as `contradiction` — proof of concept for history-aware refine
- Benchmark: `benchmark/pinned-strip-original` tag preserves the pre-0.17 failed state
