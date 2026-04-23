# @slowcook-ai/llm-anthropic

Anthropic (Claude) adapter for the slowcook brewing harness. Implements the provider-agnostic `LlmClient` interface from [`@slowcook-ai/core`](https://www.npmjs.com/package/@slowcook-ai/core) and ships Anthropic-specific cost accounting.

Extracted from `@slowcook-ai/cli` in 0.8 so alternative LLM providers can plug into slowcook without the CLI depending on a specific SDK. The CLI depends on `@slowcook-ai/core` (for the interface) and this package (for the default adapter).

## Exports

- `AnthropicClient` — the `LlmClient` implementation. Constructor takes an Anthropic API key.
- `costUsdForUsage(model, usage)` — compute USD cost from normalized usage counters.
- `costMarker(fields)` — build an HTML-comment cost marker for audit-trail comments.
- `parseCostMarkers(body)` — parse markers out of a GitHub issue comment body.
- `PRICING_PER_M_TOKENS` — per-million-token prices for Claude models.

## Using a different provider

Build your own `LlmClient` implementation against the interface from `@slowcook-ai/core` and pass it in where the CLI constructs `AnthropicClient` today. Brew's tool-use code path currently uses the Anthropic SDK directly (not through this interface) — that's documented as a known temporary boundary in the 0.8 plan doc.

## License

MIT.
