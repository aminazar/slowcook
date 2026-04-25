export { AnthropicClient } from "./client.js";
export {
  PRICING_PER_M_TOKENS,
  costUsdForUsage,
  costMarker,
  parseCostMarkers,
  type ParsedCostMarker,
} from "./pricing.js";

// 0.9.0 — Anthropic-tuned prompts (system strings, tool defs,
// per-turn prompt builders) live here so the CLI's command modules
// stay LLM-agnostic. A future GPT / Gemini adapter package would
// own its own prompts/ subtree with the same exported names; the
// CLI swaps which adapter it imports from.
export {
  INVESTIGATE_SYSTEM,
  INVESTIGATE_TOOLS,
  buildInvestigateUserPrompt,
} from "./prompts/investigate.js";
export {
  SIFT_SYSTEM,
  SIFT_TOOLS,
  buildSiftTurnPrompt,
  type SiftTurnPromptArgs,
} from "./prompts/sift.js";
export { TESTGEN_SYSTEM } from "./prompts/testgen.js";
export {
  BREW_SYSTEM,
  BREW_TOOLS,
  turnPrompt,
  turnPromptParts,
} from "./prompts/brew.js";
export {
  SPEC_CHECKLIST_MD,
  RELATIONSHIP_ANALYST_SYSTEM,
  REFINEMENT_ANALYST_SYSTEM,
  AMENDMENT_SYSTEM,
} from "./prompts/refine.js";
