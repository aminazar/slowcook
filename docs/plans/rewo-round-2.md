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

## Findings ledger (running, plain language)

How the round actually went vs the plan: the three lane issues
(#124/#78/#148) all closed at triage — #124 was already implemented
(Haiku correctly no-op'd), #78 already fixed, #148 a duplicate whose
spec claimed a "live" strip the code does not have. The lanes became:
finish stories 019/020/021 as the human (all MERGED: rewo #233, #228,
#229) and run the mock path on story-016 (PR #237, gate open with Amin).

1. **Tests can enforce a defect.** Story-020's suite mocked the WRONG
   supabase module, so 21/21 green while the code used a request-scoped
   cookie client in a background job; the reviewer praised it. Story-021
   repeated the class. Fix idea: taste must check WHAT the tests mock
   against what the spec's runtime context implies (background job ⇒
   service-role client).
2. **A broken test passed review because it was unreachable.** The
   corrected story-021 contract merged with a reference to a deleted
   mock in a test that only runs post-implementation. It exploded as a
   runtime ReferenceError once the feature existed. Fix idea: the tests
   gate should type-check (tsc) test files, not only run them.
3. **Specs trust prose over code.** Story-021's precondition claimed
   the crawler "already captures" og:site_name/byline; the schema has
   no such columns. Same class as the #148 triage finding (spec claimed
   a UI that does not exist). Fix idea: refine/overlap must verify
   claims about existing code against the code map.
4. **Shared checkout = agents fighting.** The plate responder switched
   /root/rewo to the mockup branch mid-repair of story-021; a test run
   silently executed against the wrong branch. Worked around with a
   manual worktree. Fix idea: every slowcook agent runs in its own
   worktree (run-mock/plate included; brew already isolates).
5. **Database verification is directory-keyed.** Supabase's local
   stack binds to the checkout directory; verifying a branch in a
   worktree requires stop-in-main/start-in-worktree. A slowcook db
   verification step must own that handoff, and only `supabase db
   reset` (full replay) is honest — "already running"/"from backup"
   states verify nothing.
6. **Migration numbers collide across branches.** #228 and #229 both
   claimed 00021. Renumber-at-merge-time is the manual fix; slowcook
   needs a cross-branch collision check (or draw numbers at merge).
7. **Mock boundaries are architectural claims.** The story-021
   author_id reuse survived because mock tests cannot see DB
   semantics; the pgTAP real-DB lane (Amin's ruling) is what caught
   the class. Taste should treat "what the mock hides" as a review
   dimension.
8. **run-mock hardening shipped mid-round**: SLOWCOOK_PUBLIC_AUTH_BASE
   override (#498), --legacy-peer-deps fallback (#499), plus the
   tool-protocol emulation so investigate/sift/vibe/plate all run on
   CLI subscription auth (Amin's ruling: one auth path for all agents).
9. **Still manual, still missing**: vibe does not ensure the mock
   builds or update the entry file (hand-wired the overlay); run-mock
   child processes escape unit restarts; brew pushes no-op branches;
   amendment crashes leave residue commits on the box main; worker has
   no ready-to-build report and no parallel lanes.

Model-tier observations so far: Haiku correctly refused unnecessary
work ($0.07-class discipline holds); Sonnet brews converge in 1-6
iterations ($1-4) but inherit test-contract defects uncritically; Opus
reviews catch real architecture defects (author_id reuse, RLS) yet
also praised defective-but-green suites — review quality is bounded by
what the test layer can see.
