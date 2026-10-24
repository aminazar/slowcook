# Swarm vs plain — protocol (2026-10-24)

**Question.** Does a slowcook swarm of cheap implementers (haiku brew) under a
capable navigator/refiner (fable) beat plain Claude Code on cost, coverage and
speed — and when the cheap model fails, is it missing *knowledge* it could
have been handed, or *reasoning*?

**Rulings in force (2026-10-23, reaffirmed 2026-10-24).** Measure first. No
slowcook-owned cell store; if knowledge failures dominate, the substrate is
the Datumesh local resolver (phase 2, their step 1.8a), consumed over CLI or
wasm. The three Datumesh experiments (memo-hit vs recompute cost, swarm reuse,
failure attribution) are phase 2 and gated on this run.

## Arms

| arm | what runs | models | sees |
|---|---|---|---|
| `plain` | `claude -p` headless, native tools, no MCP, no slowcook | sonnet 5.5 (`arms.json` may change it) | the GitHub issue text ONLY. Spec, manifest and the story's tests are removed from its tree and committed away before it starts |
| `pipeline` | `slowcook brew` as shipped, `SLOWCOOK_LLM=claude-cli` | stage defaults | spec slice (now with clarifications, WP2), manifest tests, code map, history index |
| `swarm` | the same brew, `SLOWCOOK_MODEL_BREW=claude-haiku-5-5`, `--with-navigator --navigator-model claude-fable-5-1` | haiku 5.5 implements, fable 5.1 navigates | same as pipeline |

The plain arm's branch starts from the same base commit as the brew arms, so
the story's merged tests (recipe) and spec are *in history* but not in its
working tree. Budgets are equalised in USD at list price (`--budget-usd`).

Override or add arms in `.brewing/experiments/arms.json` (`slowcook experiment arms` prints the resolved set).

## Measures

Per run, the harness writes `.brewing/local/experiments/<exp>/<story>/<arm>-<seed>/`:

- `cost.jsonl` — ledger rows carrying this `run_id` (every stage writes rows since WP1; the navigator too). Unpriced rows are counted, never summed as $0. `report` reprices in memory so arms days apart share one price basis.
- `verify.json` — `slowcook verify --json` on the arm's result: story contract green/total with each red test's failure text, full-suite reds outside the story (diffed against `base.verify.json`), typecheck ratchet.
- `summary.json` / `halt.json` — brew's wall-clock, iterations, checkpoints, halt reason. `plain.json` — sessions, turns, usage, stop reason. `transcripts/` — every headless session's stream-json.

Report columns: cost $, green/total, verdict, selector-only vs behavioural reds, new full-suite reds, tsc regressions, wall min, iterations, halts, models, class.

## Known biases (stated, not hidden)

1. **The hidden oracle favours the pipeline.** The tests pin `data-testid` hooks, prop names and accessible names the plain arm could not know. `report` splits red tests whose failure text names a missing hook (`selector-only`) from the rest (`behavioural`). Read the behavioural column as the fair comparison and the selector column as the price of not having the contract.
2. **The plain arm's oracle runs in a worktree**, which cannot host the database singleton or the acceptance app, so it runs `--skip-db` and is limited to the suites that work there (`--oracle-suites`, e.g. `backend`). Expected tests from the other suites are reported as **not run**, never as green, and the base verify is measured with the same suite set (`base.verify.<suites>.json`). Stateful stories therefore under-report plain-arm coverage on the db suite; the brew arms run in the main checkout with every suite. The first smoke run (story-024) found this: with every suite requested, the worktree's acceptance and db runners broke and the old verify discarded the backend verdicts with them — verify now keeps the verdicts of the suites that ran.
3. **The brew arms replay from the merged spec + tests** (brew-only comparison). A full-chain arm (refine → recipe → brew from the issue) needs a human in the loop for clarifications and is a separate, labelled arm if run.
4. **Brew arms run with `SLOWCOOK_BREW_LOCAL=1`**: no branch push, no draft PR, no halt comment on the source issue (the stories are shipped; the product repo must not collect experiment PRs). Everything else brew does is unchanged.
5. **Prices are list prices.** Subscription auth (`claude-cli`) spends no API dollars; the comparison is what each arm *would* cost.

## Story set

Three classes × two stories × ≥2 seeds per arm, chosen from the shipped rewo
stories by re-reading their specs on the box (criteria: `docs/EVALUATING-A-BREW.md`;
spec with invariants + scenarios + api_contract or ui_behavior, tests merged,
manifest recorded, base green, typecheck baseline recorded; exclude known
cross-contract drift):

1. presentational (ui_behavior only, no migration) — cost is the headline;
2. stateful (api_contract + migration + auth gating) — where haiku plateaued in September;
3. async / cross-cutting (hot-spot overlap in `.brewing/provenance.json`) — the regression columns.

Base = the commit before each story's brew merged (`--base <sha>`), so the
implementation is absent and the tests present in history.

## Running (rewo box, worker timer OFF)

```
slowcook experiment run --story <id> --arm plain    --exp swarm-1 --seed 1 --base <sha> --budget-usd 3
slowcook experiment run --story <id> --arm pipeline --exp swarm-1 --seed 1 --base <sha> --budget-usd 3
slowcook experiment run --story <id> --arm swarm    --exp swarm-1 --seed 1 --base <sha> --budget-usd 3
slowcook experiment report --exp swarm-1 --md
slowcook experiment classify --run swarm-1/<id>/swarm/1
```

