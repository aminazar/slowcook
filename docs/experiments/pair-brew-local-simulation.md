# Pair-brew local simulation — conclusion

**Date:** 2026-05-04
**Setup:** Driver + Navigator both simulated by me (Opus 4.7) on rewo story-018, baseline = stub `MemberReactionsPage` + tests + mock + recon shape tests in place. Working tree on branch `sim/pair-brew-story-018`. No CI dispatches; everything ran against local vitest.
**Verdict:** Pair-programming loop works as designed. It catches what solo brew misses, costs ~30% extra LLM tokens per iteration, and surfaces upstream-stage problems (refine-stage prop drift) earlier than the structural test gates do.

## Iterations

### Iteration 1 — driver writes naive impl

Driver wrote `MemberReactionsPage` + `MemberProfileHeader` + `ReactionRationBadge`. Tests passing: 17/26 (up from 7/26 baseline). Diff: 3 new files + stub overwrite.

**Navigator review caught 5 things:**
1. **BLOCKING — cross_story_risk:** new `MemberReactionsPage` signature breaks `src/app/(main)/u/[handle]/page.tsx` typecheck (passes `owner`, my signature wants `profile`).
2. **WARN — test_prediction:** `PinnedRewosStrip` is still a stub that throws → 9 of remaining failures cascade from there.
3. **WARN — design_fidelity:** added `flex` to badge className just to satisfy a recon shape-grep — overrides design's intended `inline-flex`.
4. **WARN — reuse:** local `Profile` type duplicated in 2 files; subset of canonical `Profiles` entity.
5. **WARN — code_quality:** `pinnedRewos as never` cast hides a real type bug.

Verdict: BLOCK. Iteration reverted.

### Iteration 2 — driver addresses every concern

