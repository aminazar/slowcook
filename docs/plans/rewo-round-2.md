# Rewo round 2 — parallel stories, human-in-the-gates, model-tier observation

Operator acts AS THE HUMAN (Amin's instruction, 2026-08-23): reads every
spec, test file and implementation personally; closes gates with own
judgment via gh; the only gates deferred to Amin are the MOCK review
(vibe) and final QA — and only after `eye` confirms the review overlay
is present and the page renders, with the LCR responder armed on the box
first. Every loop iteration reports slowcook findings in plain language.
The worker timer stays OFF: parallel lanes are driven manually because
the worker runs one job per pass (itself a finding — no parallel lanes).

## Model-tier experiment

Spec/review work stays on Opus (reasoning tier). Implementations are
deliberately split across tiers to observe the harness compensating for
model strength:
- story from issue #124 (feed hyperlinks users) → brew with HAIKU 4.5
- story from issue #78 (cannot view own page)  → brew with SONNET 5
- story from issue #148 (pinned rewos strip)   → brew with SONNET 5,
  after the vibe/mock/LCR path (the UI story that exercises the mock
  gate end to end).
Comparisons recorded: iterations, spend, revert count, taste findings
per tier.

## Phases

0. **Close last round as the human.** Read story-019/020/021 specs,
   tests and brewed code in full. Merge #233 (verified) and #228 (after
   judging the migration divergences personally). For #229: post a real
   human review demanding the author_id collision + missing RLS fixes;
   drive the repair (the pipeline has no implementation-resubmit path —
   observe and note how that gap plays out).
1. **Open the three lanes.** Label #124, #78, #148 for refine on three
   branches; answer clarifying questions as PM. #148 carries an old
   "blocked-contradiction" label — resolve it as PM first. Watch for
   the known parallel hazard: every spec PR edits specs/_index.yaml.
2. **Specs.** Taste merges (agent gate); I read each merged spec anyway
   and file corrections before tests start if needed.
3. **Tests.** Parallel recipe + taste rounds. SQL suites where the spec
   touches the database.
4. **Mock lane (#148 only).** `slowcook vibe` mockup → host it → `eye`
   check (overlay present, page renders) → arm the LCR responder on the
   box → hand the URL to Amin for the mock gate. Nothing merges past
   this gate without him.
5. **Brews in parallel** on separate branches with the per-tier models;
   taste advisory on each; I read the diffs personally; merge
   sequentially, full-suite diff between merges (merge order: smallest
   blast radius first).
6. **Retro.** Consolidated findings → slowcook fix list (next plan).

## Safety rails
- Sequential merges with a full-suite regression diff between each.
- Any two lanes touching the same file = stop, reorder, note.
- Budget: $10/brew cap as before; running total reported each loop.
