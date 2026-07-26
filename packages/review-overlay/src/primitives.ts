// ── @slowcook-ai/review-overlay/primitives ──────────────────────────────────
// The SHELL PRIMITIVES: generic, workflow-free review-surface building blocks.
// OSS-specific shells (the vibe/plate LCR overlay, the Refine ReviewWidget)
// and external consumers (dash's RefinePill → pm-/brand-assistant loop) build
// on these. Nothing here knows about GitHub, PRs, stories, or agents.
export {
  ReviewShell,
  SlowcookMark,
  localStorageStore,
  type ReviewShellProps,
  type ReviewComment,
  type ReviewCommentMeta,
  type CommentStore,
  type Corner,
} from "./react/review-shell.js";
export { usePrefersDark, detectPageDark, pillTheme, sheetTheme } from "./react/theme.js";
export { installBreadcrumbRecorder, breadcrumbs, pushBreadcrumb, clearBreadcrumbs, type Breadcrumb } from "./react/breadcrumbs.js";
