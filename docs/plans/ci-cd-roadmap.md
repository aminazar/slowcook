# CI/CD roadmap

> Status as of 2026-05-12. Critical CI/CD review compiled from the
> empirical history of slowcook + comparison against mature CI/CD
> best practice. See the README's "Status" section for the current
> alpha line; this doc tracks the ops-maturity backlog specifically.

The slowcook pipeline today is genuinely ahead of the curve on
several axes — structured halt classes, replay-from-artifact, cost
markers, frozen-paths-as-permission, read-only mode. The list below
captures the gaps against CI/CD best practice and how each gets
closed (or why it's intentionally deferred).

## Shipped

| # | Item | Shipped | Notes |
|---|---|---|---|
| 1 | Branch-protect slowcook main | 2026-05-12 | `allow_force_pushes: false`, `allow_deletions: false`, admin can bypass for solo workflow. Tighten (require PR + 1 approval) when the first contributor arrives. |
| 2 | Wire Dependabot for npm + GitHub Actions | 2026-05-12 (commit `b936386`) | Weekly npm cadence, monthly Actions cadence, grouped (anthropic / vitest / typescript-types / typescript-core / testing). Auto-merge off for the first month. |

## Tracked (filed as issues)

| # | Item | Issue | Priority |
|---|---|---|---|
| 3 | **Eval gate in CI** — gates prompt-PR merge on no-regression against fixture set. Bootstrap from rewo's garnish-trailer history. | [#19](https://github.com/aminazar/slowcook/issues/19) | HIGH |
| 4 | **Standardize agent telemetry schema** — one JSON per run, machine-readable, indexed by run-id. Load-bearing for perf alerts + eval set. | [#20](https://github.com/aminazar/slowcook/issues/20) | HIGH |

## Queued (file as issues when picked up)

| # | Item | Priority | Why it's queued not filed |
|---|---|---|---|
| 5 | Auto-execute chef-orchestrate `redispatch_brew` + `rebase` verdicts. Closes the L3 auto-loop. | MEDIUM | Verdict-persistence already shipped; auto-execution is incremental work. File when first organic halt that would benefit surfaces. |
| 6 | Add SAST + secrets-scan to CI (CodeQL workflow + gitleaks). | MEDIUM | OSS-readiness item. Threat model is small today; cost to close is one workflow file. File before the first external contributor. |
| 7 | Release automation — changesets or release-please. Auto-CHANGELOG + auto-tagging. OTP step still human. | MEDIUM | Manual cost is ~5 min per alpha; not pressing until publish cadence accelerates. |
| 8 | Performance regression alerts — flag stories costing 3× rolling average. | LOW | Needs telemetry schema (#20) first. Becomes trivial after that lands. |
| 9 | Self-hosted runner failover — document the SPOF + add GitHub-hosted fallback for non-LLM jobs. | LOW | Contabo runner is reliable enough today. Document when it first goes down. |
| 10 | Replay mode for brew — parity with chef-drift's `--trigger-raw` flag. | LOW | Idempotency-completeness item. Useful for maintainer-side debugging of historical brew runs. |

## Where slowcook is already CI/CD-mature (worth emphasising externally)

These are not gaps but strengths under-emphasized in slowcook's
external narrative. Worth surfacing in marketing / launch copy:

- **Structured failure modes.** Ten named halt classes
  (`AGENT_STALLED_NO_EDITS`, `MANIFEST_DRIFT`,
  `MOCKUP_DESIGN_CONFLICT`, `TRANSITIVE_REGRESSION`,
  `AGENT_STALLED`, `BUDGET_EXHAUSTED`, `WALL_CLOCK`,
  `STAGNATION_CAP`, `API_ERROR`, `SPEC_AMBIGUITY_DETECTED`)
  each map to a specific recovery strategy. Most "agentic dev"
  tools have one bit (worked / didn't); slowcook has ten.
- **Replay-from-artifact.** chef-drift can replay any past failed
  run from its `halt-trigger.json` artifact. This is the kind of
  reproducibility mature CI systems aspire to.
- **Two-tier test stratification.** vitest tier-1 for shape, Playwright
  tier-2 for acceptance. Cleanly separated.
- **Uniform cost markers.** As of cli α.12, every agent emits a
  `<!-- slowcook:cost agent=X usd=Y ... -->` HTML comment.
  `gh issue view N | grep slowcook:cost` aggregates story-level
  spend across the entire pipeline.
- **Frozen-paths-as-permission.** Each agent gets a declarative
  write-scope it cannot violate. Permission-as-code.
- **Read-only mode** (`SLOWCOOK_READ_ONLY=1`). Single knob that
  disables every GitHub-side write across the chef stack +
  recon-stub-escalate. Designed for maintainer-replay on someone
  else's repo.

## How this doc is maintained

- New gaps surface → either filed as an issue immediately (HIGH /
  near-term) or queued in the table above (MEDIUM / LOW / not yet
  pressing).
- Shipped items move from "Tracked" / "Queued" to "Shipped" with
  the date + commit reference.
- Once a year (or when significantly stale), review the queued list
  and either file or remove.

The point of the doc is to give a contributor browsing the repo the
aerial view of ops-maturity intent. Individual issues do the
discussion + actionability work; this doc does the index +
priority-context work.
