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

    const response = await this.client.messages.create({
      model: args.model,
      max_tokens: args.maxTokens ?? 4096,
      temperature: args.temperature ?? 0.2,
      system: systemContent as never,
      messages: args.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    const first = response.content[0];
    if (first && first.type === "text") return first.text;
    throw new Error(
      `Expected a text response from Claude, got: ${JSON.stringify(response.content).slice(0, 200)}`
    );
  }
}
