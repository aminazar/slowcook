/**
 * 0.19.0-alpha.9 — default Anthropic-backed pair-brew NavigatorHook.
 *
 * α.4 wired the structural NavigatorHook slot into brew/agent.ts.
 * α.5 added the proposedTest hard-signal field. α.9 ships the
 * default implementation: calls Anthropic with NAVIGATOR_SYSTEM +
 * buildNavigatorPrompt, parses the NavigatorVerdict, adapts it to
 * NavigatorHookVerdict (the brew-loop interface).
 *
 * Wiring path (cli α.10 will add the --with-navigator flag):
 *   ctx.navigatorHook = createPairNavigatorHook({ anthropic, model, ... });
 *
 * Persistent-block escalation (#77 / α.5): when `priorBlockCount >= 2`
 * for the same root concern, the hook MAY include a proposedTest in
 * the verdict — written to tests/navigator/ + folded into next iter's
 * red-set as a HARD signal. Logic is in the prompt; mechanics in
 * brew/agent.ts.
 */

import type { LlmClient, LlmUsage } from "@slowcook-ai/core";
import {
  NAVIGATOR_SYSTEM,
  buildNavigatorPrompt,
  type NavigatorVerdict,
  type NavigatorAxis,
  type NavigatorPromptArgs,
} from "@slowcook-ai/llm-anthropic";
import type { NavigatorHook, NavigatorHookInput, NavigatorHookVerdict } from "./agent.js";

/**
 * Adapt NavigatorVerdict (the prompt-side shape: axes + overall +
 * rationale) → NavigatorHookVerdict (the brew-loop shape: overall +
 * concerns + costUsd + proposedTest).
 *
 * Mapping rules:
 *   - overall "approve" → "approve"
 *   - overall "warn"    → "approve"  (warn is informational; brew
 *                         only reverts on block)
 *   - overall "block"   → "block"
 *   - concerns: each blocking axis becomes one entry "<axis>: <summary>".
 *                  Warn-severity axes are surfaced too (lower priority).
 *   - costUsd: passed through unchanged.
 *
 * Pure: no IO. Tested in isolation.
 */
export function navigatorVerdictToHookVerdict(
  verdict: NavigatorVerdict,
  costUsd: number,
): NavigatorHookVerdict {
  const overall: "approve" | "block" = verdict.overall === "block" ? "block" : "approve";
  const concerns = verdict.axes
    // Sort blocking before warn so the most important concerns surface first.
    .slice()
    .sort((a, b) => {
      if (a.severity === b.severity) return 0;
      return a.severity === "blocking" ? -1 : 1;
    })
    .map((a: NavigatorAxis) => `${a.axis}: ${a.summary}`);
  const result: NavigatorHookVerdict = { overall, concerns };
  if (costUsd > 0) {
    result.costUsd = costUsd;
  }
  // proposedTest is intentionally NOT extracted from NavigatorVerdict's
  // axes — the prompt-side shape doesn't carry one today. The hook
  // factory below allows callers to pass an `extractProposedTest`
  // function that decides whether to attach a hard-signal test based
  // on its own escalation policy (e.g., persistent-block detector).
  return result;
}

