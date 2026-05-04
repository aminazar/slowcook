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
  // 0.11.1 (paired with cli 0.15.0-α.4) — addendum appended to BREW_SYSTEM
  // when brew runs in `--mode plate`. The mockup is on main; brew does
  // data-layer + API + migrations only.
  BREW_PLATE_MODE_ADDENDUM,
} from "./prompts/brew.js";
export {
  SPEC_CHECKLIST_MD,
  RELATIONSHIP_ANALYST_SYSTEM,
  REFINEMENT_ANALYST_SYSTEM,
  SIDE_EFFECTS_AUDIT_SYSTEM,
  AMENDMENT_SYSTEM,
} from "./prompts/refine.js";
// 0.10.0 — vibe agent (0.15 plate-pipeline α.1) — design-first mockup
// generator. Reads spec + brownfield extracts + code-map; emits a
// runnable React mockup with mock data + brew-target stubs.
export {
  VIBE_SYSTEM,
  VIBE_TOOLS,
  buildVibeUserPrompt,
  type VibeUserPromptArgs,
} from "./prompts/vibe.js";
// 0.11.0 — plate agent (0.15 plate-pipeline α.3) — mockup-amendment
// agent. Reads PR comments + annotated screenshots since the last
// plate commit; amends mockup files with minimum diff; force-pushes.
// Vision-capable.
export {
  PLATE_AMENDMENT_SYSTEM,
  PLATE_TOOLS,
  buildPlateAmendmentPrompt,
  type PlateAmendmentPromptArgs,
  type PlateFeedback,
  type PlateImageAttachment,
  type PlateImageMediaType,
} from "./prompts/plate.js";
// 0.14.3 — pair-brew navigator (cli α.8 prototype). Read-only LLM that
// reviews a driver's iteration; emits a NavigatorVerdict structured JSON.
export {
  NAVIGATOR_SYSTEM,
  buildNavigatorPrompt,
  type NavigatorAxis,
  type NavigatorVerdict,
  type NavigatorPromptArgs,
} from "./prompts/navigator.js";
