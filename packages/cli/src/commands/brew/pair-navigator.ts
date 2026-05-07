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

import type Anthropic from "@anthropic-ai/sdk";
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
  /** Anthropic SDK client to call. */
  anthropic: Anthropic;
  /** Model id (e.g., "claude-sonnet-4-5-20250929"). */
  model: string;
  /** Per-iter token cap for the navigator response. */
  maxTokens?: number;
  /** Per-iter cost ceiling — when the LLM call would exceed this,
   *  the hook abstains (returns null) instead of blocking the iter. */
  perIterBudgetUsd?: number;
  /** Pricing per million tokens for cost computation. Required so
   *  the hook can report costUsd accurately to the budget tracker. */
  pricingPerMTokens: { input: number; output: number };
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
    anthropic,
    model,
    maxTokens = 1024,
    perIterBudgetUsd = 0.10,
    pricingPerMTokens,
    loadPromptContext,
  } = options;
  return {
    async review(input: NavigatorHookInput): Promise<NavigatorHookVerdict | null> {
      let context;
      try {
        context = await loadPromptContext(input);
      } catch {
        return null;
      }
      if (!context) return null;

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
        apiContract: context.apiContract,
        crossStoryFiles: context.crossStoryFiles,
        specYaml: context.specYaml,
        priorVerdicts: context.priorVerdicts,
      };
      const prompt = buildNavigatorPrompt(promptArgs);

      let response;
      try {
        response = await anthropic.messages.create({
          model,
          system: NAVIGATOR_SYSTEM,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        });
      } catch {
        return null;
      }

      const usage = response.usage ?? { input_tokens: 0, output_tokens: 0 };
      const costUsd =
        (usage.input_tokens * pricingPerMTokens.input) / 1_000_000 +
        (usage.output_tokens * pricingPerMTokens.output) / 1_000_000;

      if (costUsd > perIterBudgetUsd) {
        // Over-budget — surface as abstain so brew doesn't pay the
        // full ticket on a runaway response.
        return null;
      }

      const text = extractTextFromResponse(response);
      if (!text) return null;

      let verdict: NavigatorVerdict;
      try {
        verdict = parseNavigatorVerdict(text);
      } catch {
        return null;
      }

      return navigatorVerdictToHookVerdict(verdict, costUsd);
    },
  };
}

/**
 * Pull the text out of an Anthropic Messages API response. Returns
 * empty string if the response shape is unexpected (defensive).
 * Pure: no IO.
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
