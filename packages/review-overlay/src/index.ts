/**
 * `@slowcook-ai/review-overlay` — public surface.
 *
 * Two entry points:
 *
 *   import { ... } from "@slowcook-ai/review-overlay"          // framework-free core
 *   import { SlowcookReviewOverlay } from "@slowcook-ai/review-overlay/react"  // React shell
 *
 * The core entry has zero React dependency; plate (which lives in the
 * cli package, server-side) imports `parseReviewComment` from here to
 * decode review comments off the PR thread.
 */

export {
  PAYLOAD_MARKER,
  formatReviewComment,
  parseReviewComment,
  buildPayload,
  type ReviewCommentPayload,
  type ViewportInfo,
  type FormatArgs,
} from "./comment-format.js";

export {
  extractSelector,
  type ExtractedSelector,
} from "./selector.js";

export {
  loadPat,
  savePat,
  clearPat,
  patStorageKey,
  submitComment,
  type RepoCoord,
  type SubmitArgs,
  type SubmitResult,
  type SubmitOk,
  type SubmitErr,
} from "./github.js";
