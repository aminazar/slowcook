# Slowcook launch — raw material for LinkedIn intro

> Compiled 2026-05-07 from git log + CHANGELOG + memory + docs/experiments.
> Source-of-truth dates, dollar figures, commit refs. A human or agent
> picks the angle and writes the actual post / article from this.

---

## The seventeen-day arc (numbers)

- **Day 0:** 2026-04-20 — slowcook 0.1, first commit (`3f08533`)
- **Day 17:** 2026-05-07 — slowcook 0.19.0-alpha.14 in repo
- **285 commits** total (`git log --oneline | wc -l`)
- **727 cli tests** (from zero)
- **One real-world consumer dogfood**: rewo (reaction-worthy, social link-sharing)
- **Architectural pivots survived**: 2 (data-layer seam scrapped; entity-first hypothesis falsified)

## Headline cost numbers

| Moment | Cost | Context |
|---|---|---|
| Pre-slowcook Opus baseline | $4-12 / story | 0 checkpoints, never converged |
| **First autonomous brew (2026-04-22)** | **$0.04** | rewo story-005, 2 iters, 11/11 green, 3m 57s. **~300× cost reduction.** |
| First end-to-end clean ship (2026-04-25) | $1.92 | rewo PR #114, story-007, full pipeline |
| First clean 0.18 brew (2026-05-04) | $1.29 | rewo issue #149 → PR #154, 35/35 green, 3 checkpoints |
| Chef α.9 L1 drift-fixer (2026-05-05) | $0.045 / move | PinnedStrip → PinnedRewosStrip rename autonomous |
| Chef α.10 L3 orchestrator (2026-05-07) | $0.012 / decision | PR #153 verdict CLOSE, PM-actionable comment |

---

## The hypothesis we started with

*"LLMs can ship features autonomously if you give them the right
guardrails: tests as the contract, ratcheted progress, hard halt
classes, bounded attention."*

This was an open question on 2026-04-20. Prior Opus attempts at the
same task shape cost $4-12 per run with zero checkpoints — the agent
would write code, run tests, and never converge.

---

## The arc — phases, struggles, "Aha!" moments

### Phase 1 — Bootstrap + first autonomous brew (Apr 20-22)

**Apr 20** — slowcook 0.1 ships. Monorepo bootstrap, frozen-paths
guard, manifest record/verify, init command, refinement agent
(0.4), forge-github adapter (0.4), test-gen agent (0.5).

**Apr 21** — 0.6 ships: `brew` — the ratcheted implementation loop.
Single-lane. Halts on `MANIFEST_DRIFT` when story tests aren't
discovered, on `API_ERROR` for external-call failures.

**Apr 22 — first AHA moment.**

> **Rewo `story-005`** (a reactions-page API) **brewed end-to-end:
> 2 iterations, $0.04 spent, 11/11 tests green in 3m 57s.**
> Prior Opus attempts on the same shape: $4-12 per run with zero
> checkpoints. Sonnet + focus tools + tier-1 shape + stubs-in-place
> delivered a ~**300× cost reduction** and crossed the autonomy
> threshold.

This was the proof-of-concept. Everything after this is making the
loop reliable across more shapes.

### Phase 2 — The three gap classes (Apr 23-24)

**Apr 23** — 0.7.0 ships in three phases (forge-agnostic refactor;
stack-agnostic refactor; testgen Phase 2 auto-generates stubs +
helpers). Slowcook starts paying back the tech debt the LLM borrowed
across 0.3-0.6.

**The dogfood discovers three recurring gap classes** on rewo:

1. **Page-integration gap.** Story-006 shipped + tests green + merged,
   but the `/profile` page never imported `ProfileEditForm`. User
   saw nothing.
2. **Migration gap.** Story-005/006 shipped green but `supabase/migrations/`
   had no DDL for the `handle` / `handle_confirmed` / `handle_changed_at`
   columns the spec described.
