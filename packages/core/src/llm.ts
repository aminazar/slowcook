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
