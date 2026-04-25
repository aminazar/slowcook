/**
 * Re-export shim — see investigate/prompts.ts for the rationale.
 * Source of truth: `@slowcook-ai/llm-anthropic/prompts/sift`.
 */

export {
  SIFT_SYSTEM,
  SIFT_TOOLS,
  buildSiftTurnPrompt,
  type SiftTurnPromptArgs,
} from "@slowcook-ai/llm-anthropic";