3. **Styling gap.** Brew shipped components with zero `className` —
   functionally correct, axe-clean, tests green, **visually unusable**.
   User restyled by hand.

**The "Aha!" pattern (Apr 23-24):** these aren't prompt-steering
problems. They're test-coverage problems. The agent is optimizing
hard-signals (tests); soft-signals (prompt nudges) get ignored under
optimization pressure.

**Fix shape: structural gap assertions** (0.7.17 + 0.7.18 + 0.7.20):
deterministic tier-1 tests check that page imports the component,
that migrations match the spec's DDL claims, that components carry
className tokens. Each gap class becomes a hard signal.

> **Lesson that has held across the whole project:** soft prompt
> steering is a soft signal that brew ignores under optimization
> pressure. Tests are the hard one.

### Phase 3 — Refinement proposals + first clean ship (Apr 24-25)

**Apr 24** — 0.10.0 Gate 1 ships (deterministic UI mechanical checks).
0.11.0 ships refinement proposals (8-category detect/propose rubric).

**Apr 25 — first end-to-end clean ship.** Rewo PR #114, story-007,
$1.92, 32/32 green. First time the WHOLE pipeline (refine → testgen
→ brew) shipped a story without manual intervention between stages.

**Apr 25** — 0.13.0 ships: bug-flow + chef orchestrator + testgen
renamed to `recipe`. Two parallel pipelines now: stories (refine →
recipe → brew) and bugs (investigate → recipe-regression → sift).

### Phase 4 — The data-layer seam scrap (Apr 26-27)

**Apr 26** — 0.14.0 ships: mockup-first data-layer seam. Mock fixtures
colocated with production at `src/lib/data/<domain>.{mock.ts,ts}`.
0.15.0-α.1 → α.4 ships vibe + plate + brew --mode plate.

**Apr 27 — first scrap. PR #145 closed.** The 0.15 line had three
mistakes:

1. Mock data colocated with production — one bad import + mocks ship
   to prod. PMs had to clone + `npm run dev` locally; no live preview.
2. Per-story shadow components — let brew duplicate UI to satisfy
   stub-path tests (rewo PR #117 + #142 failure mode).
3. Brew did everything — vibe wrote mockup files; brew swapped data
   layers + dealt with PR comment drift. Brew's reward function
   (test-pass) didn't include "looks right" → design contract at risk.

**The "Aha!" / pivot:** **0.16.0 — singular mock app + element-anchored
review.** New per-consumer `mock/` Next.js app, totally separate from
`src/`. Dockerized live preview deployed via SSH to consumer's box.
Element-anchored review overlay (`@slowcook-ai/review-overlay` package
ships separately). Plate classifies PM comments and applies amendments.
Brew copies mock → src deterministically (`slowcook port`) then wires
real data.

The 0.16 line evolved through **30 alphas (α.1 → α.30) over Apr 27 –
May 3**. Each alpha closed a real-world wall. The architecture
stabilized at α.30 (halt-XML parser: agent's diagnosis becomes the
halt classification).

### Phase 5 — Refine becomes the leverage point (May 3)

**May 3 — 0.17.0-α.0** ships: refine becomes history-aware. The
insight that drove this: every downstream pipeline divergence we
investigated traced back to refine missing brownfield context.

> **Lesson:** refine is THE leverage point. Fix refine first;
> downstream agents converge naturally.

### Phase 6 — Entities-first hypothesis FALSIFIED (May 4)

**May 4** — 0.18.0-α.6 + α.7 ship `slowcook init entities`. The
hypothesis:

> If we extract the consumer's domain ERD into TypeScript interfaces
> + zod schemas at `src/lib/entities/<table>.ts`, and every agent
> prompt directs them to import canonical types from that barrel,
> the prop-shape drift class disappears. The compiler enforces what
> was previously a soft signal.

**May 4 — falsified.** Three real dispatches across vibe + brew
showed agents IGNORE the entity-import directive. Soft-prompted
entity-import directive doesn't fire even with structural support.
Agents legitimately use per-component view subsets, not full entity
types. Writeup: `docs/experiments/entities-hypothesis-tested-and-failed.md`.

> **Lesson:** soft-prompted directives don't override the model's
> per-component reasoning. The hypothesis was the cheapest version
> of the "give them a typed contract" answer; it didn't hold under
> the conditions we built. Architectural pivot follows.

### Phase 7 — Pair-brew + chef as two-layer system (May 4-5)

**May 4 — pair-brew prototype.** Driver + navigator agents in
alternation. Driver writes prod code; navigator reviews each
iteration with structured per-axis verdicts (design_fidelity, reuse,
responsive, test_prediction, api_contract, accessibility,
code_quality, cross_story_risk). Two real runs on the runner
(~$1.10 each, 5 iters each, both hit iter cap). **Empirical findings:**

- Navigator self-flip-flops (iter 1: BLOCK extract; iter 4: BLOCK
  inline; iter 5: BLOCK extract again — driver did the right thing
  each time and got blocked for it).
- Navigator hallucinates stricter spec contracts than the spec
  actually requires.
- Cross-contract drift (spec vs mock vs tests using different prop
  names) is the architectural bottleneck, not driver competence.

Writeup: `docs/experiments/pair-brew-real-runs-2026-05-04.md`.

**May 4 — first clean 0.18 brew.** Rewo issue #149 → PR #154,
**35/35 green, 3 checkpoints, $1.29**. The architecture that survived
all the scrapping ships its first clean run.

**May 5** — 0.18.0 stable cut. Two architectural arcs settle:

- Entities falsified.
- Pair-brew + chef as two-layer system.

### Phase 8 — Chef as micromanager finisher (May 5-7)

**May 5** — Chef α.9 L1 drift-fixer ships. Empirically validated on
rewo PR #157 ($0.045 single move, PinnedStrip → PinnedRewosStrip
autonomous). Chef as a SURGICAL EDITOR — never edits tests, uses
literal `search_replace` operations, validates pre-vs-post.

