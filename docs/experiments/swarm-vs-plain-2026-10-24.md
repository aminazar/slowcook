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

### The set (Amin, 2026-10-24): nine stories, seed 1 first, seed 2 where the arms disagree

| story | issue | base (pre-brew) | notes |
|---|---|---|---|
| 016 pinned rewos strip | #138 | f3183118 | brew $2.80; shipped without migration (human added). Issue #138 is the PARENT of the 016/017 split: the plain arm gets the whole issue |
| 017 pin affordance | #138 | e3d45359 | brew $5.18 broke two shipped contracts; base already holds 016's implementation; plain arm gets #138 again |
| 019 crawler dedupe | #215 | b32b31b2 | brew 1 iteration $1.04 after a $6.24 halt; pgTAP, merge_rewos rpc |
| 020 taxonomy categories | #216 | ae62dd5a | brew $1.53; tests had mocked the wrong module (hand-repaired after) |
| 021 publisher + byline | #217 | 7eea0d66 | brew $4.26; RLS + migration repaired against amended spec |
| 022 ration pill bands | #277 | c8d26bdf | haiku brew, human-gate repaired; declared presentational/server split |
| 024 feed timestamps | #292 | d37f914e | the smoke story; contract pinned RewoCard, live page was FeedPage |
| 025 invite status | #293 | b5f2ec59 | brew partial $0.21 13/30, then human amendments |
| 026 feed API reaction state | #317 | 072fbb99 (origin/main) | spec #320 + tests #321 merged, NO brew yet: the cleanest case |

Budget $5 per run (the shipped brews ranged $0.82–$5.18; on subscription auth the list price bounds time, not dollars). Brew arms: `pipeline` pins sonnet-5-5, `swarm` pins haiku-5-5 with the fable-5-1 navigator (now on the LlmClient seam). Plain oracle: `--oracle-suites backend`.

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

