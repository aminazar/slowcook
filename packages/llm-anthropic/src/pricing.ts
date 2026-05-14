import type { LlmUsage } from "@slowcook-ai/core";

/**
 * Per-million-token prices for Claude models. Source of truth for
 * Anthropic cost accounting. Provider-specific (Anthropic bills cache
 * reads at ~10% of new-input, cache writes at ~125%); lives next to the
 * adapter that uses it rather than in a central registry.
 */
export const PRICING_PER_M_TOKENS: Record<string, { input: number; output: number }> = {
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

/**
 * Render a human-readable cost footer to append to a PM-facing comment.
 *
 * Format:
 *   ---
 *   <sub>💰 **This step:** $0.35 · **Story total:** $0.42 (2 agent calls so far)</sub>
 *
 * The footer is part of slowcook's contract that agent cost is visible
 * to the PM at every comment, not just embedded in invisible HTML
 * markers. A PM building a feature should see "this round cost me X
 * cents; the whole story so far is Y dollars" in real time.
 *
 * `thisRunUsd`: the cost of the call that produced this comment.
 * `priorMarkers`: parsed cost markers from prior bot comments on the
 *   same issue/PR (use `parseCostMarkers` over a concatenated body).
 *   Empty array for the first comment in a story.
 *
 * The visible footer renders the story-total INCLUDING `thisRunUsd`,
 * so the math always reads true even on round 1.
 */
export function formatCostFooter(
  thisRunUsd: number,
  priorMarkers: ParsedCostMarker[]
): string {
  const priorSum = priorMarkers.reduce((acc, m) => acc + m.usd, 0);
  const total = priorSum + thisRunUsd;
  const totalCalls = priorMarkers.length + 1;
  return (
    `\n\n---\n` +
    `<sub>💰 **This step:** $${thisRunUsd.toFixed(2)} · ` +
    `**Story total:** $${total.toFixed(2)} (${totalCalls} agent call${totalCalls === 1 ? "" : "s"} so far)</sub>`
  );
}
