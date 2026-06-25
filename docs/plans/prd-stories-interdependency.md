# PRD ↔ Stories interdependency (+ comment-driven reconcile)

**Status:** building (deterministic engine first). **Owner:** GUCDI.

## Problem

The PRD is the source of truth; stories are derived (`menu`). The derivation link
is **not maintained**: when the PRD changes, stories silently rot. `menu` is
one-shot, so every PRD edit forces *regenerate-all* (churns stable specs, destroys
hand-tweaks) or *hand-patch* (manual, lossy, no learning signal). Observed live on
`slowcook-dev/dash`: 8 PRD decisions changed → 12 of 23 specs stale, nothing flagged
it; the fix was a hand-edit that `garnish` couldn't even attribute.

This is the same disease slowcook already solved one level down (issue→test:
"side-effects audit", "supersedes is too coarse") — never lifted to **PRD↔spec**.

## Feature (from the founder)

Live, Google-Docs-style review of the PRD by the PM: highlight text → comment →
the relevant agent replies in dialogue → the change is applied. Stories get the
same, rendered as a structured table. **Bidirectional:** a comment on a story may
affect the PRD (and vice-versa); the agent says so.

## Critical evaluation — three corrections (load-bearing)

1. **Propose, don't auto-apply.** The agent emits a *suggested* patch (a diff);
   "applied" means **applied on human accept** (Google-Docs *suggesting mode*).
   Auto-writing LLM edits into the source-of-truth violates "humans review
   judgment" + the side-effects-audit contract.
2. **One-hop propagation, human-gated.** A change proposes edits to *directly
   linked* artifacts only. Second-order impact is **flagged as a note**
   ("this also implies PRD §X"), never auto-chained — otherwise PRD→stories→PRD
   ping-pongs and never converges.
3. **One model for prose + structure.** A comment is `(artifact, anchor, body)`;
   an *anchor* is a **text-range** (PRD prose) or a **YAML-path** (story field/row);
   a *patch* is a **text edit** or a **structured edit**. Unify once in OSS so both
   surfaces are lenses.

Plus: **comments + patches are durable repo artifacts**, not dash state ("GitHub is
the store; the dashboard is the lens"), so CI/headless agents act on the same data.

## OSS ↔ Dash split

| Capability | OSS (CLI) | Dash |
|---|---|---|
| PRD+stories model w/ provenance links (`prd_ref` + content-hash) | ✅ | — |
| Bidirectional link graph (anchor ↔ stories) | ✅ | renders |
| Deterministic staleness + impact (`trace check` stale, `trace impact`) | ✅ | badges |
| Comment model `(artifact, anchor, body)` as durable artifact | ✅ | authoring UI |
| Reconcile agent: comment/change → **proposed** patch + one-hop note | ✅ headless | streams it |
| Apply = human accepts a patch | ✅ | accept UX |
| Highlight-to-comment, realtime dialogue, suggesting diff, table view | — | ✅ |
| Multi-user presence / realtime sync | — | ✅ |

## OSS build — two layers

### Layer 1 — deterministic interdependency engine (this slice, no LLM)

The link is already there: every spec carries `prd_ref.anchor`. We add a
**content fingerprint** so change is detectable, and expose the graph both ways.

- **Schema:** `prd_ref.sha?` — fingerprint of the referenced PRD anchor's body at
  stamp time. (`packages/cli/src/commands/refine/spec-yaml.ts`)
- **Pure core** (`trace/check.ts`, dependency-free):
  - `normalizeAnchorBody` + `contentHash` (FNV-1a) → `anchorHash(body)`.
  - `checkFreshness({specs, anchors})` → `{stale, unstamped, fresh}`.
  - `computeImpact({specs, changedAnchors})` → affected stories (forward: PRD→stories).
    Reverse (story→PRD) is the same link read backward: the story's anchor is the
    PRD candidate to review.
- **Commands** (`trace/index.ts`):
  - `trace stamp` — write current anchor hashes into specs.
  - `trace check` — existing lints **+ advisory stale report** (recorded sha ≠
    current). Advisory, not a hard fail (cosmetic PRD reflow shouldn't cry wolf);
    `--strict` to fail.
  - `trace impact [--since <gitref>] [--anchors a,b]` — list stories a PRD change
    hits. With `--since`, diffs the PRD between revisions to find changed anchors.

Granularity note: anchors today are **section-level** (`surfaces`, `personas-*`).
Good enough as the deterministic floor (a candidate set); the LLM narrows within it.
Finer `prd_ref` (decision-level) is a later `menu` enhancement.

### Layer 2 — reconcile agent (next slice, LLM)

`slowcook reconcile [--story <id>]` — for each impacted story, the side-effects
audit lifted to PRD→spec: ingest the changed anchor (+ any review comment) → emit a
**proposed patch** enumerating exactly which invariants / scenarios / actors / API
entries contradict the new PRD, with the edit. Reviewable, one-hop, never
auto-applied. This is the headless half of the dash conversational-review loop
(dash Q13) — same investment.

### Layer 3 — signal capture (small)

`garnish` reads agent provenance from artifact front-matter (`refined_by:`), not
just git history, so hand-fixes to agent-emitted specs always record
`Tweaks-output-of:` → `reflect` can mine recurring corrections.

## Dogfood

On `slowcook-dev/dash`: `trace stamp` → change the PRD → `trace impact --since` +
`trace check` show exactly which stories the change hit. (Layer 2 then proposes the
edits once a key is available.)
