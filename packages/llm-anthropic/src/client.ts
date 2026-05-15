import Anthropic from "@anthropic-ai/sdk";
import type {
  LlmClient,
  LlmRequest,
  LlmResponse,
  LlmUsage,
  LlmRateLimits,
} from "@slowcook-ai/core";
import { costUsdForUsage } from "./pricing.js";

/**
 * 0.19.0-α.31 (sc#69) — extract Anthropic rate-limit headers from a
 * Response. Headers documented at
 * https://docs.anthropic.com/en/api/rate-limits. Returns undefined
 * fields when headers are absent (older SDK / non-standard fixture).
 */
/**
 * Header bag from any fetch-like response. Both node-fetch and undici-types
 * implement `.get(name) → string | null`; we duck-type rather than pin to
 * either flavor (the Anthropic SDK has used different bundles over its
 * release history; staying loose here avoids TS type-collision flakes).
 */
interface HeaderBag {
  get(name: string): string | null;
}

function extractRateLimits(
  headers: HeaderBag | undefined
): LlmRateLimits | undefined {
  if (!headers || typeof headers.get !== "function") return undefined;
  const t = headers.get("anthropic-ratelimit-tokens-remaining");
  const r = headers.get("anthropic-ratelimit-requests-remaining");
  const tReset = headers.get("anthropic-ratelimit-tokens-reset");
  const rReset = headers.get("anthropic-ratelimit-requests-reset");
  if (t === null && r === null && tReset === null && rReset === null) return undefined;
  const out: LlmRateLimits = {};
  if (t !== null) out.tokensRemaining = parseInt(t, 10);
  if (r !== null) out.requestsRemaining = parseInt(r, 10);
  if (tReset !== null) out.tokensResetAt = tReset;
  if (rReset !== null) out.requestsResetAt = rReset;
  return out;
}

/**
 * Anthropic (Claude) adapter implementing the `LlmClient` contract from
 * `@slowcook-ai/core`. Used by slowcook's agents (refine, testgen) for
 * simple text-completion. Brew uses `@anthropic-ai/sdk` directly for its
 * tool-use surface — that's not yet generalised behind the `LlmClient`
 * interface (see `docs/plans/0.8-llm-adapter-refactor.md` §5).
 */
export class AnthropicClient implements LlmClient {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(args: LlmRequest): Promise<LlmResponse> {
    const systemContent = args.cacheSystem
      ? [
          {
            type: "text" as const,
            text: args.system,
            cache_control: { type: "ephemeral" as const },
          },
        ]
      : args.system;

    // Newer Claude reasoning-enabled models (Opus 4.7, Sonnet 4.5+) reject
    // `temperature` with a 400. Only include it if the caller explicitly
    // passed one; otherwise let the model use its own default.
    //
    // Content can be a plain string (text-only shorthand) or an array of
    // content blocks (text + image). The SDK accepts both shapes directly.
    const base = {
      model: args.model,
      max_tokens: args.maxTokens ?? 4096,
      system: systemContent as never,
      messages: args.messages.map((m) => ({
        role: m.role,
        content: m.content as never,
      })),
    };
    // 0.19.0-α.31 (sc#69) — use withResponse() so we can read the raw
    // Response object and pull `anthropic-ratelimit-*` headers. The
    // .data field is the same Message object the older call returned;
    // the .response field is the underlying fetch Response.
    const result = await this.client.messages
      .create(
        args.temperature !== undefined
          ? { ...base, temperature: args.temperature }
          : base
      )
      .withResponse();
    const response = result.data;
    const rateLimits = extractRateLimits(result.response.headers);

    const first = response.content[0];
    if (!first || first.type !== "text") {
      throw new Error(
        `Expected a text response from Claude, got: ${JSON.stringify(response.content).slice(0, 200)}`
      );
    }

    // Normalize usage. Anthropic's SDK may add new fields over time; read via
    // loose cast so newer cache shapes don't break older SDKs.
    const raw = response.usage as
      | {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        }
      | undefined;
    const usage: LlmUsage = {
      inputTokens: raw?.input_tokens ?? 0,
      outputTokens: raw?.output_tokens ?? 0,
      cacheReadTokens: raw?.cache_read_input_tokens ?? 0,
      cacheCreateTokens: raw?.cache_creation_input_tokens ?? 0,
    };
    return {
      text: first.text,
      usage,
      costUsd: costUsdForUsage(args.model, usage),
      model: args.model,
      rateLimits,
    };
  }
}