**May 6** — Chef α.10 L2 finisher mode (`chef-drift --pr <n>`)
checks out PR's branch, edits there, pushes back. Path-alias resolver
fix (α.1).

**May 7** — Chef α.10 L3 orchestrator (`chef-orchestrate`)
empirically validated on rewo PR #153. **$0.012, verdict CLOSE,
PM-actionable comment cited #154 + #155**. Capstone of the chef
stack: drift L1+L2 → exit-1 → orchestrate L3 → escalate / close /
redispatch / rebase.

Workflow auto-chain wires chef-drift exit-1 → chef-orchestrate
without operator intervention.

### Phase 9 — OSS-ready (May 7)

Three autonomous "exhaust the task list" runs in one day:

- 11 tasks closed across the 3 rounds (chef L3, pair-brew prod,
  navigator-emit-tests, recon shape v2, refactor, reuse-scan, chef
  auto-chain, default pair-brew, reuse filters, stub detector, cost
  markers + halt-trigger artifact + REPORTING.md + AGENTS.md +
  bug-report process)
- cli `0.18.0` → `0.19.0-alpha.14`
- Tests: 562 → 727 (+165)
- Real Anthropic spend on the day: **$0.012**

Slowcook is now operationally ready for outside consumers:

- **REPORTING.md** — how to file bugs (no artifact bundles; share URLs)
- **AGENTS.md** — onboarding for AI coding agents using slowcook
- **`SLOWCOOK_READ_ONLY=1`** — single env-var knob for maintainer-replay
- **Issue template + label set + CONTRIBUTING.md** — incident-response
  loop end-to-end

---

## Key recurring lessons (architectural takeaways)

1. **Tests > prompts** as enforcement. Soft prompt steering gets
   ignored under optimization pressure. Lock invariants in tests
   (the page-integration / migration / styling gap fixes; the
   shape-preserve tests; the chef-drift frozen-paths guard).
2. **Refine is the leverage point.** Every downstream divergence
   traces back to refine. Fix refine first; downstream agents
   converge naturally.