export interface PairNavigatorOptions {
  /**
   * 2026-10-24 — the LlmClient seam, not the Anthropic SDK. Every other
   * agent call runs on `createLlmClient()` (subscription auth via claude-cli
   * or the API by key); the navigator was the one call still on the SDK, so
   * on a key-less box it silently abstained on every iteration (the first
   * swarm-vs-plain smoke run: a "fable navigator" that never fired).
   */
  llm: LlmClient;
  /** Model id (e.g., "claude-sonnet-4-5-20250929"). */
  model: string;
  /** Per-iter token cap for the navigator response. */
  maxTokens?: number;
  /** Per-iter cost ceiling — when the LLM call would exceed this,
   *  the hook abstains (returns null) instead of blocking the iter. */
  perIterBudgetUsd?: number;
  /** Pricing per million tokens for cost computation (legacy exact-key
   *  shape). Superseded by `costFor` when both are given. */
  pricingPerMTokens?: { input: number; output: number };
  /** WP1 — list price through the ONE pricing table (prefix-aware,
   *  cache-aware); `null` = unpriced. Preferred over `pricingPerMTokens`. */
  costFor?: (usage: LlmUsage) => number | null;
  /**
   * WP1 — fired after EVERY API response, verdict or abstain alike, so the
   * navigator's spend reaches the ledger even when the verdict is
   * unparseable (the money was spent either way). brew/index.ts appends a
   * `navigator` cost row from it.
   */
  onCall?: (info: { iteration: number; model: string; usage: LlmUsage; costUsd: number | null }) => void;
  /**
   * Fired whenever the hook ABSTAINS and why (context load failed, the call
   * threw, over the per-iteration budget, empty or unparseable verdict). The
   * first swarm-vs-plain run had a navigator that never fired for 5
   * checkpoints and nothing said so: the model was unavailable on the box.
   */
  onAbstain?: (info: { iteration: number; phase: "context" | "call" | "budget" | "empty" | "parse"; detail: string }) => void;
  /**
   * Loader for the per-call prompt context. Brew/agent.ts doesn't
   * carry mockFiles / codeMapDigest / storyTestIds / specYaml in
   * `NavigatorHookInput` — the caller injects a loader that supplies
   * those from the brew context's filesystem + spec.
   *
   * Returning null OR an empty mockFiles array does NOT abort —
   * the prompt will still be built; navigator just sees less context.
   */
  loadPromptContext: (input: NavigatorHookInput) => Promise<{
    mockFiles: NavigatorPromptArgs["mockFiles"];
    codeMapDigest: string;
    storyTestIds: string[];
    apiContract?: NavigatorPromptArgs["apiContract"];
    crossStoryFiles?: string[];
    specYaml?: string;
    /**
     * α.55 — list of source-file paths present in the repo at the
     * time of this iteration. Navigator uses this to ground absence
     * claims (must NOT assert a path is absent unless it's missing
     * from this list AND the diff doesn't create it).
     */
    knownSourceFiles?: string[];
    priorVerdicts?: NavigatorPromptArgs["priorVerdicts"];
  } | null>;
}

/**
 * Build a NavigatorHook backed by an Anthropic LLM call. Pure
 * factory; the returned hook is ready to inject into BrewContext.
 *
 * Per-call flow:
 *   1. Caller-provided loader fills in mockFiles + codeMapDigest +
 *      storyTestIds + spec yaml + cross-story files + prior verdicts.
 *   2. buildNavigatorPrompt produces the prompt; client.messages.create
 *      runs it with NAVIGATOR_SYSTEM.
 *   3. Response text is parsed as NavigatorVerdict (JSON; fences
 *      tolerated).
 *   4. navigatorVerdictToHookVerdict adapts to the brew-loop shape.
 *   5. Cost is tallied from input/output tokens × pricing.
 *
 * On any failure (load error, JSON parse, API error), the hook
 * returns null — brew treats null as "navigator abstained" + the
 * iteration proceeds to checkpoint without navigator review.
 */
