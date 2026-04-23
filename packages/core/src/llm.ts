/**
 * Provider-agnostic LLM interface. Moved out of `@slowcook-ai/cli` in 0.8
 * so slowcook's agents can depend on the shape without dragging in a
 * specific provider's SDK. Concrete adapters live in sibling packages
 * (e.g., `@slowcook-ai/llm-anthropic`).
 *
 * A provider adapter supplies BOTH the `complete()` call AND the
 * cost-per-response arithmetic — pricing is provider-specific (Anthropic
 * bills cache reads at ~10% of new-input, cache writes at ~125%; other
 * providers have their own shapes). The core interface exposes `costUsd`
 * on the response so the CLI never does price math itself.
 */
export interface LlmClient {
  complete(args: LlmRequest): Promise<LlmResponse>;
}

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  system: string;
  /** System content will be cached if `cacheSystem` is true. */
  cacheSystem?: boolean;
  messages: LlmMessage[];
  /** Model id to use (e.g., "claude-opus-4-7"). */
  model: string;
  maxTokens?: number;
  temperature?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export interface LlmResponse {
  text: string;
  usage: LlmUsage;
  /** Adapter-computed cost for this call. CLI never does price arithmetic
   * itself — the adapter contract preserves this boundary. */
  costUsd: number;
  model: string;
}
