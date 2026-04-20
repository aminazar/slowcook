import Anthropic from "@anthropic-ai/sdk";

/**
 * Minimal LLM interface the refinement agent uses. Isolated so we can inject
 * a fake in tests without touching the network.
 */
export interface LlmClient {
  complete(args: LlmRequest): Promise<string>;
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

export class AnthropicClient implements LlmClient {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(args: LlmRequest): Promise<string> {
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
    if (first && first.type === "text") return first.text;
    throw new Error(
      `Expected a text response from Claude, got: ${JSON.stringify(response.content).slice(0, 200)}`
    );
  }
}
