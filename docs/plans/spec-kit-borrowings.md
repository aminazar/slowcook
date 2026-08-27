# Borrowing from Spec Kit: constitution, clarify, analyze

> **Credit.** The three capabilities in this plan are adaptations of ideas
> from **[Spec Kit](https://github.com/github/spec-kit)** (GitHub's
> Spec-Driven Development toolkit, MIT, v1.0.x): the *constitution*
> artifact, the *clarify* phase, and the *analyze* cross-artifact
> consistency check. We borrow the concepts and re-ground them in
> slowcook's deterministic-gate philosophy; no Spec Kit code is copied.
> Recognition rides in the README acknowledgment, this header, and the
> CHANGELOG entry of each shipping release. **Vendoring policy:** where
> Spec Kit's template text is battle-tested (the clarify ambiguity
> taxonomy, question-format rules, the Clarifications log format), we
> copy it verbatim under its MIT license with an attribution header in
> each borrowed file — shameless and credited beats paraphrased and
> untested. What we deliberately do NOT borrow: the framework itself
> (slash-command scaffolding for a synchronous human-driven IDE session,
> with no enforcement layer — their constitution is enforced by "PR
> reviews verify compliance", i.e. human vigilance), Converge (an LLM
> re-reading artifacts is strictly weaker than slowcook's fail-closed
> gates), and spec-as-regenerable-source (the frozen-test ratchet is
> the stronger stance).

Motivating evidence is the rewo season (2026-08), where the human-PM
seat kept re-deriving the same law by hand:

- **Contradictory specs merged cleanly**: story-016 `request_schema
  rewoSlug` vs story-017 `rewo_id`; brew then broke two shipped
  contracts ($5.18) and PM arbitration invented the rule "the endpoint
  owner's shipped contract wins" — which then lived nowhere.
