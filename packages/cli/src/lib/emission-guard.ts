/**
 * Emission guard (eleven-defects D1, after ledger G14): an LLM response
 * that stopped for "max_tokens" is TRUNCATED — schema validation cannot
 * catch it (a mid-list cut can still parse and validate), but the stop
 * reason is deterministic. Artifact writers call this before persisting
 * anything derived from the response.
 *
 * Returns null when the emission is complete, or a human-readable error
 * the caller must treat as a failed emission (revert / post as feedback /
 * exit non-zero — matching its own failure conventions). An undefined
 * stopReason is treated as complete: adapters that cannot know must not
 * spuriously fail every run.
 */

import type { LlmResponse } from "@slowcook-ai/core";

export function truncatedEmissionError(
  response: Pick<LlmResponse, "stopReason" | "usage">,
  what: string
): string | null {
  if (response.stopReason !== "max_tokens") return null;
  return (
    `${what}: the model's output was TRUNCATED at the token limit ` +
    `(${response.usage.outputTokens} output tokens, stop_reason=max_tokens). ` +
    `Refusing to persist a cut artifact — raise maxTokens or reduce scope.`
  );
}
