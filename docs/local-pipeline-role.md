# The local-pipeline role

> An agent (typically a Claude Code session driven by the human PM) drives the slowcook pipeline locally — emitting refine / testgen / vibe / plate / brew / chef artefacts on slowcook-shaped branches — **without** calling the slowcook CLI's LLM-dispatch commands (no `slowcook refine`, no `slowcook brew`, etc.).

This pattern emerged from the delgoosh dogfood (2026-05). The local agent has the same context the slowcook agents would have (read the spec, the goldmine, the test contract) and emits the same artefact shapes, but the LLM call is the human's IDE-bound agent rather than slowcook's worker. It exists because:

- API spend on long brews can outpace human review bandwidth.
- The PM wants to red-line each stage's emit interactively rather than block on agent feedback loops.
- Bug-fix work on slowcook itself often needs to live alongside the dogfood feature work, and the local pattern keeps both visible in one session.

The role has no formal CLI flag — it's a working pattern, not a slowcook subcommand. This doc names it so contributors can refer to it without re-deriving the conventions every time.

## When to use it

- You're driving a single story end-to-end and you want to see every stage's diff before it lands.
- You're testing a new slowcook capability against a live consumer (any of the dogfood repos work) before committing to upstream behaviour changes.
- You're working on slowcook bug fixes that need confirmation against a consumer's real spec / brew before merging.
- You're brewing on a constrained budget where the per-iteration LLM round-trip cost matters more than agent autonomy.

## When NOT to use it

- The consumer's normal slowcook-bot pipeline is healthy and the story is routine. Let the bots do it.
- Multiple stories in parallel — the local pattern is single-threaded by design.
- Stories where the test contract is genuinely uncertain and benefits from agent iteration during testgen.

## Conventions

### Branch naming

Same as slowcook-bot branches: `slowcook/<kind>/story-<N>` for testgen/brew per stage; `slowcook/<kind>/story-<N>-<ts>` for brew where the timestamp prevents collision with reruns. The reviewer should not be able to tell from the branch name whether it was the bot or the local pipeline.

Exception: small stories (`spec.estimate === 'small'`) MAY use a single combined `slowcook/brew/story-<N>-<ts>` branch per the [combined testgen+brew section](../packages/cli/src/commands/upsert-agent-docs.ts#combined-testgenbrew-for-small-stories) of the managed agent-docs block.

### PR shape

- One PR per stage by default: `tests: story-N — …`, `feat(<scope>): brew story-N — …`, etc.
- Combined `feat(<scope>): brew story-N — testgen + brew combined (small)` is acceptable for the small-story exception.
- PR body explains the WHY at the story level + flags any spec ambiguities the agent resolved with a judgment call (so reviewers know what was a contract decision vs an implementation choice).

### Self-applying lints

When you ship slowcook PRs that add validators (e.g. PR #132 `validateEntityFieldReferences`, PR #152 `validateRouteCollisions`), you MUST re-run the lints against your consumer's spec set as soon as the slowcook PR merges + version bumps. The lints exist to catch things you would have missed; if you don't re-run, you're letting drift accumulate against new gates.

Use `slowcook check spec` (PR #147) for the workflow path; for ad-hoc local checks, `slowcook check spec specs/story-006.yaml --cwd /path/to/consumer`.

### Cost logging

Even though the local pipeline doesn't invoke `slowcook brew`, the human's IDE-bound LLM session has a measurable cost. Run `slowcook cost log` (PR #142) at the end of every story to record session totals:

```bash
slowcook cost log \
  --story 006 \
  --usd "$SESSION_TOTAL_USD" \
  --agent local-claude-pipeline \
  --model claude-opus-4-7 \
  --source-url https://github.com/<consumer>/pull/<N> \
  --apply-to-spec
```

This keeps the slowcook cost-aggregator rollups complete; without it, the per-story bill underreports the actual spend.

### Feedback to slowcook itself

The local pattern surfaces slowcook gaps faster than the bot pattern because the human is in the loop on every emit. Capture these continuously in the consumer's `.brewing/SLOWCOOK-FEEDBACK.md` and batch them into a slowcook umbrella issue every 3-5 findings (per the [imperative-feedback section](../packages/cli/src/commands/upsert-agent-docs.ts#feedback-to-slowcook-itself) of the managed block).

The 5 batches shipped from the delgoosh dogfood (slowcook issues #126, #145, #146, #151, plus the unnumbered second-batch PRs) all surfaced this way.

## What NOT to do

- **Don't run `slowcook brew` from the local pipeline.** That dispatches the slowcook brew agent, which is a parallel-context LLM call you didn't authorise. The whole point of the local pattern is that the brew runs in YOUR IDE.
- **Don't open slowcook-bot PRs from the local pattern.** Bots are identified by the `slowcook-*[bot]` GitHub identity. Your PRs come from the human's identity. Reviewers spot the difference; conflating them undermines the bot's audit trail.
- **Don't skip the `@slowcook-stub` line-1 marker** when scaffolding stub files during local testgen. Even though no slowcook brew agent will read it, downstream local-brew sessions (yours or someone else's) rely on the marker to know what to replace.
- **Don't apply `override-freeze` to your PRs.** The label exists for emergency human bypass of the guard; local-pipeline PRs are NOT that emergency. If guard halts your PR, fix the underlying issue.

## See also

- [`slowcook cost log`](../packages/cli/src/commands/cost-log.ts) — explicit cost-logging primitive for non-bot agents
- [`slowcook check spec`](../packages/cli/src/commands/check/spec-validate.ts) — re-run spec validators on PR amendments
- Managed agent-docs block — installed into consumer repos by `slowcook upsert-agent-docs`. Section "Combined testgen+brew for small stories" and "Feedback to slowcook itself — open PRs proactively" are particularly relevant.
- [`docs/cost-marker-format.md`](./cost-marker-format.md) — wire format for cost markers in PM-facing comments

Refs: sc#145 finding 6.
