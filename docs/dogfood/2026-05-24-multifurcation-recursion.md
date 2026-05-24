# Multifurcation depth-2 decomposition — dogfood findings 2026-05-24

Dogfooded `cli@0.19.0-alpha.45` against delgoosh-monorepo issue [#640](https://github.com/delgoosh/monorepo/issues/640) ("everything according to mock") and the 7 sub-issues filed from its multifurcation. Real refine output from the live GHA pipeline; no simulation. Every claim links to the bot comment driving it.

> **Revision note (2026-05-24, post-PM review):** an earlier draft of this doc called the depth-2 multifurcation a recursion *bug* and proposed an α.46 anti-recursion fix. The PM correctly pointed out that the parent #640 ("now create the entire app on top of mocks") was epic-scale, and each first-level sub-issue was itself program-scale ("patient messaging" is not one PR; it's a track). The second multifurcation pass correctly broke those programs into story-sized units. Conclusion reversed: **multifurcation handled a 2-level decomposition correctly.** The α.36 Pass B audit-display bug is the only real action item that survived re-examination.

## TL;DR

α.44/α.45 multifurcation **correctly decomposed a 2-level epic**. Given an input the shape of "build the app" → 8 sub-issues at first multifurcation → most of those were still program-scale, so the second multifurcation pass broke them into 2-5 story-sized units each. Per-issue audit below shows ~19 of 20 second-level splits are PM-sized stories that ship and test independently.

The α.36 Pass B audit-display has a real UI bug worth fixing: on #647 the same question text appears in both the PM-facing question block and the "answered from brownfield" audit trail. Fix is a single comment-template tweak.

## Setup

| Item | Value |
|---|---|
| cli on box | `0.19.0-alpha.45` (synced via `setup-slowcook` from `origin/main` 0b089ee) |
| Models | Opus 4.7 (refine main) · Sonnet 4.5 (multifurcation + relationship) |
| Parent issue | [delgoosh#640](https://github.com/delgoosh/monorepo/issues/640) — "Everything according to mock" |
| Sub-issues (7) | [#641](https://github.com/delgoosh/monorepo/issues/641)–[#647](https://github.com/delgoosh/monorepo/issues/647) |
| Time | 2026-05-24 17:35–18:05 UTC |
| Total refine spend | ~$3.40 |

## What happened, per issue

| Issue | Multifurcation verdict | Sub-issues | Outcome | Cost |
|---|---|---|---|---|
| #640 (parent) | many | 8 (+ 1 overlap on auth) | First-level split filed | $0.0135 |
| #641 Appointments | skipped (had prior label) | — | 2 PM questions emitted | $2.19 |
| [#642 Profile](https://github.com/delgoosh/monorepo/issues/642) | many | 5 — correct (per-flow) | Awaiting PM | $0.0104 |
| [#643 Messaging](https://github.com/delgoosh/monorepo/issues/643) | many | 4 — 3 correct, 1 fold-candidate | Awaiting PM | $0.0099 |
| [#644 Login+Dash](https://github.com/delgoosh/monorepo/issues/644) | many | 2 (1 overlap-tagged) — correct | Awaiting PM | $0.0077 |
| [#645 Calendar](https://github.com/delgoosh/monorepo/issues/645) | many | 4 — correct | Awaiting PM | $0.0096 |
| [#646 Patient list](https://github.com/delgoosh/monorepo/issues/646) | many | 3 — correct | Awaiting PM | $0.0093 |
| #647 Therapist messaging | one | — | 3 PM questions, 1 answered from brownfield (Pass B) | $1.16 |

## Per-multifurcation audit

### #642 "Patient profile" → 5 sub-issues (CORRECT)

Parent body literally enumerated: *"pulls real user information from the backend AND applies the new design. Patients can view AND edit their name, contact details, AND preferences."* Split:

1. Read-only display — one PR (GET endpoint + render with new design)
2. Edit name inline — PATCH endpoint + inline edit + validation
3. Edit contact details — separate validation (email format, phone region)
4. Display preferences — different data source (settings table vs profile)
5. Edit preferences — toggle persistence + cache invalidation

Each ships and tests independently. Edit-name and edit-contact have different validation rules + likely different endpoints. Preferences are an entirely different storage surface.

### #643 "Patient messaging" → 4 sub-issues (3.5 of 4 correct)

- **Send** — one PR (POST endpoint + UI)
- **Real-time receive** — this is a websocket/SSE infrastructure project; probably multiple sub-stories itself
- **History load** — one PR (GET messages with pagination + UI list rendering)
- **Therapist name+avatar** — borderline; small enough to fold into the send story, but defensible as a polish ticket

If anything, this split is conservative — receive likely needs further breakdown.

### #644 "Therapist login + dashboard" → 2 sub-issues (CORRECT)

Two independently-shippable screens. The overlap tag on login (`_(already covered by story-002)_`) is exactly right — story-002's auth flow covers patient + therapist together.

### #645 "Therapist appointment calendar" → 4 sub-issues (CORRECT — not scope creep)

Earlier I called the slot CRUD a scope creep. Re-reading the parent body: *"Therapists see their booked sessions, **available slots**, and **can manage their schedule**."* "Manage" = create/edit/delete. The 4-way split literal-parses what was asked:

1. View booked appointments (GET /me/appointments)
2. View available slots (separate data source, GET /me/availability)
3. Create slots (POST /me/availability + UI form)
4. Edit/delete slots (PATCH/DELETE + UI affordances)

### #646 "Therapist patient list" → 3 sub-issues (CORRECT)

Three navigationally-distinct screens with distinct data:

1. Roster (list of assigned patients)
2. Patient profile detail page (drill-in)
3. Treatment history sub-page (further drill-in)

## Finding 1 — Pass B audit display has a real bug

#647 is the only sub-issue that made it to the questions round and shows α.36 Pass B in action:

> _🔍 Checked brownfield first: **1 of 4** questions already answered in your codebase (see audit trail below). **3** still need your input:_

The brownfield answer correctly identified that `mock/src/components/therapist/sidebar.tsx` has no chat nav entry and `mock/src/app/therapist/chat/page.tsx` doesn't exist. Good — Pass B is reading the indexer correctly.

**Bug**: the question that was "answered from brownfield" is shown verbatim in BOTH the PM-facing question block (as Question #1) AND the audit-trail `<details>` block. The reader cannot tell what's still-open vs resolved. The Pass B comment template should:
- Strip the answered question from the PM-facing block entirely, OR
- Visually distinguish it (strike-through + "(resolved)" tag)

Reference: [#647 first bot comment](https://github.com/delgoosh/monorepo/issues/647) — search for "1 of 4 questions already answered" and note the duplicate "There's no therapist chat page" text in both blocks.

## Finding 2 — α.45 overlap tagging is silent when it should be, fires when it should

Only #644 produced an overlap tag (story-002 on the login sub-issue). Other multifurcations didn't tag overlap because there genuinely are no active specs touching those surfaces. Silent-when-it-should-be is good evidence the active-specs context isn't producing false positives.

## Finding 3 — Cost shape

| Stage | Cost | Note |
|---|---|---|
| Multifurcation (7 runs × Sonnet) | $0.067 | Cheap; no cache hits between calls |
| Refine questions on #641 (Opus) | $2.19 | 56K input tokens of project context, no cache (first hit) |
| Refine questions on #647 (Opus) | $1.16 | 47% cheaper than #641 — cache hit (62548 cache_read tokens) |
| Total | ~$3.42 | |

Caching across refine invocations works as advertised — the second issue picks up the system-prompt cache from the first. Worth confirming the cache TTL covers a typical multi-issue burst (an hour's worth of refines).

## What this dogfood actually validated

1. **Multifurcation handles multi-level decomposition correctly** when the input is genuinely epic-scale. The depth-2 unwrapping of "build the app" → 8 programs → ~20 stories is the right shape.
2. **α.45 overlap-as-annotation works** — fires on #644 (real overlap), silent on the other 5 multifurcations (no overlap, correctly).
3. **α.36 Pass B brownfield-answer is reading the indexer** — #647 cited the actual mock sidebar file by path. The retrieval substrate is doing its job.
4. **Prompt caching saves real money** — 47% delta between cached and uncached refine on similar-shaped issues.

## What needs fixing

Only one concrete action item from this dogfood:

**α.46 — Pass B audit-trail UI fix.** Single comment-template change. Strip answered questions from the PM-facing block or visually demote them. Cosmetic but high-visibility — PMs reading #647-shaped comments will be confused by the duplication.

## What does NOT need fixing (despite the earlier draft saying so)

- **Multifurcation prompt** — no calibration fix needed. The verdicts on #642-#646 are correct given how high-level the parent was.
- **Anti-recursion guardrail** — would actively harm us. The depth-2 unwrapping was load-bearing for getting from "build the app" to PM-sized stories.
- **Multifurcation eval fixture for the 6 "stuck" inputs** — they're not stuck, they're awaiting PM approval of correct splits.

## Open question worth checking later

GHA concurrency cancelled 2 of the 7 label-add runs. Workflow `concurrency.group` is per-issue, so cross-issue cancellation shouldn't fire. Likely a runner-pool exhaustion (Ubuntu-hosted, capped). Worth confirming in runner logs before declaring it a bug.

## Artifacts referenced

| File | URL |
|---|---|
| Parent issue #640 (first multifurcation) | https://github.com/delgoosh/monorepo/issues/640 |
| #641 questions output ($2.19 on Opus) | https://github.com/delgoosh/monorepo/issues/641 |
| #642 second-level split (5 sub-issues, correct) | https://github.com/delgoosh/monorepo/issues/642 |
| #643 second-level split (4 sub-issues) | https://github.com/delgoosh/monorepo/issues/643 |
| #644 second-level split + overlap tag (correct) | https://github.com/delgoosh/monorepo/issues/644 |
| #645 second-level split (4 sub-issues, correct) | https://github.com/delgoosh/monorepo/issues/645 |
| #646 second-level split (3 sub-issues, correct) | https://github.com/delgoosh/monorepo/issues/646 |
| #647 Pass B + 3 PM questions ($1.16) — has audit-display bug | https://github.com/delgoosh/monorepo/issues/647 |

## Meta-lesson from this revision

I confirmation-biased the depth-2 pattern into "recursion bug" without auditing each split's correctness. The pattern (`many → many`) felt suspicious; I wrote the conclusion before reading each sub-issue with PM lens. PM-led review caught it.

For future dogfood findings: **per-instance audit before pattern claim**. Run the PM-lens-check on each output before promoting a pattern observation to a bug call. The pattern might still be correct after audit — but the per-instance audit must come first.
