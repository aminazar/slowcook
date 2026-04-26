/**
 * Re-export shim — see investigate/prompts.ts for the rationale.
 * Source of truth: `@slowcook-ai/llm-anthropic/prompts/plate`.
 */

export {
  PLATE_AMENDMENT_SYSTEM,
  PLATE_TOOLS,
  buildPlateAmendmentPrompt,
  type PlateAmendmentPromptArgs,
  type PlateFeedback,
  type PlateImageAttachment,
  type PlateImageMediaType,
} from "@slowcook-ai/llm-anthropic";