export function createPairNavigatorHook(options: PairNavigatorOptions): NavigatorHook {
  const {
    llm,
    model,
    maxTokens = 1024,
    perIterBudgetUsd = 0.10,
    pricingPerMTokens,
    costFor,
    onCall,
    onAbstain,
    loadPromptContext,
  } = options;
  const abstain = (iteration: number, phase: "context" | "call" | "budget" | "empty" | "parse", detail: string): null => {
    try { onAbstain?.({ iteration, phase, detail: detail.slice(0, 300) }); } catch { /* bookkeeping */ }
    return null;
  };
  return {
    async review(input: NavigatorHookInput): Promise<NavigatorHookVerdict | null> {
      let context;
      try {
        context = await loadPromptContext(input);
      } catch (e) {
        return abstain(input.iteration, "context", (e as Error).message);
      }
      if (!context) return abstain(input.iteration, "context", "loader returned null");

      // Build a compact diff string from filesTouched + line counts.
      // The full git diff isn't always available at call time; this
      // summary is enough for navigator to reason about scope without
      // overflowing the prompt.
      const diff = `Files touched: ${input.filesTouched.join(", ")}\nLines: +${input.linesAdded} / -${input.linesRemoved}`;

      const promptArgs: NavigatorPromptArgs = {
        storyId: input.storyId,
        driverRationale: input.rationale,
        diff,
        mockFiles: context.mockFiles ?? [],
        codeMapDigest: context.codeMapDigest ?? "",
        storyTestIds: context.storyTestIds ?? [],
        // α.55 — scope concerns to the current iteration's target.
        targetTestId: input.targetTestId,
        apiContract: context.apiContract,
        crossStoryFiles: context.crossStoryFiles,
        specYaml: context.specYaml,
        // α.55 — let navigator presence-check files it might claim absent.
        knownSourceFiles: context.knownSourceFiles,
        priorVerdicts: context.priorVerdicts,
      };
      const prompt = buildNavigatorPrompt(promptArgs);

      let response;
      try {
        response = await llm.complete({
          model,
          system: NAVIGATOR_SYSTEM,
          maxTokens,
          messages: [{ role: "user", content: prompt }],
        });
      } catch (e) {
        return abstain(input.iteration, "call", (e as Error).message);
      }

      const usage: LlmUsage = response.usage;
      const priced: number | null = costFor
        ? costFor(usage)
        : pricingPerMTokens
          ? (usage.inputTokens * pricingPerMTokens.input) / 1_000_000 +
            (usage.outputTokens * pricingPerMTokens.output) / 1_000_000
          : null;
      try { onCall?.({ iteration: input.iteration, model, usage, costUsd: priced }); } catch { /* bookkeeping */ }
      // Budget arithmetic keeps a number; the ledger (onCall) keeps the null.
      const costUsd = priced ?? 0;

      if (costUsd > perIterBudgetUsd) {
        // Over-budget — surface as abstain so brew doesn't pay the
        // full ticket on a runaway response.
        return abstain(input.iteration, "budget", `$${costUsd.toFixed(3)} > per-iteration cap $${perIterBudgetUsd.toFixed(2)}`);
      }

      const text = response.text;
      if (!text) return abstain(input.iteration, "empty", "no text in the response");

      let verdict: NavigatorVerdict;
      try {
        verdict = parseNavigatorVerdict(text);
      } catch (e) {
        return abstain(input.iteration, "parse", (e as Error).message);
      }

      return navigatorVerdictToHookVerdict(verdict, costUsd);
    },
  };
}

/**
 * Pull the text out of an Anthropic Messages API response. Kept for
 * callers that still hold a raw SDK response; the hook itself reads
 * `LlmResponse.text`. Pure: no IO.
 */
export function extractTextFromResponse(response: { content: Array<{ type: string; text?: string }> }): string {
  if (!Array.isArray(response.content)) return "";
  const parts: string[] = [];
  for (const block of response.content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n");
}

/**
 * Parse a NavigatorVerdict from raw LLM text. Tolerates ```json
 * fences + leading/trailing prose. Throws on malformed JSON or
 * shape mismatch — caller should catch + treat as abstain.
 *
 * Pure: validates shape; doesn't normalize/repair.
 */
export function parseNavigatorVerdict(text: string): NavigatorVerdict {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1]!.trim() : trimmed;
  const parsed = JSON.parse(raw) as Partial<NavigatorVerdict>;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("verdict is not an object");
  }
  if (!Array.isArray(parsed.axes)) {
    throw new Error("verdict.axes must be an array");
  }
  if (parsed.overall !== "approve" && parsed.overall !== "warn" && parsed.overall !== "block") {
    throw new Error(`verdict.overall must be approve|warn|block (got ${parsed.overall})`);
  }
  if (typeof parsed.rationale !== "string") {
    throw new Error("verdict.rationale must be a string");
  }
  return parsed as NavigatorVerdict;
}
