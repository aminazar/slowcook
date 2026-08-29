# LCR triage — where a QA report goes, and how far back it propagates

The rule in one line: **route every report to the deepest artifact that
reality contradicts — and stop there.** Everything above that artifact
inherits by reference (`source_issue`, `clarifications`, supersedes),
never by copy.

Born from the rewo QA seasons (2026-08); the machinery it routes into
already exists — this document adds only the decision and its record.

## The one triage question

> Which artifact does reality contradict?

Checked against the merged stack — specs, tests, shipped affordances,
the constitution — a report is exactly one of three things:

| class | reality vs contracts | route | upstream edits |
|---|---|---|---|
| **violation** | contradicts a contract that exists | bug profile → regression test → sift | **none** — the spec already says the right thing |
| **gap** | matches every contract; the want is specced nowhere | story → clarify/refine → spec → tests → brew | PRD only by explicit PM promotion |
| **contradiction** | matches the contract; the human no longer wants the contract | change-of-mind → supersede/amend; ruling verbatim in `clarifications` | constitution only if the ruling generalizes (earned-line rule) |

## The four rules

1. **One triage line per report.** The PM answers the question on
   agent-gathered evidence and records one comment on the issue naming
   the class and the contract consulted. That comment IS the audit
   trail; there is no router command.
2. **Reproduction before questions.** For a suspected violation, the
   agent spends the free evidence first: reproduce, inspect, cite.
   A PM question that reproduction could have answered is the agent
   doing its work in the PM's inbox. Questions that survive follow the
   clarify discipline (S2): true forks only, recommended option marked.
3. **A green covering test over a true violation is itself defective.**
   The regression test that reproduces the report becomes the fix's
   contract; the lying test is amended in the same flow
   (`slowcook amend` records why).
4. **PRD and constitution move only by explicit promotion.** No report
   auto-propagates past its class's destination. The sync that is
   mechanized (spec hashes, analyze, provenance, red baselines) is
   spec↔tests↔code; product law accretes at PM rhythm.

## What was deliberately NOT built (and why)

- **No auto-classification authority.** Agents SUGGEST a class with
  evidence (investigate's advisory triage); the PM decides. The season
  that produced this doc watched investigate hallucinate 4/4 profiles.
- **No automatic PRD backprop.** Across two seasons, zero reports
  needed a PRD edit. "All artifacts always in sync" is an unproven
  assumption; don't pay for it.
- **No `slowcook route` command.** All three destinations are existing
  pipelines; the decision is one PM sentence.
- **The mock is evidence, not law.** A gap is judged against merged
  contracts; the mock shows intent but can be stale.
