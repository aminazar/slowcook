import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, LlmRequest, LlmResponse, LlmUsage } from "@slowcook-ai/core";
import { costUsdForUsage } from "./pricing.js";

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
    const base = {
      model: args.model,
      max_tokens: args.maxTokens ?? 4096,
      system: systemContent as never,
      messages: args.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };
    const response = await this.client.messages.create(
      args.temperature !== undefined
        ? { ...base, temperature: args.temperature }
        : base
    );

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
    };
  }
}
