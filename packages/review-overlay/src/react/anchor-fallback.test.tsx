// @vitest-environment jsdom
//
// 0.14.0 — anchorFallback: a bug-reporter shell must NEVER refuse a target.
// Contract: in comment mode, clicking an element with no data-review-node
// ancestor synthesizes a `dom:` anchor from the DOM path (composer opens);
// without the flag the click is ignored (the old Refine behavior, unchanged).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ReviewShell, domPath, fallbackContainer } from "./review-shell.js";
import type { CommentStore, ReviewComment } from "./review-widget.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const memStore = (): CommentStore => {
  let items: ReviewComment[] = [];
  return { load: () => items, save: (next) => { items = next; } };
};

let container: HTMLDivElement;
let root: Root;
let plainBox: HTMLDivElement;   // NO data-review-node anywhere above it
let plainBtn: HTMLButtonElement;

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  })));
  plainBox = document.createElement("div");
  plainBox.textContent = "Connect your GitHub account to pick the repository";
  plainBtn = document.createElement("button");
  plainBtn.textContent = "refresh";
  plainBox.appendChild(plainBtn);
  document.body.appendChild(plainBox);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  plainBox.remove();
  vi.unstubAllGlobals();
});

const mount = (anchorFallback: boolean) => act(() => {
  root.render(<ReviewShell enabled requireTargets={false} anchorFallback={anchorFallback} store={memStore()} title="QA" />);
});

const enterCommentMode = () => act(() => {
  // ONE mode button now: it shows the CURRENT mode ("Read"); clicking flips
  // it into comment mode.
  const labels = [...document.querySelectorAll("[data-review-widget] button")];
  (labels.find((b) => b.textContent === "Read") as HTMLButtonElement).click();
});

const clickPage = (el: Element) => act(() => {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
});

describe("anchorFallback (0.14.0)", () => {
  it("without the flag, an unanchored click is refused (composer stays closed)", () => {
    mount(false);
    enterCommentMode();
    clickPage(plainBtn);
    expect(document.querySelector("[data-review-widget] textarea")).toBeNull();
  });

  it("with the flag, an unanchored click synthesizes a dom: anchor and opens the composer", () => {
    mount(true);
    enterCommentMode();
    clickPage(plainBtn);
    const ta = document.querySelector("[data-review-widget] textarea");
    expect(ta).not.toBeNull(); // the composer opened — the target was never refused
  });

  it("a real data-review-node ancestor still wins over the fallback", () => {
    const anchored = document.createElement("div");
    anchored.setAttribute("data-review-node", "known/box");
    anchored.setAttribute("data-review-label", "Known box");
    const inner = document.createElement("span");
    inner.textContent = "inside";
    anchored.appendChild(inner);
    document.body.appendChild(anchored);
    try {
      mount(true);
      enterCommentMode();
      clickPage(inner);
      // composer label shows the SEMANTIC label, not a synthesized one
      const widget = document.querySelector("[data-review-widget]")!;
      expect(widget.textContent).toContain("Known box");
    } finally { anchored.remove(); }
  });

  it("domPath round-trips: querySelector(path) finds the same element", () => {
    const path = domPath(plainBtn);
    expect(document.querySelector(path)).toBe(plainBtn);
  });

  it("fallbackContainer lifts a leaf to its visual box (the div, not the button's text)", () => {
    expect(fallbackContainer(plainBtn)).toBe(plainBox);
  });
});
