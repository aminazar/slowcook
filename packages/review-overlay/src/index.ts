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
  PLATE_REPLY_MARKER,
  formatReviewComment,
  parseReviewComment,
  formatPlateReplyBlock,
  parsePlateReply,
  buildPayload,
  type ReviewCommentPayload,
  type ViewportInfo,
  type FormatArgs,
  type PlateReplyEntry,
  type PlateReplyPayload,
  type PlateReplyStatus,
} from "./comment-format.js";

export {
  extractSelector,
  resolveStoredSelector,
  resolveAnchor,
  extractA11yPath,
  resolveA11yPath,
  roleOf,
  isPillOffViewport,
  clampPillPosition,
  type ExtractedSelector,
  type A11yPath,
  type A11ySeg,
} from "./selector.js";

export {
  loadPat,
  savePat,
  clearPat,
  patStorageKey,
  submitComment,
  fetchOverlayComments,
  loadCachedComments,
  saveCachedComments,
  commentsCacheKey,
  fetchAllMockupPrs,
  fetchScenarioStats,
  loadCachedScenarioStats,
  saveCachedScenarioStats,
  scenarioStatsCacheKey,
  emptyStats,
  fetchPrLabels,
  addLabelsToPr,
  submitPrApproval,
  APPROVED_LABEL,
  type RepoCoord,
  type SubmitArgs,
  type SubmitResult,
  type SubmitOk,
  type SubmitErr,
  type OverlayCommentRecord,
  type ScenarioCommentStats,
} from "./github.js";

export {
  loadReviewerToken,
  saveReviewerToken,
  loadReviewerIdentity,
  saveReviewerIdentity,
  clearReviewerSession,
  requestDeviceCode,
  pollAccessToken,
  runDeviceLogin,
  type LoginEvent,
  type LoginDriverOptions,
  identifyReviewer,
  checkRepoWriteAccess,
  type StoredReviewerIdentity,
} from "./reviewer-session.js";
