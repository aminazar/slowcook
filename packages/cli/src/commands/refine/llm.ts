import Anthropic from "@anthropic-ai/sdk";

/**
 * Minimal LLM interface the refinement / testgen / brew agents use.
 * Isolated so we can inject a fake in tests without touching the network,
 * and so 0.8's `LlmAdapter` refactor has a surface to extract cleanly.
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
   * itself — 0.8's `LlmAdapter` contract preserves this boundary. */
  costUsd: number;
  model: string;
}

/**
 * Per-million-token prices for Claude models. Source of truth for Anthropic
 * cost accounting; 0.8 will move this into the `@slowcook-ai/llm-anthropic`
 * package alongside the adapter. Today it lives here because that's where
 * the Anthropic SDK import lives.
 */
const PRICING_PER_M_TOKENS: Record<string, { input: number; output: number }> = {
  "claude-opus-4-7": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 0.8, output: 4 },
};

function matchPricing(model: string): { input: number; output: number } | null {
  if (PRICING_PER_M_TOKENS[model]) return PRICING_PER_M_TOKENS[model];
  for (const key of Object.keys(PRICING_PER_M_TOKENS)) {
    if (model.startsWith(key)) return PRICING_PER_M_TOKENS[key]!;
  }
  return null;
}

/**
 * Compute USD cost from normalized usage counters + a model id.
 * Anthropic's API reports `input_tokens` as new-input-only (cache tokens
 * are separate counters, not subsets). Cache reads bill at ~10% of input;
 * cache writes at ~125%.
 */
export function costUsdForUsage(model: string, usage: LlmUsage): number {
  const pricing = matchPricing(model);
  if (!pricing) return 0;
  const effectiveInput =
    usage.inputTokens +
    usage.cacheReadTokens * 0.1 +
    usage.cacheCreateTokens * 1.25;
  return (
    (effectiveInput / 1_000_000) * pricing.input +
    (usage.outputTokens / 1_000_000) * pricing.output
  );
}

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

/**
 * Build an HTML-comment cost marker for embedding in audit-trail comments
 * (source-issue comments from refine / testgen / brew). Hidden from
 * human-rendered markdown but machine-parseable by `on-brew-merged`'s
 * pipeline-total aggregator.
 *
 * Format: `<!-- slowcook:cost k1=v1 k2=v2 ... -->`
 *
 * Chosen over a persisted .brewing/costs/*.jsonl file because (a) no extra
 * git commits, (b) the comment trail is already the audit log, (c) the
 * aggregator just walks issue comments via the GitHub API.
 */
export function costMarker(fields: {
  agent: "refine" | "testgen" | "brew";
  usd: number;
  tokensIn?: number;
  tokensOut?: number;
  cacheRead?: number;
  cacheCreate?: number;
  model?: string;
  round?: number | string;
}): string {
  const parts: string[] = [`agent=${fields.agent}`, `usd=${fields.usd.toFixed(4)}`];
  if (fields.tokensIn !== undefined) parts.push(`tokens_in=${fields.tokensIn}`);
  if (fields.tokensOut !== undefined) parts.push(`tokens_out=${fields.tokensOut}`);
  if (fields.cacheRead !== undefined) parts.push(`cache_read=${fields.cacheRead}`);
  if (fields.cacheCreate !== undefined) parts.push(`cache_create=${fields.cacheCreate}`);
  if (fields.model) parts.push(`model=${fields.model}`);
  if (fields.round !== undefined) parts.push(`round=${fields.round}`);
  return `<!-- slowcook:cost ${parts.join(" ")} -->`;
}

/**
 * Parse one or more cost markers out of a text blob (typically a GitHub
 * issue comment body). Returns a flat list — a single comment can contain
 * at most one marker by convention, but the parser is robust to multiple.
 */
export interface ParsedCostMarker {
  agent: string;
  usd: number;
  tokensIn?: number;
  tokensOut?: number;
  cacheRead?: number;
  cacheCreate?: number;
  model?: string;
  round?: string;
}

export function parseCostMarkers(body: string): ParsedCostMarker[] {
  const out: ParsedCostMarker[] = [];
  const re = /<!--\s*slowcook:cost\s+([^>]+?)\s*-->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const kv: Record<string, string> = {};
    for (const pair of (m[1] ?? "").split(/\s+/)) {
      const eq = pair.indexOf("=");
      if (eq > 0) kv[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    if (kv.agent && kv.usd !== undefined) {
      const parsed: ParsedCostMarker = {
        agent: kv.agent,
        usd: parseFloat(kv.usd),
      };
      if (kv.tokens_in !== undefined) parsed.tokensIn = parseInt(kv.tokens_in, 10);
      if (kv.tokens_out !== undefined) parsed.tokensOut = parseInt(kv.tokens_out, 10);
      if (kv.cache_read !== undefined) parsed.cacheRead = parseInt(kv.cache_read, 10);
      if (kv.cache_create !== undefined) parsed.cacheCreate = parseInt(kv.cache_create, 10);
      if (kv.model !== undefined) parsed.model = kv.model;
      if (kv.round !== undefined) parsed.round = kv.round;
      out.push(parsed);
    }
  }
  return out;
}
