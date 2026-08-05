// THE REVIEW TOOL MUST NEVER TAKE THE PAGE DOWN.
//
// Field origin (delgoosh, therapist onboarding): a therapist opened their
// invitation link, the page rendered, then went blank — mid-signup, a real
// person. The overlay's pre-bundled chunk 504'd behind nginx, the host's
// `lazy(() => import("./ReviewOverlayInner"))` rejected, and a rejected
// lazy() THROWS during render. Nothing caught it, so React unmounted the
// whole tree: `#root` innerHTML went to 0. The product died of a QA tool.
//
// The trap that made it possible: `<Suspense>` handles the PENDING state of
// a lazy import; it does NOT catch the REJECTED one. Only an error boundary
// does — and this package shipped none, so every consumer was expected to
// know that and defend itself.
//
// Two rules encoded here:
//   · Failure is SILENT to the end user. A patient or a therapist must never
//     read a message about review tooling they did not ask for. Losing the
//     review pill is a rounding error next to losing the page.
//   · Failure is LOUD to the reviewer. It goes to the console, where whoever
//     is running the review session is already looking.
"use client";

import { Component, type ComponentType, type ErrorInfo, type JSX, type ReactNode } from "react";

export interface ReviewErrorBoundaryProps {
  /** The subtree to guard — the overlay, or the host's own lazy mount. */
  children?: ReactNode;
  /** Names the failing part in the console line. Default: "review overlay". */
  label?: string;
  /** Side channel for a host that wants the failure in its own telemetry.
   *  Never used to render anything: the user sees nothing either way. */
  onError?: (error: unknown, info: ErrorInfo) => void;
}

interface ReviewErrorBoundaryState {
  failed: boolean;
}

/**
 * An error boundary that renders NOTHING when its subtree throws.
 *
 * Wrap a host-side lazy mount with it — that is the case a boundary INSIDE
 * this package cannot help with, because the failure happens while the
 * package's own code is still being fetched:
 *
 * ```tsx
 * const Overlay = lazy(() => import("./ReviewOverlayInner"));
 *
 * <ReviewErrorBoundary label="review overlay">
 *   <Suspense fallback={null}><Overlay /></Suspense>
 * </ReviewErrorBoundary>
 * ```
 *
 * The overlay's own exported mount points are already wrapped in one of
 * these (see `react/index.ts`), so a fault INSIDE the tool is covered
 * without any consumer change.
 */
export class ReviewErrorBoundary extends Component<ReviewErrorBoundaryProps, ReviewErrorBoundaryState> {
  override state: ReviewErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ReviewErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const label = this.props.label ?? "review overlay";
    // Loud to the reviewer, invisible to the user. Every call is defended:
    // a host that stubbed console, or an onError that itself throws, must
    // not turn a contained failure back into an uncaught one.
    try {
      console.error(
        `[slowcook] ${label} failed and was removed from the page. The app around it is unaffected.`,
        error,
        info?.componentStack ?? "",
      );
    } catch { /* ignore */ }
    try {
      this.props.onError?.(error, info);
    } catch { /* ignore */ }
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Wrap a component so it can never propagate a render/lifecycle throw into
 * the host tree. Used on every mount point this package exports.
 */
export function withReviewErrorBoundary<P extends object>(
  Inner: ComponentType<P>,
  label: string,
): ComponentType<P> {
  function Guarded(props: P): JSX.Element {
    return (
      <ReviewErrorBoundary label={label}>
        <Inner {...props} />
      </ReviewErrorBoundary>
    );
  }
  Guarded.displayName = `withReviewErrorBoundary(${label})`;
  return Guarded;
}
