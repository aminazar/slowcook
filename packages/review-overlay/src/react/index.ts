// The React entry — and the ONLY door into the React shells: `package.json`
// `exports` publishes `./react` and nothing deeper, so every consumer's
// component comes from this file.
//
// Which is why the mount points are wrapped HERE. A review tool is optional
// furniture in someone else's product; when it faults it must remove itself,
// not the page it floats over (see ./error-boundary.tsx for the incident).
import { SlowcookReviewOverlay as SlowcookReviewOverlayInner } from "./overlay.js";
import { ReviewWidget as ReviewWidgetInner } from "./review-widget.js";
import { ReviewShell as ReviewShellInner } from "./review-shell.js";
import { GitHubIssueReview as GitHubIssueReviewInner } from "./github-issue-review.js";
import { withReviewErrorBoundary } from "./error-boundary.js";

/** Every mount point, self-guarding. Existing consumers get this for free. */
export const SlowcookReviewOverlay = withReviewErrorBoundary(SlowcookReviewOverlayInner, "SlowcookReviewOverlay");
export const ReviewWidget = withReviewErrorBoundary(ReviewWidgetInner, "ReviewWidget");
export const ReviewShell = withReviewErrorBoundary(ReviewShellInner, "ReviewShell");
export const GitHubIssueReview = withReviewErrorBoundary(GitHubIssueReviewInner, "GitHubIssueReview");

// Exported too, because a boundary inside this package cannot catch a
// failure that happens while this package is still being FETCHED — a host
// lazy-importing the overlay needs its own boundary around that import.
export { ReviewErrorBoundary, withReviewErrorBoundary, type ReviewErrorBoundaryProps } from "./error-boundary.js";

export type { SlowcookReviewOverlayProps } from "./overlay.js";
export type { ReviewWidgetProps, ReviewComment, Corner } from "./review-widget.js";
export { localStorageStore, type ReviewShellProps, type ReviewCommentMeta, type CommentStore } from "./review-shell.js";
export type { GitHubIssueReviewProps, IssueLike, AgentReply } from "./github-issue-review.js";
export { parseAgentReply, buildIssueBody, parseIssue } from "./github-issue-review.js";
export { usePrefersDark, detectPageDark, pillTheme, sheetTheme } from "./theme.js";
export { useScenarioCommentStats, type UseScenarioCommentStatsArgs } from "./use-scenario-comment-stats.js";
export { useStoryMarker, readCurrentStory } from "./use-story-marker.js";
export { installBreadcrumbRecorder, breadcrumbs, pushBreadcrumb, clearBreadcrumbs, type Breadcrumb } from "./breadcrumbs.js";
export { useReviewEvidence, rectForNode, type EvidenceConfig, type GatheredEvidence } from "./use-evidence.js";
export { AttachedWindow, type AttachedWindowProps } from "./attached-window.js";
export { AskPanel, type AskPanelProps } from "./overlay.js";
