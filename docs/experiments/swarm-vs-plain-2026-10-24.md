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
2. **The plain arm's oracle runs `--skip-db`** (it runs in a worktree; the local database stack is a per-directory singleton). Stateful stories therefore under-report plain-arm coverage on the db suite; the brew arms run in the main checkout with the db suite on.
3. **The brew arms replay from the merged spec + tests** (brew-only comparison). A full-chain arm (refine → recipe → brew from the issue) needs a human in the loop for clarifications and is a separate, labelled arm if run.
4. **Prices are list prices.** Subscription auth (`claude-cli`) spends no API dollars; the comparison is what each arm *would* cost.

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

_(filled after the runs: the `report --md` table per story, classifications per halt, and the decision.)_
