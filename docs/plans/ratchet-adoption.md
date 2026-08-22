# Ratchet protection, reconciled — adoption plan for PR #415

Amin's rulings (2026-08-22): (1) strict "changed by hand" must not block
legacy repos — add lazy backfill for provenance gaps and fix the agents
that don't write AuthoredEntry records; (2) unify the labelling; (3) split
environment state from gate evidence — gitignore the former, version the
latter.

## Principles locked

- **No override, ever, for provenanced artifacts** (#415's core stance
  survives intact).
- **Baseline at install, never backfill-on-gap** (Amin's ruling,
  2026-08-22): grandfathering happens ONCE, at the moment this slowcook
  version is adopted — one atomic commit hashing every owned artifact
  at HEAD as `agent: "pre-provenance"` entries, sanctioned by the human
  who ran it. THEN the ratchet arms, unconditionally strict. There is
  no ongoing "find a gap → backfill the gap" mode — that pairing is a
  rubber stamp waiting to happen.
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
- New verdict class `baseline-missing` (distinct from violation): an
  ownership config exists but the ledger carries no baseline header —
  the gate FAILS with the exact `slowcook provenance init` instruction.
  (No warn window: baseline belongs to install time, so its absence is
  a setup error, not a grace state.)
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

### R3 — `slowcook provenance init` (install-time baseline)
- Runs once per repo, at adoption/upgrade: enumerates every owned
  artifact (ownership rules + manifest test files), hashes each at
  HEAD, writes `agent: "pre-provenance"` entries plus a ledger
  `baseline: {commit, at, by}` header, all in ONE commit.
- Refuses to run twice (a baseline exists = the ratchet is armed;
  re-baselining would launder hand edits). Adding a NEW ownership rule
  later extends the baseline only for paths that rule newly covers,
  recorded the same way.
- The gate is strict from the commit after the baseline. No warn mode.

### R4 — environment/evidence split (structural, per Amin's ruling)
- A split in logic is a split in FILES: one ignored root for everything
  environmental — `.brewing/local/` — covered by a single gitignore
  line. Migrate: `history-index.json`, brew `runs/`, any worker-local
  state → `.brewing/local/…` (readers fall back to the old paths for
  one version).
- Evidence stays versioned at stable paths: `.brewing/manifests/`,
  `.brewing/ownership.json`, `.brewing/provenance/authored.json`,
  `.brewing/gates.yaml`, `stack.json`. No file mixes both kinds.
- Documented contract in docs/worker.md: gates can only judge what the
  checkout carries; nothing under `.brewing/local/` may ever be read by
  a gate.

### R5 — arm on rewo, dogfood
- Ship workflow via templates; arm in warn mode; backfill the touched
  legacy artifacts; run one refine + one recipe cycle and verify their
  entries pass; flip to strict; ledger the failures (G-numbers) as
  always.

## Out of scope
- pm-assistant / dash story ownership (config example only).
- Retroactive provenance for merged history (grandfathered via backfill).