- **Rulings evaporate**: rpc-vs-app-level atomicity (story-019),
  RLS-on-new-tables (caught by taste only post-brew on #229),
  Monday-UTC ration semantics, w-stays-black, actor-honest copy — all
  settled in issue threads, none loaded by the next agent run.
- **Relay corruption**: the operator paraphrased a PM answer ("2a" →
  "unconditional cross-week refund"); taste proved the paraphrase
  unimplementable. Answers must be carried verbatim, mechanically.
- **Late questions**: story-019's architecture questions surfaced in
  taste round 3 of 4, not before the spec existed.

## S1 — Constitution (`.brewing/constitution.md`)

A repo-level law file that **every** agent stage loads: refine, taste,
brew, sift, plate.

**What it is and is not.** Tests bind the behavior of what exists; git
history and the code map carry *precedent* — but the trail encodes what
happened, not what's endorsed (dash's 1,937 inline-style blocks would
teach any trail-reading agent the drift as house style). The
constitution is the residue neither can carry: **authority grants**
(rules the model already knows — "endpoint owner's shipped contract
wins" — written down so the agent may act without escalating),
**endorsement bits** (one line blessing or damning an existing trail:
"tests/helpers idioms are canonical", "inline styles are drift"),
**defaults for the not-yet-built** (RLS posture, migration numbering,
`.rpc` for cross-entity writes), and **roads not taken, with reasons**
(the anti-re-proposal log). It is deliberately incomplete — chasing
completeness produces a second PRD that drifts.

**Shape: generic slots, project answers.** The template is a checklist
of decision slots that recur across projects (RLS posture,
contract-conflict priority, test-tier doctrine, week/time bucketing,
copy voice…) — the *questions* are generic, only the *answers* are
project law. Each slot has three states:

- **ticked** — rule active; agents enforce and cite it.
- **deliberately blank** — a deferral ruling ("RLS is too much at this
  stage"), with `justification/by/at` exactly like pm-waivers and an
  optional revisit trigger ("when we take external users"). Agents must
  NOT flag the deferred concern — the recurring taste finding becomes
  silence *with an audit trail*, and the trigger makes it a ratchet,
  not a hole. This also encodes the bit no git trail can:
  deliberately-blank vs never-considered.
- **unaddressed** — nobody decided. When an agent actually hits one, it
  escalates through the S2 clarify gate exactly once; the answer fills
  the slot and is never asked again. Clarify answers accumulate here.

**Filled lazily, never upfront.** Slots are answered when first hit (an
arbitration, a clarify escalation, a taste finding) — a day-one
compliance questionnaire is speculative law, the failure mode this plan
exists to avoid. The earned-line rule stands: only filled or
deliberately-blank slots are law; the rest is menu. (Spec Kit's
constitution command interviews from a template — that's the borrowed
idea; the three-state slots and lazy fill are the slowcook discipline
on top.)

Sections: a one-line authority clause up top (Spec Kit's, verbatim:
the constitution supersedes informal practices), `slots` (the
checklist above), `rulings` (append-only log: date, verbatim ruling,
source link — slot-less rulings land here and may graduate into a
slot). Git is the version history; no version string of its own.

- Loader `lib/constitution.ts`: read the file, inject as a system
  block. Nothing else — the file will be a page long for months; if it
  ever outgrows the prompt, that's a summarization chore filed on that
  day, not machinery built now.
- Append path: `slowcook rule add "<text>" --source <url>` — an
  `echo >>` with a provenance stamp, nothing more — plus the prompt
  instruction that every PM arbitration ends with a recorded rule.
  (Auto-append on `awaiting-pm` resolution: later, if the manual path
  proves annoying in practice.)
- NOT a frozen path (append-friendly); provenance-stamped so the
  ratchet records the writer.
- **Acceptance**: run traces show the block; negative test — a fixture
  where taste flags an RLS omission only when the slot is ticked, cites
  the slot when it does, and stays SILENT when the slot is deliberately
  blank (the deferral half is as load-bearing as the rule half).
- **Seeding**: write rewo's initial constitution from this season's
  earned rulings (list above) as part of the ship — tick those slots,
  leave the rest unaddressed.

## S2 — Clarify gate in refine

refine becomes two-phase. Phase A emits `questions:` to the source
issue and **does not write a spec**. The worker parks the job exactly
the way it already parks on a failed precondition (tri-state
preconditions exist; clarify-pending is one more named state — no new
state machine). Phase B ingests answers **verbatim** into the spec's
`## Clarifications` session log (format below) — extending #517's
evidence rule from code claims to PM answers; prompts forbid
paraphrase. Reuses the G6 approve-by-reaction plumbing.

**Questions are a decision tree, not a flat list** (Amin's symmetry
observation: dash's Guides v2 instructs the *human* as a branching
tree from the start; the human instructing the *agent* branches the
same way). The season's arbitrations were trees walked one
taste-round at a time: story-019 ("does merge_rewos exist?" →
adapt-form vs rpc-vs-app-level), B-5 email (SMTP vs Resend → disjoint
config questions), ration semantics (per-member-weekly → and only
then reset-anchor). Emitted upfront, one phone session walks the
relevant path instead of a day per round-trip.

The mechanism stays small, with Spec Kit's tested prompt material
vendored in:

- **Scan before asking** (vendored): Spec Kit's clarify taxonomy — 9
  ambiguity categories (functional scope, data model, UX flow,
  non-functional, integrations, edge cases, constraints, terminology,
  completion signals), each marked Clear/Partial/Missing inside the
  prompt. Refine scans, then asks only about Partial/Missing.
- **Node budget** (vendored idea): a hard cap on tree nodes (theirs is
  5 questions), highest-impact forks first, the rest explicitly
  deferred with a reason. Impact ranking is a prompt heuristic, not a
  metric; the cap is the rule. This is the anti-ballooning guard.
- **Question format** (vendored verbatim): full interrogative sentence
  (never a topic label), a **Recommended** option first with a
  one-line why, "reply with the letter / say 'recommended'" — which is
  also exactly the house AskUserQuestion rule, independently
  converged. 👍 on the comment walks all defaults (G6 plumbing).
- A question is YAML: `id`, `text`, `options` (label + optional nested
  `then:` questions), optional `default`, `blocking` flag. Nesting IS
  the tree — no graph engine, no UI; one nested markdown list in a
  single issue comment.
- Every question also accepts "don't know" — routing to the default
  (recorded as provisional) or `investigate` (agent gathers evidence
  and re-asks; the a/b pgTAP decision was this). A second clarify
  round is a normal outcome, not a failure — foreseeing every fork
  upfront is not assumed.
- **Answers land in ONE place in the spec** (vendored format): Spec
  Kit's `## Clarifications` section — `### Session <date>`, then
  `- Q: <question> → A: <verbatim answer>` lines. The issue thread is
  transport, this log is the record, the constitution is where an
  answer graduates if it's project law. No separate `rulings:` block.
- **Only answers on the walked path are recorded.** Un-walked branches
  are pruned, never law — walked-steps-only, applied to decisions.
  Outcome vocabulary is one set: `answered` / `deferred (reason)` /
  `pruned`.
- A tree with no forks is a list; refine's prompt says to nest ONLY
  where an answer genuinely changes the next question. Most stories
  should still produce 2–4 flat questions.

- **Acceptance**: fixture issue with a planted fork → refine posts the
  tree, no spec; answering one branch → spec quotes exactly the
  walked-path answers and none of the pruned branch; an unanswered
  blocking node keeps `agent:refine` parked with an honest noop, not a
  mega-spec (the G6 regression class).

**Prior art inside dash — align, don't invent.** Dash already runs this
pattern three ways, and S2 should adopt its shapes:

1. 41 story specs carry `open_questions:` bucketed **`addressable`**
   (answerable now) vs **`deferred`** (each with a named reason and
   pointer, e.g. "needs run-history volume") — adopt the two buckets;
   a deferral without a reason is invalid.
2. `specs/pm-waivers.yaml` is the answer-side record: every resolution
   carries `rule/target/resolution/justification/by/at`, and **an
   unjustified waiver is itself a lint error** — i.e. enforcement is a
   deterministic lint, not agent vigilance. S2's answer records take the
   same fields (verbatim text, `by`, `at`, source link), and "blocking
   question unanswered ⇒ spec invalid" becomes a lint, mirroring
   pm-lint's waiver rule.
3. Dash-the-product tracks brownfield Knowledge `questions` with
   `open_questions = questions.filter(q => !q.answer)` surfaced in the
   PRD page ("N open questions for you"). The clarify gate is the same
   product concept on the story axis — keep the shapes close enough to
   converge later; build nothing shared now.

## S3 — Spec analyze (cross-artifact consistency at spec-PR time)

`slowcook analyze --spec N`, run by taste's spec review and as a CI step
on spec PRs. Two checks:

1. **Against merged specs** — deterministic diff of contract surfaces
   (request/response schema fields, entity/table names, endpoint paths)
   for contradictions; LLM pass for semantic conflicts, findings must
   cite both specs.
2. **Against as-built** — routes/tables/functions a spec cites must
   exist in code/migrations or be declared `new:`; extends #517 and the
   #148 lesson (the overlap detector trusted specs over code).

- **Acceptance**: a 016/017-shaped fixture pair → the second spec's PR
  is blocked with both citations; a dead-table reference (story-019's
  `member_rewos`) is flagged.

## Phasing

S1 first (a file, a loader, prompt plumbing — days), S2 second (one new
precondition state + question emit/ingest), S3 third (needs contract
extraction from specs and as-built). Each ships with its CHANGELOG
credit line. Constitution is the dependency of the other two: clarify
answers append to it; analyze reads its `contracts` section as law.

**Fit check (what was cut to stay slowcook-sized):** no constitution
size-cap machinery, no shared question component with dash, no graph
engine or UI for trees (nested YAML + one markdown comment), no new
worker state machine (clarify-pending is a precondition), and trees
only where an answer changes the next question — the honest default
for most stories is still a short flat list. The benchmark lesson
stands ([[brew-focus-benchmark]]): designed mechanisms are the least
supported things until they've been run; every item above ships with
the fixture that proves it fires.

## Critical review (second pass: overengineering, convolution, untested assumptions)

Cuts and collapses made in this pass — the sections above already
reflect them:

- **CUT: constitution semver + ratification dates** (a Spec Kit borrow
  that didn't survive review). Git already versions the file; a
  version string inside it would drift from the real ledger. Kept only
  the one-line authority clause; per-ruling `by/at` covers dates.
- **COLLAPSED: answer records had grown four homes** (issue thread,
  spec `rulings:` block, `## Clarifications` log, constitution). Now
  one record: the in-spec Clarifications log. Thread = transport,
  constitution = graduation for project-level law only.
- **COLLAPSED: two status vocabularies** (Spec Kit's
  Resolved/Deferred/Clear/Outstanding vs dash's addressable/deferred).
  One outcome set survives: `answered` / `deferred (reason)` /
  `pruned`; Clear/Partial/Missing lives only inside the scan prompt.
- **Vendoring caveat:** Spec Kit's prompts are tested in a
  *synchronous* harness — "reply 'done'/'stop'", max-5 per sitting,
  human present. We vendor taxonomy and format TEXT, and rewrite all
  control flow for async label-driven parking. Their stop conditions
  are explicitly not vendored.

Untested assumptions, named, each pinned to the fixture that will
test it:

1. **Refine can foresee forks.** The season's trees were discovered by
   taste rounds, not predicted upfront. Mitigation is structural: a
   second clarify session is a normal outcome, and the node budget
   caps the damage of a wrong tree. Fixture: the planted-fork issue.
2. **Agents honor "deliberately blank".** Suppression-by-constitution
   is prompt discipline until proven. Fixture: the RLS negative test
   must show taste SILENT on a deferred slot, not just loud on a
   ticked one.
3. **A system block changes behavior at all.** Assumed, not known —
   the same RLS fixture is the proof either way.
4. **Lazy fill actually fills.** Risk: nobody ever answers slots and
   the constitution stays empty. Mitigation: seeding from this
   season's earned rulings; if six months pass with no new lines,
   that's a finding about the mechanism, not a reason to pre-fill.
5. **Impact ranking is a vibe.** Impact × Uncertainty is an LLM
   heuristic, not a measurement — the hard node cap is the rule;
   ranking only orders questions within it.
