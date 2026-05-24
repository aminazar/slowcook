# Multifurcation recursion — dogfood findings 2026-05-24

Dogfooded `cli@0.19.0-alpha.45` against delgoosh-monorepo issue [#640](https://github.com/delgoosh/monorepo/issues/640) ("everything according to mock") and the 7 sub-issues filed from its multifurcation. Real refine output from the live GHA pipeline; no simulation. Every claim below links to the bot comment that drives it.

## TL;DR

α.44/α.45 multifurcation is **too aggressive on already-bounded inputs**. 6 of the 7 sub-issues filed from a successful multifurcation got re-multifurcated by the next refine round. The dogfood spent ~$0.05 on 6 redundant splits that the PM has to manually reject. The prompt needs an "story-sized" anchor + an explicit "you came from a multifurcation; don't re-split unless something genuinely escaped" guardrail.

A secondary finding: the brownfield-answer Pass B audit display on #647 collapses "facts I established" and "questions I still need" into the same prose block, which is a UI/prompt bug worth fixing before the next release.

## Setup

| Item | Value |
|---|---|
| cli on box | `0.19.0-alpha.45` (synced via `setup-slowcook` from `origin/main` 0b089ee) |
| Models | Opus 4.7 (refine main) · Sonnet 4.5 (multifurcation + relationship) |
| Parent issue | [delgoosh#640](https://github.com/delgoosh/monorepo/issues/640) — "Everything according to mock" |
| Sub-issues (7) | [#641](https://github.com/delgoosh/monorepo/issues/641)–[#647](https://github.com/delgoosh/monorepo/issues/647) |
| Time | 2026-05-24 17:35–18:05 UTC |
| Total refine spend | ~$3.40 (incl. ~$0.05 wasted on the 6 redundant multifurcations) |

## What happened, per issue

| Issue | Multifurcation verdict | Outcome | Cost |
|---|---|---|---|
| #640 (parent) | **many · 8 sub-issues · 1 overlap** | Sub-issues filed; parent closed-by-label | $0.0135 |
| [#641](https://github.com/delgoosh/monorepo/issues/641) Patient appointment list | (skipped — already had `multifurcation-proposed` label from earlier run) | **2 PM questions emitted** | $2.19 |
| [#642](https://github.com/delgoosh/monorepo/issues/642) Patient profile | **many · 5 sub-issues** ← wrong, see below | Blocked at multifurcation | $0.0104 |
| [#643](https://github.com/delgoosh/monorepo/issues/643) Patient messaging | **many · 4 sub-issues** ← wrong | Blocked at multifurcation | $0.0099 |
| [#644](https://github.com/delgoosh/monorepo/issues/644) Therapist login+dashboard | **many · 2 sub-issues · 1 overlap** ← borderline | Blocked at multifurcation | $0.0077 |
| [#645](https://github.com/delgoosh/monorepo/issues/645) Therapist appt calendar | **many · 4 sub-issues** ← wrong | Blocked at multifurcation | $0.0096 |
| [#646](https://github.com/delgoosh/monorepo/issues/646) Therapist patient list | **many · 3 sub-issues** ← borderline | Blocked at multifurcation | $0.0093 |
| [#647](https://github.com/delgoosh/monorepo/issues/647) Therapist messaging | **one** (only one that got through) | **3 PM questions emitted, 1 answered from brownfield** | $1.16 |

## Finding 1 — Multifurcation runs to depth-2

**The clearest signal:** five sub-issues that came from a multifurcation got re-multifurcated by the next refine round. Examples:

### #642 split a 1-screen patient profile into 5 sub-issues

The parent body was: *"The patient profile screen pulls real user information from the backend and applies the new design. Patients can view and edit their name, contact details, and preferences."*

The prompt split this into:
1. Patient profile displays read-only name and contact details
2. Patient can edit their name
3. Patient can edit their contact details
4. Patient profile displays preferences
5. Patient can edit their preferences

Splitting per-field-display × per-field-edit is the wrong granularity. A PM looking at delgoosh would file ONE story for "profile screen with edit". Refine's prompt is reading "multiple fields" as "multiple stories".

### #643 split "patient messaging" into 4 stories along technical axes

Send · receive · history-load · therapist-name-on-the-page. That's per-axis decomposition, not per-feature. A real PM would call this "messaging works" — one story.

### #645 split "therapist calendar shows schedule" into 4 stories including create/edit/delete slots

Slot management wasn't in the parent body at all (the parent said: *"Therapists see their booked sessions, available slots, and can manage their schedule"*). The prompt expanded "manage" into create + edit + delete and made each a sub-story. PM scope-creep risk: refine is proposing work that wasn't asked for.

### Where the split was borderline-fine

- **#644 (therapist login + dashboard)** — the split into login + dashboard is defensible because they're independently shippable screens, and the overlap call on login (already covered by story-002) is correct.
- **#646 (therapist patient list)** — splitting "treatment history" out is reasonable because it's a separate sub-page. "View profile from roster" splitting from "see roster" is overgranular.

### Root cause hypotheses

Looking at the [α.44 prompt](https://github.com/aminazar/slowcook/blob/main/packages/llm-anthropic/src/prompts/refine.ts#L28) (`MULTIFURCATION_SYSTEM`):

> 3. **3-10 sub-issues**. If you'd need more, group them under fewer parents. If you have fewer than 3, this is probably ONE story after all — say "one" instead.

The "if fewer than 3, this is probably ONE" rule creates a floor that pushes the model toward splitting whenever any multi-axis structure exists. The model then satisfies the floor by inventing axes (per-field, per-technical-domain, per-CRUD-verb).

Counter-evidence from the data: of the 6 "many" verdicts, **3 produced exactly 3-4 sub-issues** (#643, #645, #646). They land just above the "fewer than 3 → one" floor. The prompt heuristic is generating its own evidence.

The MANY definition also leans aggressive:

> - A list of disparate user journeys joined by "and" / "also"
> - One PM sentence that, if you tried to test it, would need 30+ acceptance scenarios

"Profile shows backend data AND patients can edit" matches the "joined by 'and'" trigger. But this is a single screen with one user outcome. The heuristic needs guardrails.

## Finding 2 — α.36 Pass B works and is visible in the field

#647 was the only sub-issue that made it to the questions round, and it shows Pass B in action:

> _🔍 Checked brownfield first: **1 of 4** questions already answered in your codebase (see audit trail below). **3** still need your input:_

The brownfield answer correctly identified that `mock/src/components/therapist/sidebar.tsx` has no chat nav entry and `mock/src/app/therapist/chat/page.tsx` doesn't exist, so option (c) "mock already has it" can be ruled out from the codebase alone. Good signal that the indexer is being read correctly.

**But:** the audit display has a structural bug. The question that was "answered from brownfield" is shown verbatim in BOTH the questions block AND the audit-trail block. The reader can't tell what's still-open vs. resolved. The Pass B comment template should strip the "answered" question from the PM-facing block, or at minimum visually distinguish it.

## Finding 3 — α.45 overlap tagging fired correctly once

Of the 6 multifurcations, only **#644 produced an overlap tag** — `_(already covered by story-002)_` on the "Therapist login screen" sub-issue. That's correct: story-002 already covers the auth flow.

Other multifurcations didn't tag overlap because there genuinely are no active specs touching those surfaces. The α.45 active-specs feature is silent when it should be, not over-eager. Good behavior.

## Finding 4 — Concurrency cancellation

The 7 `issues.labeled` events fired within 1 second of each other (18:03:34–18:03:38 UTC per `gh run list`). 2 of the 7 runs got auto-cancelled by concurrency. Looking at [the workflow](https://github.com/delgoosh/monorepo/blob/main/.github/workflows/slowcook-refine.yml):

```yaml
group: slowcook-refine-${{ github.event.issue.number || github.event.pull_request.number }}-${{ github.event_name }}
```

The concurrency key is per-issue, so different issues shouldn't collide. The cancellations may be due to GHA runner pool limits (Ubuntu-hosted, ~20 concurrent). Worth confirming in the runner logs before declaring a bug.

## Finding 5 — Cost shape

| Stage | Cost | Note |
|---|---|---|
| Multifurcation (7 runs × Sonnet) | $0.067 | Cheap; would be cheaper still with prompt caching enabled (none of these hit cache) |
| Refine questions round on #641 (Opus) | $2.19 | High — used 56K input tokens of project context, no cache |
| Refine questions round on #647 (Opus) | $1.16 | 47% cheaper than #641 due to cache hit (62548 cache_read tokens) |
| Total | ~$3.42 | |

The Opus calls are 32x more expensive than the multifurcation pass. Two questions for the prompt:
1. Why is the same project-context block not getting cached across issues filed in the same hour? `cacheSystem: true` is set on refine but `cache_read=0` on #641 (first issue to hit) and `cache_read=62548` on #647 (later, hit cache). That works as designed; the puzzle is the gap between them.
2. With caching the marginal refine cost is ~$1.20. Across 6 stuck issues that's $7.20 we'd burn if each PM responded "keep as one" individually. Cost of the multifurcation prompt bug is real.

## What this reveals about slowcook (per the dogfood ask)

### Pipeline quality

- **Refine pipeline is reaching real PMs** — the bot output is publishable in tone, in PM voice, and the multifurcation comment template is readable.
- **Brownfield context is genuinely consulted** — #647's audit trail proves indexer + Pass B both fire.
- **Prompt heuristics are leaky** — the "story-sized" judgement isn't anchored to PM-real units. The prompt assumes a model with PM intuition; in practice Sonnet defaults to maximum granularity.

### What's lacking

1. **A "story-sized" anchor in `MULTIFURCATION_SYSTEM`.** Need calibration examples — show the model 3-4 inputs that ARE one story (multi-field profile screen, send+receive messaging, multi-tab list view) and 3-4 inputs that ARE multiple stories (program-of-work, multi-app re-design). Current prompt has only the "MANY" examples, no balanced "ONE" examples beyond the abstract definition.
2. **An anti-recursion guardrail.** When the issue body's first line literally contains "Split from #640 (slowcook multifurcation)", the model should default heavily toward `one`. Cheap to detect — the multifurcation comment template adds this footer; we just need to read it.
3. **Pass B audit display fix.** Strip answered questions from the PM-facing block, or visually separate them. Current behavior shows the same question twice.
4. **Multifurcation cost rollup.** Currently each multifurcation emits a `slowcook:cost` marker but there's no aggregator surfacing "you spent $X on multifurcation passes that the PM rejected". A rollup would catch this class of waste.
5. **Multifurcation eval fixture.** The α.44/α.45 prompt has no eval coverage — none of the dogfooded inputs are in the eval set. A regression test that asserts `verdict==one` on the 6 stuck sub-issues would prevent future multifurcation drift.

### What's working

- α.45 overlap-as-annotation: fires correctly + silently when not applicable
- α.36 Pass B brownfield-answer: extracts real signal from the indexer
- α.42 history-index attention: surfaced the mock excerpt + sidebar nav as searchable structure (visible in #647's audit citing `sidebar.tsx`)
- Multifurcation cost on Sonnet is cheap enough that the rejected proposals don't bankrupt the dogfood

## Recommended next steps (in priority order)

1. **α.46 prompt fix** — add ONE-shaped calibration examples to `MULTIFURCATION_SYSTEM` + the anti-recursion rule. Re-dogfood by removing the `slowcook-multifurcation-proposed` label on the 5 affected issues; verdict should flip to `one`.
2. **α.46 — eval fixture** for the 6 stuck inputs. Locks the fix.
3. **α.47 — Pass B audit-trail UI fix.** Single comment template fix; cosmetic but high-visibility.
4. **Defer** the deeper "rollup wasted-multifurcation cost" + concurrency cancellation investigation until the prompt fix is verified.

## Artifacts referenced

| File | URL |
|---|---|
| Parent issue #640 (multifurcation worked here) | https://github.com/delgoosh/monorepo/issues/640 |
| #641 questions output ($2.19 on Opus) | https://github.com/delgoosh/monorepo/issues/641#issuecomment-4529527907 |
| #642 over-split (5 sub-issues) | https://github.com/delgoosh/monorepo/issues/642#issuecomment-4529528120 |
| #643 over-split (4 sub-issues) | https://github.com/delgoosh/monorepo/issues/643#issuecomment-4529528220 |
| #644 borderline-correct split + overlap tag | https://github.com/delgoosh/monorepo/issues/644#issuecomment-4529528266 |
| #645 over-split (scope creep) | https://github.com/delgoosh/monorepo/issues/645#issuecomment-4529528307 |
| #646 borderline split | https://github.com/delgoosh/monorepo/issues/646#issuecomment-4529528374 |
| #647 Pass B + 3 PM questions ($1.16) | https://github.com/delgoosh/monorepo/issues/647#issuecomment-4529528434 |

(Comment IDs harvested from `gh api repos/delgoosh/monorepo/issues/<N>/comments`; URLs may need verification.)
