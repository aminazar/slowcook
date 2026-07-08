// Back-compat consumer of the SHELL PRIMITIVE (0.12.0 decoupling): the OSS
// "Refine"-style widget = ReviewShell + localStorage persistence keyed by
// `storageKey`. Anything workflow-specific belongs in the consumer, not here.
import type { JSX } from "react";
import { ReviewShell, localStorageStore, type ReviewShellProps } from "./review-shell.js";
export type { ReviewComment, ReviewCommentMeta, Corner, CommentStore } from "./review-shell.js";

export interface ReviewWidgetProps extends Omit<ReviewShellProps, "store"> {
  /** localStorage key for the internal comment store. */
  storageKey?: string;
}

export function ReviewWidget({ storageKey = "slowcook.review-widget.comments", ...rest }: ReviewWidgetProps): JSX.Element | null {
  return ReviewShell({ ...rest, store: localStorageStore(storageKey) });
}
