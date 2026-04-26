/**
 * Re-export shim — see investigate/prompts.ts for the rationale.
 * Source of truth: `@slowcook-ai/llm-anthropic/prompts/vibe`.
 */

export {
  VIBE_SYSTEM,
  VIBE_TOOLS,
  buildVibeUserPrompt,
  type VibeUserPromptArgs,
} from "@slowcook-ai/llm-anthropic";