3. **Bounded attention is the cost lever.** Phase 0 (target slice +
   per-iter scope reduction) cut brew cost ~44%; Phase 1 (history
   index) added another 15%; Haiku model cut another 50%. Same
   problem, smaller scope = orders of magnitude cheaper.
4. **Architectural pivots are fine** — even mid-cut. 0.15 line
   scrapped after 4 alphas; 0.16 mock-app architecture survived
   30 alphas to 0.18 stable.
5. **Negative results are valuable.** Entities-first hypothesis
   falsified after 3 real dispatches. Definitive negative unblocked
   pair-brew + chef as the actual pivot.
6. **Failure modes have shapes.** AGENT_STALLED_NO_EDITS,
   MANIFEST_DRIFT, MOCKUP_DESIGN_CONFLICT, TRANSITIVE_REGRESSION —
   each named halt class is a learned failure pattern with a
   tailored recovery.
7. **Observability surfaces real bugs.** 0.7.13 → 0.7.16 arc: each
   visibility improvement let us hear the agent's correct diagnosis.
   Three "debug logging" releases converted a stuck pipeline into a
   bug report the agent wrote for us. Reach for observability
   before defensive fixes.

---

## Three angles the post / article could take

### Angle A — "300× cost reduction in 17 days"

Lead with the numbers. Pre-slowcook: $4-12/story, 0 checkpoints,
never ships. Day 3 of slowcook: $0.04, 11/11 green, ships. By day 17:
full chef stack auto-loop, OSS-ready, $0.012/decision.

The narrative: "I built an agentic TDD harness; here are the cost
graphs."

### Angle B — "What I learned shipping in public for 17 days"

Lead with the **lessons** (the seven above). Each is a paragraph with
the empirical evidence behind it. Date-stamped failures + Aha! moments
along the way. Honest about what got scrapped (0.15 data-layer seam,
entities-first).

The narrative: "I tried 'agents ship features end-to-end' for 17 days.
Here's what worked, what failed, and what surprised me."

### Angle C — "The 0.15 scrap + entity-first falsification"

Lead with one specific failure arc. The 0.15 line shipped 4 alphas
before getting scrapped. The entity-first hypothesis got 3 real
dispatches before getting falsified. Each pivot opened the path
that became the actual product.

The narrative: "I scrapped two architectures in three weeks. Both
failures unlocked something better."

My pick: **B**. Most authentic; respects the audience's intelligence;
gives the reader a model they can apply to their own work.

---

## Concrete numbers / dates / refs (one-liners — drop into copy)

