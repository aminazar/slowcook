// @vitest-environment jsdom
//
// 0.8.2 — coverage for 0.8.0 "arm-to-pick" free navigation, shipped untested.
// Contract: in LCR comment mode the page is navigable by default; only after
// the reviewer arms a single pick does the *next* page click get captured into
// a comment, after which it auto-disarms. Driving the real toolbar buttons here
// also proves the 0.7.3 shadow-DOM portal still delivers React click events
// (a portal outside the root container is exactly where delegation can break).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SlowcookReviewOverlay } from "./overlay.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let pageBtn: HTMLButtonElement;

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200, headers: new Headers(), json: async () => [], text: async () => "[]",
  })));
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  })));
  // a plain page element the reviewer could click to navigate.
  pageBtn = document.createElement("button");
  pageBtn.id = "page-btn";
  pageBtn.textContent = "go somewhere";
  document.body.appendChild(pageBtn);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  pageBtn.remove();
  document.querySelectorAll("[data-slowcook-overlay-host]").forEach((n) => n.remove());
  vi.unstubAllGlobals();
});

function shadow(): ShadowRoot {
  const host = document.querySelector("[data-slowcook-overlay-host]") as HTMLElement;
  return host.shadowRoot!;
}
function buttons(): HTMLButtonElement[] {
  return Array.from(shadow().querySelectorAll("button"));
}
function clickPage(): boolean {
  // returns true if NOT prevented (i.e. the click was left to navigate freely).
  // Wrapped in act() so any state change the capture handler makes (e.g. the
  // one-shot disarm) flushes — and the capture effect re-subscribes — before
  // the next dispatch. preventDefault is called synchronously during dispatch,
  // so the return value still reflects this click.
  let navigable = true;
  act(() => {
    const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
    navigable = pageBtn.dispatchEvent(evt);
  });
  return navigable;
}

function render() {
  act(() => {
    root.render(
      <SlowcookReviewOverlay enabled reviewMode="lcr" owner="acme" repo="app" prNumber={1} branch="main" />,
    );
  });
}

describe("arm-to-pick free navigation (0.8.0)", () => {
  it("captures a page click only after arming, then auto-disarms", () => {
    render();

    // Nav mode by default: no arm affordance yet.
    expect(buttons().find((b) => /Pin a comment/i.test(b.title))).toBeUndefined();

    // Enter comment mode via the nav/rev toolbar toggle (reads "nav" in nav mode).
    const toggle = buttons().find((b) => (b.textContent ?? "").trim() === "nav");
    expect(toggle, "the nav/rev mode toggle is present").toBeTruthy();
    act(() => { toggle!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    // Comment mode, NOT armed → the page is navigable; a page click is untouched.
    const arm = buttons().find((b) => /Pin a comment/i.test(b.title));
    expect(arm, "arm-a-pick button appears in comment mode").toBeTruthy();
    expect(clickPage(), "unarmed page click navigates freely (not captured)").toBe(true);

    // Arm a single pick.
    act(() => { arm!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    // Armed → the next page click is captured (prevented)...
    expect(clickPage(), "armed page click is captured (prevented)").toBe(false);

    // ...and it auto-disarmed, so a subsequent page click navigates freely again.
    expect(clickPage(), "auto-disarm after one pick — page navigable again").toBe(true);
  });
});
