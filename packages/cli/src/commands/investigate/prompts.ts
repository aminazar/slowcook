/**
 * Re-export shim — the actual prompt strings + tool defs live in
 * `@slowcook-ai/llm-anthropic` as of 0.13.1 (per the llm-agnosticism
 * refactor). Kept as a passthrough so internal imports
 * (`from "./prompts.js"`) keep working without touching every agent
 * file. A future GPT / Gemini adapter package would publish drop-in
 * replacements with the same exported names.
 */

export {
  INVESTIGATE_SYSTEM,
  INVESTIGATE_TOOLS,
  buildInvestigateUserPrompt,
} from "@slowcook-ai/llm-anthropic";
