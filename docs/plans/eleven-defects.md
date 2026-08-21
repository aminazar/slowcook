# The eleven defects — fix plan (approved by Amin, 2026-08-21)

Source: the defect list surfaced by the rewo agent-worker run (ledger
G1–G20 is the *fixed* record; these are what remained). Amin approved
fixing **all eleven** on slowcook, with effectiveness validated by
dogfooding the rewo run.

## Method (applies to every item)

1. Implement on a branch off fresh `origin/main` (never local `main`).
2. Unit tests for the pure logic; full suite green before PR.
3. Ship: PR → CI → rebase-merge → **verify merge by querying PR state**
   (never trust a piped exit code — the tail-masking trap).
4. Deploy to the box only from a freshly-fetched main checkout; assert
   the built dist contains the change (grep a distinctive string).
5. Validate on rewo: each item names its dogfood check below. An item is
   DONE only when its dogfood check has actually run.

## Phase 1 — deterministic guards (prevent silent corruption)

### D1. Spec validity gate before any push
- **Defect**: refine can push a truncated/unparseable spec (G14 showed a
  mid-line truncation); nothing validates the artifact before commit.
- **Fix**: every refine path that writes `specs/*.yaml` must YAML-parse
  and schema-validate the result before committing; failure = revert +
  error as PR/issue feedback (mirror the discovery gate), never a push.
- **Dogfood**: rerun a spec amendment on rewo; confirm the gate output
  appears in the trace and a deliberately-truncated spec (unit test) is
  refused.

### D2. Worker asserts its checkout ref (ledger O1)
- **Defect**: workload was once derived while the checkout sat on a
  side branch; nothing asserts "I stand where this plan claims".
- **Fix**: `ensureBaseCheckout` records the expected ref; every pass
  asserts `HEAD == origin/<base>` after sync and hard-stops (named
  precondition) otherwise.
- **Dogfood**: restart the timer; traces show the assertion line each
  pass. Manually wedge the box checkout onto a branch → next pass must
  refuse with the named precondition, not derive.

### D3. Multi-line-safe commit messages
- **Defect**: `LocalGitOps.commit` shell-escapes into `-m "…"` and
  admits single-line-only support; odd characters can break a commit.
- **Fix**: write the message to a temp file, `git commit -F <file>`.
- **Dogfood**: next agent commit on rewo with a multi-line message (the
  testgen removal-note path) lands intact.

### D4. Testgen reads the spec's scope (no phantom UI expectation)
- **Defect**: backend-only story-019 warned "missing ui_test_file —
  degrading" when handler-only output was CORRECT.
- **Fix**: testgen inspects the spec (routes/surfaces) — stories with no
  UI surface expect no UI test block; the warning fires only when a UI
  surface exists and the block is missing.
- **Dogfood**: regenerate/amend a backend-only story: no degrade warning
  in output; a UI story (020/021 have surfaces) still warns when the
  block is absent.

## Phase 2 — operability (see what the worker sees)

### D5. `slowcook workload` + `slowcook doctor`
- **Defect**: every stall required hand-reconstructing the worker's view
  over SSH.
- **Fix**: `workload` prints derived jobs + skipped jobs with the exact
  unmet precondition + what the next pass will do. `doctor` verifies and
  NAMES every precondition (tokens/App creds by live call, pricing table
  covers configured models, checkout state, required binaries) —
  fail-closed, one line each.
- **Dogfood**: run both on the box mid-run; a deliberately broken env
  var must produce a one-line named failure, not a stack trace.

### D6. Halt roll-up — one pinned "needs the PM" surface
- **Defect**: waiting-for-PM halts scatter across issue threads; Amin
  finds them by luck.
- **Fix**: the worker maintains ONE issue ("slowcook: waiting on the
  PM") — checklist of open halts, each added/checked off as state
  changes, @-mention on NEW items only (one phone buzz per item).
- **Dogfood**: next PM-gated halt on rewo appears in the roll-up issue
  within one pass; resolving it checks the box off.

### D7. `slowcook worker deploy`
- **Defect**: shipping slowcook to the box is artisanal rsync + rebuild
  + hand grep (G1's stale-dist lie mechanized only as habit).
- **Fix**: `worker deploy --host <ssh> --dir <path>`: rsync (with the
  G1 exclusions), remote `tsc -b --force`, then a built-in freshness
  assertion (embedded build stamp compared end-to-end), fail closed.
- **Dogfood**: all subsequent phase deploys use it; break it once
  deliberately (stale tsbuildinfo) to see it refuse.

## Phase 3 — review intelligence

### D8. Taste pre-reviews brew (code) PRs
- **Defect**: implementation PRs get no agent review; taste refuses
  non-spec/tests branches; Amin arrives cold.
- **Fix**: new kind `brew` (branch `slowcook/brew/story-<id>`): lineage
  = spec + tests + manifest + diff; verdict posted as advisory review.
  NEVER merges — brew is a declared human gate; approve cc's the PM as
  "ready for your merge".
- **Dogfood**: when brew opens PRs for 019/020/021, each carries a taste
  verdict before Amin looks.

### D9. Stale-premise triage
- **Defect**: reviews/comments on superseded artifacts get acted on
  literally (or flagged as unverifiable); nothing checks the premise.
- **Fix**: before resubmit acts on feedback, compare feedback timestamp
  against the artifact's supersession events (merged amendments, newer
  spec hash). Stale-premised feedback gets a reply stating what changed
  since and is excluded from the amendment prompt.
- **Dogfood**: post a comment on the merged #221 referencing the old
  spec → agent replies with the supersession note instead of amending.

## Phase 4 — drift

### D10. Spec-content drift detection
- **Defect**: artifacts derived from a spec don't record WHICH spec;
  out-of-band edits leave stale tests/impl looking done.
- **Fix**: manifests + brew records store the source spec's content
  hash; workload derivation compares and emits "tests-stale" /
  "impl-stale" jobs (regenerate via the existing fossil-safe paths).
- **Dogfood**: after #226 merges, hand-edit a spec comment line on a
  branch → workload shows the stale derivation; revert → clean.

## Phase 5 — polish

### D11. `app init` logo hint
- **Fix**: final output line: where to upload the app logo (GitHub App
  settings → Display information) + path to the slowcook logo asset.
- **Dogfood**: output inspection.

## Standing constraints

- Rewo pipeline state: tests PR #226 healed, **blocked on Amin's a/b**
  (real-DB pgTAP tests for `merge_rewos` vs mock-only + human QA).
  Phase work must not bypass that gate. Timer stays off until #226
  merges; D2's dogfood restarts it.
- Never touch local `main` (Amin's unpushed commits bed3d20/ba0dd48).
- Any new defect discovered while executing this plan gets a ledger
  entry (G21+) and, if in scope, folds into the phase list.
