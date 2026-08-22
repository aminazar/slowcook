# Ratchet protection, reconciled — adoption plan for PR #415

Amin's rulings (2026-08-22): (1) strict "changed by hand" must not block
legacy repos — add lazy backfill for provenance gaps and fix the agents
that don't write AuthoredEntry records; (2) unify the labelling; (3) split
environment state from gate evidence — gitignore the former, version the
latter.

## Principles locked

- **No override, ever, for provenanced artifacts** (#415's core stance
  survives intact).
- **Backfill records truth, not fake agency**: only artifacts with NO
  ledger history qualify, exactly once, as `agent: "human-legacy"` +
  HEAD hash + the sanctioning human merge. First touch ratchets the
  artifact into strict enforcement — one-way, like everything else.
- **Derived triggers are first-class authorization**: the worker's
  "derived state, not label state" model and #415's issue-label
  provenance are reconciled by recording the trigger in the entry, not
  by picking a winner.
- **Versioned = what a gate consumes as evidence** (ownership config,
  provenance ledger, manifests, gates.yaml). **Ignored = what only the
  box needs** (traces, logs, workload.json, run dirs).

## Steps

### R0 — reconcile the branch (needs Amin once)
#415 is stale vs main and Amin holds a patch-distinct local iteration
(bed3d20, ba0dd48). Amin either pushes those onto the #415 branch or says
"supersede" — then the branch is rebased onto main with plan-doc hunks
dropped (they diverged; plans travel in their own commits now).

### R1 — the pure module, updated
- Labels: `slowcook:recipe`/`slowcook:refine` → `agent:recipe`/`agent:refine`.
- `AuthoredEntry.trigger`: `{kind:"issue-label",issue,labels}` |
  `{kind:"derived",reason,evidence,trace?}`. Rules gain
  `allowed_triggers` (default: owner's label + owner's derived reasons —
  resubmit, regeneration, drift).
- New verdict class `legacy-unprovenanced` (distinct from violation):
  owned path changed, ledger has NO entry for the path ever. Emitted
  with the exact backfill command.
- Malformed `ownership.json` fails CLOSED (loud exit), never silent
  fallback to defaults.

### R2 — producers: agents write the ledger
Every path that authors owned files appends an AuthoredEntry (files,
sha256 as authored, trigger, story consent where required):
- refine: spec emission, amendment/resubmit, split executor.
- recipe/testgen: generation, resubmit (both record post-discovery).
- Worker-spawned runs pass the derived trigger + trace path down via env
  so entries cite the same evidence as the trace tree.
- Entries are committed IN THE SAME COMMIT as the artifact (they are the
  provenance of that commit).

### R3 — `slowcook provenance backfill`
- `--path <p>` (or `--all-legacy`): verifies the path has no ledger
  history, records `human-legacy` entry at HEAD hash with the invoking
  human + reason. Refuses provenanced paths loudly.
- CI verdict for `legacy-unprovenanced` = WARN + instruction, not FAIL,
  for a grace window declared in ownership.json
  (`adoption: "warn-until: <date>"` or `"strict"`); rewo starts at warn,
  flips to strict once the three live stories' artifacts are backfilled.

### R4 — environment/evidence split
- `.gitignore` templates (init + docs): `.brewing/runs/`, worker logs,
  `workload.json`, `history-index.json` (already), traces.
- Documented contract in docs/worker.md: what must be committed and why
  (gates can only judge what the checkout carries).

### R5 — arm on rewo, dogfood
- Ship workflow via templates; arm in warn mode; backfill the touched
  legacy artifacts; run one refine + one recipe cycle and verify their
  entries pass; flip to strict; ledger the failures (G-numbers) as
  always.

## Out of scope
- pm-assistant / dash story ownership (config example only).
- Retroactive provenance for merged history (grandfathered via backfill).
