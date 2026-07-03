/**
 * LLM adapter surface — thin shim in the CLI since 0.8. The interface
 * lives in `@slowcook-ai/core`; the Anthropic implementation + pricing
 * helpers live in `@slowcook-ai/llm-anthropic`. Existing import paths
 * (`from "../refine/llm.js"`) keep working through this re-export, so the
 * refactor is invisible at every consumer call site.
 *
 * See `docs/plans/0.8-llm-adapter-refactor.md`.
 */
export type {
  LlmClient,
  LlmMessage,
  LlmRequest,
  LlmResponse,
  LlmUsage,
} from "@slowcook-ai/core";

export {
  AnthropicClient,
  ClaudeCliClient,
  createLlmClient,
  costUsdForUsage,
  costMarker,
  parseCostMarkers,
  PRICING_PER_M_TOKENS,
  type ParsedCostMarker,
} from "@slowcook-ai/llm-anthropic";
