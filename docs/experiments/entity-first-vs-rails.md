# Entity-first vs rails — empirical comparison plan

**Hypothesis:** turning domain entities into a typed contract (cli@0.18.0-α.6) reduces brew iteration count, cost, and the size of the structural carve-outs needed to keep agents converging — vs the rails-only approach (cli α.5).

If this lands, the plate-mode `@slowcook-port-from` carve-out (task #68) and the recon prop-shape detector (task #70) become smaller (or unnecessary) — testgen + vibe + brew can't drift on entity shapes because the compiler enforces them.

If it doesn't, the entity layer at minimum simplifies the prompt landscape; we then proceed with the carve-out as planned.

---

## Baseline (cli α.5, no entities, dogfooded 2026-05-04)

Story: rewo issue #149 (story-018, "show 'X reactions left this week' badge on /u/[handle]").

| run | cli | mode | result | iters | spend | green |
|---|---|---|---|---|---|---|
| 25303459995 | α.1 | legacy | HALT MANIFEST_DRIFT | 0 | $0 | 13/35 |
| 25305746902 | α.3 | plate | HALT ITERATION_CAP | 10 | $2.03 | 17/35 |
| 25314071508 | α.5 | plate | HALT AGENT_STALLED (port-marker gap) | 4 | $1.22 | 17/35 |
| 25314561768 | α.5 | legacy | HALT AGENT_STALLED (mock typecheck distraction) | 4 | $0.71 | 17/35 |
| **25315020684** | **α.5** | **legacy** | **SUCCESS** | **5** | **$1.29** | **35/35** |

**Total wasted spend across failed runs: $3.96** (the costs of discovering the rails gaps).

The successful run (25315020684) was on legacy mode, with three rewo-side fixes already in place (stub component with `@slowcook-port-from` marker, tsconfig `mock` exclude, manifest re-record) AND cli α.5's two structural fixes (recon resolveImport, brew artifact prune).

## Entity-first run (cli α.6, with entities present)

Same story (issue #149), starting from `main` BEFORE the brew PRs land (`main` still has the stub `MemberReactionsPage`). Run with cli@0.18.0-α.6 + entities at `src/lib/entities/`.

Expected variations:
- testgen + vibe + plate prompts now reference entity types
- agent's history-index digest now includes the entities section
- typecheck should fail loudly if any iteration redeclares an entity shape

Predicted convergence delta:
- **iter count**: lower (fewer wasted iters chasing prop-shape mismatches) — predict 3-4 iters vs 5
- **spend**: similar or lower — predict $0.80–$1.20 vs $1.29
- **prop-shape stability**: every prop carrying a domain entity should be typed as the entity import; brew's diff should not contain redeclared `interface MemberProfile { ... }` blocks
- **plate-mode viability**: still untested without the carve-out; predict still hits the `@slowcook-port-from` allow_paths gap. Worth running plate AND legacy to compare both regressions.

## Metrics to capture

For every dispatched run, log:

1. **conclusion** (success / failure halt-reason)
2. **iterations_run**, **checkpoints_committed**, **tests_green**, **tests_total**
3. **tokens_spent_usd**
4. **per-iter outcomes** (checkpoint / rejected-frozen-path / reverted-no-progress / etc.)
5. **diff size** (lines added/removed across all checkpoints)
6. **entity import usage** — grep the final PR diff for `from "@/lib/entities` lines; count occurrences. Expected: ≥1 per UI component touched.
7. **redeclared entity shape** — grep the final PR diff for `interface .* { id: string` or similar inline domain types. Expected: 0.

## Verdict criteria

- **Entity-first wins clearly:** ≥30% reduction in iteration count OR ≥30% reduction in spend on equivalent stories, AND zero entity redeclaration in any PR diff. → ship task #68 carve-out as a smaller / optional follow-up; skip task #70 (prop-shape recon) as redundant with typecheck.
- **Entity-first marginal:** smaller improvement (10-20%); some entity import usage but agents still drift in a different layer. → keep entity layer + still ship #68 + #70.
- **Entity-first no measurable improvement:** agents ignore generated entities, drift continues. → file as a learning, ship #68 + #70 as planned, revisit entity layer when agents support it natively.

## How to run the comparison

1. Publish `@slowcook-ai/llm-anthropic@0.14.1` then `@slowcook-ai/cli@0.18.0-alpha.6`.
2. Bump `rewo/.brewing/slowcook-cli-version` from `0.18.0-alpha.5` to `0.18.0-alpha.6`. Commit + push.
3. Re-record manifest (`slowcook manifest record --story 018`) since the entities now exist + history-index re-walks them.
4. Dispatch brew on issue #149 in legacy mode (`gh workflow run "slowcook brew" -f story_id=018 -f mode=legacy ...`).
5. Capture run id; monitor to terminal status; download halt-report or success-report artifact.
6. Repeat with `mode=plate` for the plate-mode reading (without carve-out, predicted to hit allowed_paths gap; informative either way).
7. Fill in the comparison table above.

## After the comparison

- If verdict is "entity-first wins clearly": memo the result, deprioritize task #68 + #70 carve-outs, file follow-up tasks for greenfield entity flow + entity refactor codemod.
- If verdict is "marginal" or "no improvement": memo the result, proceed with task #68 carve-out as scheduled, revisit entity layer scope.

Either way: **the data, not opinion, drives the next architectural decision.** This is the experiment that tells us whether more rails are needed or whether typed contracts retire whole rail classes.
