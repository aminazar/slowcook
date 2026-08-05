// @vitest-environment jsdom
//
// The review tool must never take the page down.
//
// Reproduces the delgoosh therapist-onboarding blackout: the overlay's
// pre-bundled chunk 504'd, the host's `lazy(() => import(...))` rejected, a
// rejected lazy() threw during render, and — with no error boundary anywhere
// in this package — React unmounted the host's whole tree. `#root` innerHTML
// went to 0 while a real person was mid-signup.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, lazy, Suspense, type JSX } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from "react-dom/client";
import { ReviewErrorBoundary, withReviewErrorBoundary } from "./error-boundary.js";
import {
  SlowcookReviewOverlay,
  ReviewShell,
  ReviewWidget,
  GitHubIssueReview,
} from "./index.js";
import type { CommentStore } from "./review-shell.js";

let container: HTMLDivElement;
let root: Root;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // React reports caught render errors on console.error; the point of this
  // suite is that they stay contained, not that they stay quiet.
  consoleError = vi.spyOn(console, "error").mockImplementation(() => { /* silenced */ });
  container = document.createElement("div");
  container.id = "root";
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  try { act(() => root.unmount()); } catch { /* a torn-down tree is fine */ }
  container.remove();
  consoleError.mockRestore();
  vi.unstubAllGlobals();
  document.querySelectorAll("[data-slowcook-overlay-host]").forEach((n) => n.remove());
});

function Boom(): JSX.Element {
  throw new Error("overlay exploded");
}

/** The host: real product content, with the review tool sitting beside it. */
function Host({ children }: { children: JSX.Element }): JSX.Element {
  return (
    <div>
      <h1>Complete your registration</h1>
      {children}
    </div>
  );
}

describe("ReviewErrorBoundary — a fault in the review tool is not a fault in the product", () => {
  it("renders the host tree when the overlay throws", () => {
    act(() => {
      root.render(
        <Host>
          <ReviewErrorBoundary label="test overlay"><Boom /></ReviewErrorBoundary>
        </Host>,
      );
    });
    // The host is still standing — this is the assertion the incident lacked.
    expect(container.innerHTML.length).toBeGreaterThan(0);
    expect(container.textContent).toContain("Complete your registration");
  });

  it("shows the end user nothing about the review tool", () => {
    act(() => {
      root.render(<ReviewErrorBoundary label="test overlay"><Boom /></ReviewErrorBoundary>);
    });
    // Not an error message, not a fallback, not a placeholder box: nothing.
    // A patient or a therapist never learns QA tooling was on this page.
    expect(container.innerHTML).toBe("");
  });

  it("logs the failure for whoever is reviewing", () => {
    act(() => {
      root.render(<ReviewErrorBoundary label="SlowcookReviewOverlay"><Boom /></ReviewErrorBoundary>);
    });
    const logged = consoleError.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("[slowcook] SlowcookReviewOverlay failed");
  });

  it("calls onError without letting a throwing handler escape", () => {
    const seen: unknown[] = [];
    act(() => {
      root.render(
        <Host>
          <ReviewErrorBoundary
            label="test overlay"
            onError={(e) => { seen.push(e); throw new Error("telemetry is down too"); }}
          >
            <Boom />
          </ReviewErrorBoundary>
        </Host>,
      );
    });
    expect(seen).toHaveLength(1);
    expect(container.textContent).toContain("Complete your registration");
  });

  it("survives a rejected lazy() import — the 504 that blanked the page", async () => {
    // <Suspense> handles the PENDING state of a lazy import. It does NOT
    // catch the REJECTED one; only a boundary does. This is the exact shape
    // of the incident: the chunk request failed, so the import rejected.
    const Overlay = lazy(() => Promise.reject(new Error("Failed to fetch dynamically imported module")));
    await act(async () => {
      root.render(
        <Host>
          <ReviewErrorBoundary label="review overlay">
            <Suspense fallback={null}><Overlay /></Suspense>
          </ReviewErrorBoundary>
        </Host>,
      );
    });
    expect(container.innerHTML.length).toBeGreaterThan(0);
    expect(container.textContent).toContain("Complete your registration");
  });

  it("without a boundary the same rejection destroys the host tree (the bug)", async () => {
    const Overlay = lazy(() => Promise.reject(new Error("Failed to fetch dynamically imported module")));
    try {
      await act(async () => {
        root.render(
          <Host>
            <Suspense fallback={null}><Overlay /></Suspense>
          </Host>,
        );
      });
    } catch { /* React may rethrow the uncaught error; either way the tree is gone */ }
    // #root innerHTML length went to 0 — verbatim what the field report showed.
    expect(container.innerHTML).toBe("");
  });

  it("withReviewErrorBoundary keeps the wrapped component's props", () => {
    const Greeter = ({ name }: { name: string }): JSX.Element => <span>hello {name}</span>;
    const Guarded = withReviewErrorBoundary(Greeter, "Greeter");
    act(() => { root.render(<Guarded name="reviewer" />); });
    expect(container.textContent).toBe("hello reviewer");
  });
});

describe("the exported mount points are self-guarding", () => {
  it("every React mount point this package exports is wrapped", () => {
    // A new mount point added to the barrel without a boundary fails here.
    const mounts = { SlowcookReviewOverlay, ReviewShell, ReviewWidget, GitHubIssueReview };
    for (const [name, Mount] of Object.entries(mounts))
      expect((Mount as { displayName?: string }).displayName).toBe(`withReviewErrorBoundary(${name})`);
  });

  it("ReviewShell keeps the host standing when its own store throws", () => {
    // A real fault inside the tool: the comment store blows up during render
    // (the shell reads it in a useState initializer). Before the fix this
    // took the host tree with it.
    const brokenStore: CommentStore = {
      load: () => { throw new Error("localStorage is disabled in this browser"); },
      save: () => { /* unreachable */ },
    };
    act(() => {
      root.render(
        <Host>
          <ReviewShell enabled store={brokenStore} title="QA" />
        </Host>,
      );
    });
    expect(container.textContent).toContain("Complete your registration");
    expect(container.querySelector("[data-review-widget]")).toBeNull();
  });
});