- 2026-04-20 — slowcook 0.1, first commit (`3f08533`)
- 2026-04-22 — first autonomous brew, **$0.04 / 11 tests green / 3m 57s**, ~300× cheaper than Opus baseline
- 2026-04-25 — first end-to-end clean ship: rewo PR #114, story-007, $1.92
- 2026-04-27 — 0.15 data-layer seam scrapped (PR #145 closed); 0.16 mock-app architecture begins
- 2026-05-03 — refine-as-leverage-point insight (0.17.0-α.0)
- 2026-05-04 — entities-first hypothesis falsified after 3 real dispatches; pair-brew prototype validated
- 2026-05-04 — first clean 0.18 brew on rewo issue #149 → PR #154, $1.29, 35/35 green
- 2026-05-05 — 0.18.0 stable cut; chef α.9 L1 validated ($0.045/move)
- 2026-05-07 — chef α.10 L3 orchestrator validated on PR #153, $0.012/decision; OSS incident-response wired (REPORTING.md, AGENTS.md, issue template, labels)
- **285 commits, 727 tests, 17 days** to operationally-ready OSS

---

## Suggested short LinkedIn post (≤ 300 words)

> 17 days ago I started slowcook — an agentic TDD harness for
> shipping features autonomously through GitHub.
>
> Day 3: first autonomous brew, **$0.04**, 11 tests green, 3m 57s.
> Prior Opus attempts on the same task: $4-12 with zero checkpoints.
>
> Day 7: first end-to-end clean ship through the full pipeline
> (refine → tests → brew). $1.92.
>
> Day 8: scrapped the architecture (mocks colocated with prod was a
> mistake). Pivoted to a singular mock app + element-anchored review.
> 30 alphas later it shipped.
>
> Day 14: tested an entity-first hypothesis (typed contracts retire
> prop-shape drift). Definitively false after 3 real dispatches.
> Pivoted to pair-brew (driver + navigator agents).
>
> Day 15: first clean 0.18 brew. 35/35 green, 3 checkpoints, $1.29.
>
> Day 17 (today): chef stack closes the auto-loop. Drift fixer →
> orchestrator → escalate-or-close-or-redispatch. **$0.012 per
> orchestration decision.** OSS incident-response wired (REPORTING.md,
> AGENTS.md, issue template). Operationally ready for outside consumers.
>
> 285 commits. 727 tests. Two architectures scrapped, one definitively
> falsified hypothesis, one ~300× cost reduction.
>
> The thing I keep relearning: **soft prompt steering is a soft
> signal that LLMs ignore under optimization pressure. Tests are the
> hard one.** Every time we ran into "the agent isn't doing X,"
> the answer was "add a test that fails when X is missing." Ratchet
> beats reasoning.
>
> Slowcook is on npm: `@slowcook-ai/cli`. Repo:
> github.com/aminazar/slowcook. AGENTS.md is the entry point if
> you're an AI agent using it. REPORTING.md is the entry point if
> something breaks.
>
> Next: real-world consumer beyond rewo. If you're shipping features
> through Claude Code or similar and want to try slowcook, DM me.

---

## Suggested longer article outline

**Title options:**
- "I shipped an agentic TDD harness in 17 days. Here are the lessons that survived."
- "Two scrapped architectures, one falsified hypothesis, $0.012/decision: building slowcook in public."
- "Why my AI coding agent's tests are now 727 lines longer than its prompts."

**Sections:**

1. **The hypothesis** — agents can ship if you give them tests as
   the contract + ratcheted progress + bounded attention.
2. **The first $0.04** — 2026-04-22, the moment everything changed.
   Sonnet + focus tools + tier-1 shape + stubs-in-place. Why prior
   $4-12 attempts failed.
3. **The three gap classes that taught me prompts don't work** —
   page-integration, migrations, styling. Each one looked like a
   prompt-steering problem; each one was actually a
   test-coverage problem.
4. **Refactoring while the engine's running** — 0.7.0 paying the
   forge-agnostic / stack-agnostic tech debt. Modularize early
   even when there's only one consumer.
5. **The 0.15 scrap** — colocating mock data with prod. Why I shut
   it down after 4 alphas.
6. **The mock-app pivot** — 0.16. 30 alphas of evolution. Element-
   anchored review overlay. Live dockerized preview. Plate as a
   classifier.
7. **The leverage point** — 0.17. Refine is the keystone. Every
   downstream divergence traces back.
8. **The entity-first negative** — 0.18. Three dispatches. Zero
   entity imports. Soft-prompt directives don't fire under
   optimization pressure. (Worth its own sub-section.)
9. **Pair-brew + chef as two-layer system** — driver/navigator
   pair-programming pattern. Chef as the surgical editor /
   orchestrator. Auto-loop closes.
10. **Operationally ready** — REPORTING.md, AGENTS.md, read-only
    mode. How a third consumer would adopt slowcook.
11. **What I'd do differently** — start with bounded attention from
    day 1. Build observability before clever fixes. Codify the
    "tests > prompts" rule earlier.
12. **What's next** — pipeline-level eval harness, real-world
    consumer beyond rewo, GitLab/Bitbucket forge adapters.

**Word target:** 2,000–3,000. One graph per section minimum (cost
chart, halt-class diagram, pipeline architecture). Code snippets
sparingly — show the verdict shape, not the implementation.