`--dry-run` prints the plan (argv, env *names*, paths) and writes nothing.
Brew arms need a clean main checkout and restore the previous branch after.
Haiku halts are re-dispatched to sonnet by hand this round and recorded as a
separate arm (`swarm-escalated`) if done.

## Classification rubric (ruling 1)

`classify` emits a DRAFT per halt from deterministic signals, with evidence,
and a human confirms (`--confirm <class> --by <name>`):

- `knowledge/re-discovery` — the same file read in ≥3 iterations, never written (from the `TOOLS` lines of `iterations.log`);
- `knowledge/wrong-file` — a checkpointed edit in a source file no story test imports;
- `knowledge/wrong-signature` — a red test's failure text names a surface the code lacks (`is not a function`, `has no exported member`, …);
- `knowledge/lost-clarification` — a PM clarification shares identifiers with a red test (moot once WP2's slice carries clarifications; kept to prove it);
- `reasoning` — none of the above, or the agent's own rationale cites logic/order/async;
- `harness` — `TEST_RUNNER_BROKEN`, `MANIFEST_DRIFT`, `TESTS_BROKEN`, `FINAL_GATE_RUNNER_BROKEN`, `API_ERROR`: not the model (#548: the agent blaming the harness was right once).

**Decision rule.** Reasoning dominates haiku's confirmed halts → a plain
sha-keyed cache for the history index and code map, and stop. Knowledge
dominates → no slowcook mesh; write the one-page cell contract against the
Datumesh spec and embed their local resolver when it exists. Either way the
GitHub comment channel stays as the human-visible mirror.

## Results

### Smoke run `smoke-1` — story-024 (issue #292), base d37f914, one seed, budget $3

Run 2026-10-24 on rewo, worker timer off. At base, 13 of the story's 25
tests are already green (the red-by-design set is 12).

| story | arm | n | cost $ | green/total | verdict | selector-only | behavioural | new reds | tsc regr | wall min | iters | halts | models |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 024 | pipeline | 1 | 0.51 | 25/25 | all-green | 0 | 0 | 1 | 1 | 11.9 | 3 | TRANSITIVE_REGRESSION | claude-haiku-4-5 |
| 024 | plain | 1 | 0.34 | 13/25 | partial | 8 | 4 | 0 | 0 | 3.8 | 18 | plain:done | claude-sonnet-5-5 |
| 024 | swarm | 1 | 0.02 | 13/25 | partial | 8 | 4 | 0 | 0 | 3.8 | 2 | AGENT_STALLED_NO_EDITS | claude-haiku-5-5 |

Price basis (list, $/M tokens): fable-5-1 10/50 · haiku-4-5 1/5 · haiku-5-5 0.1/0.5 · sonnet-5-5 2/10.
Plain-arm oracle: backend suite only (`--oracle-suites backend`), base measured the same way; brew arms: every suite.

What one seed of one story says (and does not say):

- **Pipeline** (the box pins brew to haiku-4-5, so "as-is" on rewo is a haiku brew without a navigator) turned all 25 story tests green in 3 iterations for $0.51, and halted on the full-suite gate: one true regression in story-013's feed-connections test. The classifier's draft (`wrong-file`: feed-list.tsx) was a false positive — the story's static-check test names that file by path rather than importing it; fixed in the rubric the same day. The halt itself is a real regression the gate caught, as designed.
- **Plain** (sonnet-5-5, issue text only) finished in 3.8 minutes for $0.34 and gained **zero** story tests: 8 reds are selector-only (RewoCard/FeedList text and hooks the tests pin), 4 are behavioural (the API route never gained the `reaction` object the tests read; the FeedList static check). It implemented the timestamps on `feed-page.tsx` — the surface the spec's own later amendment (rewo #311–#313) identified as the page users actually see, which the original contract (RewoCard/FeedList) had missed. One story cannot settle whether that is "plain found the real surface" or "plain ignored the contract"; it is exactly the comparison the behavioural column exists for.
- **Swarm** (haiku-5-5) read 9 files in iteration 1, made zero tool calls in iteration 2 and halted on the stall cap after $0.02. Its oracle equals base. Draft class: reasoning (the model stopped acting on correct inputs). The fable navigator never ran: it reviews only after a checkpoint, and the box has no API key — the navigator calls the Anthropic SDK directly, so on subscription auth it abstains. **The swarm arm as defined cannot run on the box until the navigator goes through the LlmClient seam.**

Harness defects the smoke found and fixed the same day (PRs #568–#570 and the classifier follow-up): brew arms must not write to GitHub; a worktree cannot run the acceptance/db suites and the old verify discarded the backend verdicts with them; brew arms left the main checkout dirty; typecheck "regressions" counted base's own debt; a never-ran arm reported $0; classifier drafts must ignore reds already red at base.

Decision: none yet — a smoke run is not a sample. Next: fix the navigator seam, pin the pipeline arm's model explicitly in `arms.json` (box env vs. stage default is a choice, not an accident), then the story set.
