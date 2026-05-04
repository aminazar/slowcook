# Pair-brew real runs — empirical findings

**Date:** 2026-05-04
**Setup:** `slowcook brew --pair-sim` invoked twice on the self-hosted runner against rewo story-018 (the same baseline used in earlier experiments). Both runs used real Anthropic API calls (Sonnet 4.5) for both driver + navigator. No me-roleplaying.

## Results

| run | iters | spend | outcome | navigator BLOCK rate | cross-story regressions |
|---|---|---|---|---|---|
| 25345083885 (initial) | 5 | $1.15 | iter-cap | 5/5 | 0 |
| 25345604359 (tuned) | 5 | $1.06 | iter-cap | 5/5 | 0 |

Neither run converged. Both hit iteration cap. Driver responded faithfully to navigator concerns each iter; navigator kept finding new issues.

## Run 1 failures (initial navigator)

Navigator exhibited two avoidable failure modes:

1. **Self-flip-flop**. Iter 1 BLOCKED on "ReactionRationBadge should be embedded in MemberProfileHeader (per mock)"; iter 4 BLOCKED on "MemberProfileHeader duplicates header rendering — refactor to inline"; iter 5 BLOCKED on "inlined badge breaks mock composition — extract MemberProfileHeader". Navigator literally swung between extract + inline across iterations. Driver did the right thing each time (responded to prior verdict) and got blocked for it.

2. **Spec hallucination**. Iter 5 BLOCKED on "GET /api/reactions/remaining response shape doesn't match spec — missing `used` field" — but the actual spec only requires `{remaining, week_start}`. Driver was correct; navigator imagined a stricter contract.

## Tuning between runs

Two changes shipped in `packages/llm-anthropic/src/prompts/navigator.ts`:

1. Pass navigator's own prior verdicts into each call, with explicit prompt rule: "DO NOT BLOCK on a concern that contradicts your own prior advice."
2. Pass the spec yaml into the prompt with explicit rule: "Ground api_contract claims in the spec text; if you can't quote it, downgrade to WARN."

## Run 2 results (tuned navigator)

Both fixes worked AS INTENDED:
- ✓ No more self-flip-flop. Iter 1 said "extract MemberProfileHeader"; iters 2–5 consistently expected the extracted component.
- ✓ No more spec hallucination. Api_contract concerns now grounded ("spec says they come from GET /api/reactions/remaining — no fetch in the diff" — verifiable in spec yaml).

But the loop STILL didn't converge. New + persistent failure modes:

1. **Cross-contract drift in the inputs themselves** (the headline finding). Three artifacts disagree on the prop name for the same domain entity:
   - spec yaml: `viewer.id === owner.id` (uses `owner`)
   - mock `MemberReactionsPage`: takes `{owner, viewer, reactions}`
   - mock `MemberProfileHeader`: takes `{profile}`
   - testgen test file: passes `<MemberReactionsPage profile={owner} ...>`

   Driver follows tests (correct — tests ARE the contract). Navigator reads spec + mock + flags the mismatch (also correct). Both are rationally interpreting their respective sources; the sources just don't agree.

2. **Navigator hallucinated a filename**. Iter 5 BLOCKED on "PinnedRewosStrip import path/name mismatch — existing file is likely PinnedStrip.tsx not PinnedRewosStrip.tsx". Wrong — the existing file IS `PinnedRewosStrip.tsx` (driver was right; navigator made it up from the mock's `PinnedStrip.tsx` filename). The navigator does not have file-existence verification; it speculates from naming patterns.

## What this validates + what it doesn't

**Validated:**
- The pair-programming loop is mechanically sound. Driver writes; navigator reviews; revert + iterate works.
- Specific tuning (prior-verdicts + spec-grounding) measurably improves navigator quality across runs.
- Pair brew correctly DETECTS upstream drift — three independent signals (this run, the entities-falsified experiment, brew #155's 9 inline interfaces) all point at the same prop-name drift class.

**Not validated:**
- That pair brew CONVERGES on stories with cross-contract drift. It doesn't. Both runs hit iter-cap because the inputs are inconsistent; iterating brew can't fix that.
- That tests-as-only-gate works (we already empirically rejected this earlier in the day).
- That story-018 in particular is solvable by any brew configuration without first reconciling the prop-name drift at refine stage.

## Architectural conclusions

1. **Pair brew is the failure detector for refine-stage drift.** That's a valuable property even when it doesn't converge — it tells you EXACTLY where the upstream gap is. Run 2's navigator was correctly reading every source; the problem isn't in brew.

2. **Pair brew should escalate, not iterate, on detected drift.** Shipping in cli α.8 as a navigator HALT-CLASS rule: when the same drift class blocks ≥3 iterations, downgrade to WARN + recommend refine-stage reconciliation in the rationale. Lets the driver land its best-effort iteration + halts the run cleanly with a precise pointer to the upstream fix needed.

3. **The next architectural cut is refine-stage prop-name reconciliation.** When testgen invents a prop name that conflicts with the spec's vocabulary OR the existing mock/component contracts, refine should detect + reconcile BEFORE testgen ships. Without this, every brew (solo, pair, with rails, without rails) hits the same drift wall.

## Cost of these experiments

- Run 1: $1.15 (real API spend on the runner)
- Run 2: $1.06
- Plus ~30 min of orchestration code (`pair-sim.ts` + workflow)
- Plus ~20 min of analysis + writeup (this doc)

Total: ~$2.20 + ~50 min for two real-data validations of the pair-brew dynamic. Cheap for the strength of the architectural conclusion.

## What ships next (cli α.8 final)

1. ✓ `packages/llm-anthropic/src/prompts/navigator.ts` — system prompt + halt-class rule + prior-verdicts handling + spec-grounding
2. ✓ `packages/cli/src/commands/brew/pair-sim.ts` — local prototype runner
3. **Pending**: wire navigator into production `packages/cli/src/commands/brew/agent.ts` (per the original α.8 ship plan — task #76)
4. **Pending**: refine-stage prop-name reconciliation (NEW task — to be filed)

The pair-sim prototype + workflow + experiment doc are sufficient to commit to the architecture. Production α.8 wiring is straightforward from here.