Decision after the smoke: none — a smoke run is not a sample. The navigator seam was fixed (#573, #574, #575), the pipeline arm pinned, the box CLI updated (fable-5-1 needs Claude Code ≥ 2.1.251), and the set ran.

### Set `set-1` — nine stories, seed 1, $5 budget, 2026-10-24 14:02–17:51 CEST

Arms: `plain` = sonnet-5-5 on the issue text only (oracle: backend suite); `pipeline` = brew with sonnet-5-5; `swarm` = brew with haiku-5-5 under a fable-5-1 navigator ($0.50/iteration cap). Prices are list prices; the box runs on subscription auth.

| story | arm | cost $ | green/total | verdict | selector-only | behavioural | new reds | tsc | wall min | iters | halt |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 016 | pipeline | 0.46 | 27/27 | all-green | 0 | 0 | 0 | 0 | 10.9 | 3 | SUCCESS |
| 016 | plain | 0.42 | 16/27 (1 not run) | partial | 2 | 8 | 0 | 3 | 4.2 | 16 | done |
| 016 | swarm | 1.10 | 27/27 | all-green | 0 | 0 | 0 | 0 | 15.9 | 5 | SUCCESS |
| 017 | pipeline | 0.67 | 18/24 | partial | 0 | 6 | 0 | 0 | 9.5 | 5 | STALLED |
| 017 | plain | 0.26 | 11/24 | partial | 0 | 13 | 0 | 3 | 3.3 | 14 | done |
| 017 | swarm | 0.25 | 17/24 | partial | 1 | 6 | 0 | 1 | 5.6 | 3 | STALLED |
| 019 | pipeline | 0.22 | 20/20 | all-green | 0 | 0 | 0 | 0 | 6.4 | 1 | SUCCESS |
| 019 | plain | 0.24 | 19/20 (1 not run) | partial | 0 | 0 | 0 | 0 | 2.9 | 14 | done |
| 019 | swarm | 0.42 | 20/20 | all-green | 0 | 0 | 1* | 0 | 9.4 | 2 | SUCCESS |
| 020 | pipeline | 0.43 | 21/21 | all-green | 0 | 0 | 0 | 0 | 11.1 | 3 | SUCCESS |
| 020 | plain | 0.19 | 16/21 | partial | 0 | 5 | 1 | 0 | 2.8 | 12 | done |
| 020 | swarm | 1.50 | 21/21 | all-green | 0 | 0 | 0 | 0 | 25.8 | 9 | SUCCESS |
| 021 | pipeline | ? | 6/30 (1 not run) | partial | 0 | 23 | 0 | 0 | 2.9 | 0 | MANIFEST_DRIFT |
| 021 | plain | 0.27 | 19/30 (1 not run) | partial | 0 | 10 | 0 | 0 | 3.4 | 12 | done |
| 021 | swarm | ? | 6/30 (1 not run) | partial | 0 | 23 | 0 | 0 | 2.0 | 0 | MANIFEST_DRIFT |
| 022 | pipeline | 0.27 | 20/20 | all-green | 0 | 0 | 0 | 1 | 9.5 | 2 | TRANSITIVE_REGRESSION |
| 022 | plain | 0.19 | 16/20 | partial | 0 | 4 | 0 | 0 | 3.3 | 16 | done |
| 022 | swarm | 0.26 | 18/20 | partial | 0 | 2 | 1 | 1 | 6.6 | 3 | STALLED |
| 024 | pipeline | 0.53 | 25/25 | all-green | 0 | 0 | 0 | 0 | 12.5 | 3 | SUCCESS |
| 024 | plain | 0.17 | 13/25 | partial | 8 | 4 | 0 | 0 | 3.2 | 15 | done |
| 024 | swarm | 1.30 | 25/25 | all-green | 0 | 0 | 0 | 0 | 19.5 | 6 | SUCCESS |
| 025 | pipeline | 0.67 | 28/30 | partial | 0 | 2 | 0 | 0 | 15.5 | 6 | STALLED |
| 025 | plain | 0.13 | 14/30 | partial | 6 | 10 | 1 | 0 | 3.4 | 16 | done |
| 025 | swarm | 0.79 | 22/30 | partial | 0 | 8 | 1* | 0 | 16.6 | 6 | STALLED |
| 026 | pipeline | 0.23 | 10/10 | all-green | 0 | 0 | 0 | 0 | 7.5 | 1 | SUCCESS |
| 026 | plain | 0.12 | 2/10 | partial | 0 | 8 | 0 | 0 | 2.9 | 10 | done |
| 026 | swarm | 0.62 | 10/10 | all-green | 0 | 0 | 1* | 0 | 10.9 | 3 | SUCCESS |

`*` the "new red" is `tests/integration/story-009-ui.test.tsx`, the pre-existing order-dependent flake already on record (rewo #230), not a regression of the arm. Story-021 is a harness case at its base: the manifest lists a test the runner cannot discover, so both brew arms halted `MANIFEST_DRIFT` before spending; excluded from the arm comparison below.

**Totals, eight comparable stories (021 excluded):**

| arm | cost $ | story tests green | stories all-green | selector-only reds | behavioural reds | wall min |
|---|---|---|---|---|---|---|
| plain (sonnet-5-5, issue only) | 1.73 | 107/177 | 0/8 | 16 | 52 | 26 |
| pipeline (sonnet-5-5 brew) | 3.48 | 169/177 | 6/8 | 0 | 8 | 83 |
| swarm (haiku-5-5 + fable navigator) | 6.24 | 160/177 | 5/8 | 1 | 16 | 110 |

Of the swarm's $6.24, **$6.01 is the navigator and $0.24 the haiku brew**: haiku's implementation spend was 14× below sonnet's for 160 vs 169 green tests. The navigator approved every one of its 68 reviews (zero blocks); on this set it bought no steering.

**What the halts were.** Every brew halt that was not harness was `AGENT_STALLED_NO_EDITS`, and every stall rationale names a contract the model could not honestly satisfy: 017 (both arms) "the target test and an existing test require opposite results from identical setups" — the known 016/017 spec contradiction; 022 swarm "the component has 3 className attributes, the test requires 4"; 025 pipeline "the mock helper never records the select strings the test reads"; 025 swarm "the test expects an ASCII apostrophe, React escapes it". Sonnet stalled on 017 and 025 too; haiku alone stalled on 022. The classifier's drafts (`wrong-file` for sonnet's stalls, `reasoning` for haiku's) are wrong in the same way: a stall with that rationale is a **contract defect** — the #548 lesson, the agent blaming the test was right — and belongs under `harness`, not knowledge or reasoning. Human confirmation pending.

**Reading, for the decision rule.** On eight stories and one seed, haiku's only own failure (022) was a test that pins an implementation detail, not missing knowledge of files, signatures or clarifications: zero `knowledge/*` classes survive the rationale check. The plain arm never reached the contract (0/8 all-green) but was 2× cheaper and 3× faster than the pipeline, and its behavioural-red count (52) is the honest size of what the spec + tests + manifest buy. One seed; seed 2 on the stories where the brew arms disagreed (017, 022, 025) is the agreed next step before anything is concluded.
