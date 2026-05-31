# Slowcook cost-marker format

Slowcook agents emit a machine-readable cost marker as an HTML comment in every PM-facing GitHub comment they post. Downstream tooling (slowcook's cost aggregator, third-party dashboards, the in-comment "Story total" footer) parses these markers to track LLM spend per agent, per round, per story.

This doc is the format reference. Source of truth lives at `packages/llm-anthropic/src/pricing.ts` (`costMarker` emitter + `parseCostMarkers` parser).

## Format

```
<!-- slowcook:cost agent=<name> usd=<dollar-amount> [optional fields] -->
```

The marker is one line, HTML-comment-wrapped so it's invisible in rendered Markdown but trivially `grep`-able. The `slowcook:cost` namespace prefix lets parsers ignore unrelated HTML comments.

## Fields

| Key | Required | Type | Notes |
|---|---|---|---|
| `agent` | yes | string | One of `refine`, `testgen`, `brew`, `vibe`, `chef`, `plate`, `recon`, `navigator`, … — the role that emitted this round. |
| `usd` | yes | decimal | This round's cost in USD, 4 decimal places (`0.0234`). |
| `tokens_in` | no | integer | Input tokens consumed. |
| `tokens_out` | no | integer | Output tokens produced. |
| `cache_read` | no | integer | Cache-hit tokens read (Anthropic prompt-cache). |
| `cache_create` | no | integer | Cache-write tokens (charged at 25% premium). |
| `model` | no | string | Model id (e.g. `claude-sonnet-4-6`, `claude-opus-4-7`). |
| `round` | no | int or string | Round label — for brew that's the iteration number; for refine it's `spec` / `multifurcation` / `relationship` / `side-effects-audit`. |

Field order is canonical (left to right). Parsers are robust to alternate order, but emitters should produce in the order above for diff-friendliness across slowcook versions.

## Examples

Minimal — just the required fields:

```
<!-- slowcook:cost agent=refine usd=0.0234 -->
```

Typical refine emission (per-round on the multifurcation pass):

```
<!-- slowcook:cost agent=refine usd=0.0123 tokens_in=4500 tokens_out=180 cache_read=120000 cache_create=4500 model=claude-sonnet-4-6 round=multifurcation -->
```

Brew iteration 7:

```
<!-- slowcook:cost agent=brew usd=0.0892 tokens_in=12000 tokens_out=1500 cache_read=85000 cache_create=12000 model=claude-opus-4-7 round=7 -->
```

## How the marker is consumed

1. **Per-comment visible footer**: `formatCostFooter()` reads PRIOR markers on the same issue/PR and renders a human-readable line:

   ```
   ---
   <sub>💰 **This step:** $0.0892 · **Story total:** $0.42 (5 agent calls so far)</sub>
   ```

2. **Per-story cost-sidecar**: slowcook persists a sibling JSONL at `specs/story-<N>.cost.jsonl` via `appendCostEntry` for canonical accounting. The HTML marker is the wire format; the JSONL is the durable record.

3. **Workflow rollup**: `slowcook-brew-merged` aggregates markers across all bot comments on the merged PR + sub-PRs and posts a final rollup ("story X cost $Y over Z rounds").

## Constraints + conventions

- **One marker per comment by convention** — `parseCostMarkers` is robust to multiples in a single body but emitters should stick to one. Multi-marker comments confuse the visible footer's "story total" math (it walks comments, not markers within them).
- **Marker BEFORE the cost footer in the rendered body** — the visible `<sub>💰 …</sub>` line at the end of the comment, the invisible marker anywhere above. By convention the marker goes at the very top of the comment so it survives partial-truncate of long bodies.
- **Don't duplicate the marker across bot turns** — `stripModelEmittedDuplicates()` in `refine/agent.ts` strips marker text that the LLM copies from prior-turn context. If you're hand-building a comment programmatically, append exactly one marker yourself.
- **`usd` must be a number, not a string.** `parseFloat(kv.usd)` is the parser's contract.
- **Field values cannot contain spaces** (the parser splits on `\s+`). Numbers + identifiers only.

## Adding a new agent type

If you ship a new agent (e.g. `navigator-v2`):

1. Bump `costMarker`'s `agent` union in `packages/llm-anthropic/src/pricing.ts` to include the new value.
2. Add an entry to the workflow rollup template if the agent gets its own line.
3. The parser doesn't need updating — `agent` is parsed as a free string.

## See also

- `packages/llm-anthropic/src/pricing.ts` — emitter + parser source
- `packages/llm-anthropic/src/pricing.test.ts` — format regression tests
- `packages/cli/src/cost-store.ts` — JSONL sidecar persistence
- `packages/cli/src/commands/refine/agent.ts` — example emission site (look for `costMarker(...)`)
