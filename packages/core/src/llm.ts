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

/** A single piece of user-visible content in a message. String `content` on
 * `LlmMessage` remains supported as a shorthand for a single text block. */
export type LlmContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
        data: string;
      };
    };

export interface LlmMessage {
  role: "user" | "assistant";
  content: string | LlmContentBlock[];
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
  /**
   * Stream the response and assemble the final message. Required for large
   * outputs: the SDK refuses a non-streaming request whose `maxTokens` could
   * take >10 min. Rate-limit headers are not captured when streaming.
   */
  stream?: boolean;
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
  /** Why generation stopped ("end_turn", "max_tokens", …). "max_tokens"
   * means the text is TRUNCATED — artifact writers must treat it as a
   * failed emission, never persist it (ledger G14: a schema-valid but
   * mid-line-cut spec was pushed). Optional; adapters that cannot know
   * leave it undefined, which callers treat as complete. */
  stopReason?: string;
  /** Adapter-computed cost for this call. CLI never does price arithmetic
   * itself — the adapter contract preserves this boundary. */
  costUsd: number;
  model: string;
  /** 0.19.0-α.31 (sc#69) — provider-side rate-limit signal captured from
   * response headers. Optional; adapters that don't expose headers leave
   * it undefined. CLI renders a "rate limit tight" hint in cost footers
   * when remaining drops below a threshold. */
  rateLimits?: LlmRateLimits;
}

export interface LlmRateLimits {
  /** Tokens remaining in the current per-minute / per-day window. */
  tokensRemaining?: number;
  /** Requests remaining in the current per-minute window. */
  requestsRemaining?: number;
  /** ISO-8601 UTC when the tokens-remaining window resets. */
  tokensResetAt?: string;
  /** ISO-8601 UTC when the requests-remaining window resets. */
  requestsResetAt?: string;
}

/**
 * 0.19.0-α.32 (sc#68) — typed error thrown by LlmClient adapters when
 * the upstream provider signals that account credit is exhausted (e.g.,
 * Anthropic 402 Payment Required). Agents catch this specifically to
 * post a PM-friendly "out of credit" comment + add the
 * `slowcook-out-of-credit` repo label, which gates other agent workflows
 * until the consumer tops up.
 *
 * Untyped errors / 5xx / network failures stay as-is — only this
 * specific class signals "stop burning CI minutes; you need money."
 */
export class LlmCreditExhaustedError extends Error {
  public readonly provider: string;
  public readonly status: number;
  /** Provider-specific top-up URL (e.g., https://console.anthropic.com/...). */
  public readonly topUpUrl: string;

  constructor(args: { provider: string; status: number; topUpUrl: string; message?: string }) {
    super(args.message ?? `${args.provider} account credit exhausted (status ${args.status}). Top up at ${args.topUpUrl}.`);
    this.name = "LlmCreditExhaustedError";
    this.provider = args.provider;
    this.status = args.status;
    this.topUpUrl = args.topUpUrl;
  }
}