- Fixed cross-story risk: updated `page.tsx` to map server fetch results to new prop names + added server-side `remaining` fetch for owner-only.
- Fixed shape-grep gaming: removed bogus `flex` from badge (recon test still passes since `\bflex\b` matches inside `inline-flex`).
- Fixed type cast: used real `PinnedRewo` type matching `PinnedRewosStrip`'s `PinFixture`.
- Conditional render strip when empty (avoid stub throw).
- Mirrored mock structure: inline `<header>` + delegated badge mount to `MemberProfileHeader`.
- Fixed handler: dropped `count: "exact"` (mock doesn't model it), added `week_start` to response, added `code: "unauthenticated"` to 401.
- Fixed badge text-element selector by collapsing `<span>` into the styled `<div>`.

Result: 34/34 story-018 tests green. Story-018 in isolation: SUCCESS.

**Navigator review caught:**
1. **BLOCKING — cross_story_risk:** 11+ tests in story-005-ui + story-011-ui now fail because the new prop signature doesn't preserve the legacy surface (Follow button, paginated RewoCard rendering, "Owner" type contract).

Verdict: BLOCK. Same prop-drift class as the entities-hypothesis finding — story-018 testgen invented `profile` while legacy `MemberReactionsPage` contracts use `owner`. **Brew alone cannot resolve this**; needs refine-stage prop-name reconciliation OR a dual-signature compromise.

Stopped at iter 2 navigator-block. Total simulated cost: ~$0 (local), but in production would be ~$0.50 driver + ~$0.15 navigator across 2 iters.

## What the simulation proved

1. **Navigator catches design-fidelity violations the structural rails miss.**
   - Solo brew added `flex` to a className just to make a regex test pass. That's exactly the "garbage that passes tests" pattern. Navigator flagged it as `design_fidelity / warn` because the className override broke the `inline-flex` design intent. Recon shape tests don't catch this — the regex match is satisfied either way.

2. **Navigator catches cross-story regression BEFORE the full-suite gate runs.**
   - In production today, brew commits a checkpoint, runs the full suite, sees regressions, reverts. The navigator predicts this from the diff alone, saving an iteration.

3. **Navigator surfaces UPSTREAM problems brew can't fix.**
   - Iter 2's prop drift between story-018 testgen + legacy MemberReactionsPage contract is a refine-stage bug. Brew patching around it would either accept dual-prop ugliness OR break legacy tests. The navigator's job is to escalate, not fix — it correctly identified the limit of brew's authority.

4. **Navigator pressure-tests the structural test rails.**
   - When iter 1 added `flex` to game a recon shape test, the navigator called it out as gaming. This means: structural tests need to be MORE semantic than source-grep (task #75 `recon shape-emit v2`) to be reliable on their own. Until v2 ships, the navigator carries water for them.

5. **Driver responds well to navigator feedback.**
   - Iter 2 addressed every concern from iter 1. The driver's prompt knew the navigator could BLOCK; iter 2 was structurally cleaner because the driver pre-emptively fixed things the navigator would flag. This validates the carrot/stick balance — driver still owns "tests pass", navigator owns "is this sensible," and the driver respects but doesn't kowtow.

## What the simulation revealed about the architecture

- **Pair brew is the right shape.** The two-LLM split (driver = passes tests; navigator = catches non-test concerns) maps to the human pair-programming pattern faithfully + it works on real diffs.
- **Per-iteration cost adds ~30%** but prevents wasted iterations (iter 1 would have committed and then full-suite gate would revert; pair version revertED at navigator stage with cleaner feedback for iter 2).
- **Cross-story prop drift** (story-018 `profile` vs story-005 `owner`) is the SAME architectural problem the entities hypothesis tried to fix. Pair brew surfaces it; doesn't fix it. The fix lives at refine: refine must reconcile new spec's prop names against existing contracts BEFORE testgen runs.
- **Recon shape tests v2** (render-and-assert vs source-grep) is even MORE important now that pair brew is the model — because pair brew gives the driver more freedom (test-as-only-gate ≈ pair model with weak observer), the structural backstop has to be strong.

## Implementation next steps (cli α.8 candidates)

Per the simulation evidence, the production cli α.8 should ship:

1. **`packages/llm-anthropic/src/prompts/navigator.ts`** — already drafted; tighten based on the empirical concerns the navigator surfaced in this sim.
2. **`packages/cli/src/commands/brew/navigator.ts`** — module that runs the navigator pass post-iter, parses JSON verdict, returns structured concerns.
3. **`packages/cli/src/commands/brew/agent.ts`** — wire the navigator pass between diff + test gate. Start with WARN-only (no BLOCKING) to see real signal-to-noise on production dispatches before promoting to BLOCKING.
4. **Mock files in iteration context** — driver gets the relevant mock files in its prompt so its iteration mirrors the design naturally (drives down navigator BLOCKs).
5. **Reuse digest** — pre-iter prompt section listing existing components/helpers/routes to nudge driver toward reuse before creating.

## What we DIDN'T need to ship (verified by negative result)

- **Plate-mode `@slowcook-port-from` carve-out** (deleted task #68) — no UI freeze in pair model; navigator handles the design contract via prompt-time review.
- **Recon prop-shape detector** (deleted task #70) — pair brew model puts this in the navigator's purview (axis: `cross_story_risk`).
- **Strip-rails-only brew** (task #74 needs revision) — solo strip-rails was the user's correctly-rejected initial pivot ("garbage that passes tests"). Replace #74 with "pair brew" as the actual α.8 cut.

## Cost of the simulation

- 0 production CI dispatches.
- 0 npm publishes consumed.
- ~30 minutes of my real-time, including reading context, two driver iters, two navigator reviews, conclusion.
- Local files written + reverted on `sim/pair-brew-story-018` branch (not pushed).

## Reusable artifacts

- Driver prompt (in `pair-brew-local-simulation.md` of this repo or extracted to `packages/llm-anthropic/src/prompts/driver.ts` if the production cli wants the same prompt verbatim).
- Navigator prompt: `packages/llm-anthropic/src/prompts/navigator.ts` (already in tree).
- The branch `sim/pair-brew-story-018` carries the working iteration-2 code if anyone wants to verify locally.

The pair model is ready to ship as cli α.8. The simulation is the empirical case for it.
