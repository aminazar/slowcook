// @vitest-environment jsdom
//
// One click, one issue (#384).
//
// The comment submit pipeline — screenshot, upload, POST — takes over a
// second, and nothing marked it in flight. A reviewer with no signal that the
// first click registered clicked again, and the second interaction filed a
// second, complete duplicate issue. It happened twice in one delgoosh review
// session; auto-routed to an agent, the same work is queued twice.
//
// These tests drive TWO synchronous submits through the real shell and assert
// the transport fires exactly ONCE. On the unguarded shell the second Enter
// reads the same still-open composer (and the same not-yet-cleared reply text)
// and fires the pipeline again — verified to produce two calls before the fix.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, type JSX } from "react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from "react-dom/client";
import { ReviewShell, type CommentStore, type ReviewComment } from "./review-shell.js";

let container: HTMLDivElement;
let root: Root;
let target: HTMLDivElement;

/** A store that lives in memory — no localStorage bleed between tests. */
function memoryStore(seed: ReviewComment[] = []): CommentStore {
  let data = [...seed];
  return { load: () => data, save: (next) => { data = next; } };
}

/** Set a controlled <textarea>'s value the way a real keystroke would, so
 *  React's onChange runs and its state catches up. */
function typeInto(ta: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(ta, value);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

function pressEnter(el: Element): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

beforeEach(() => {
  // jsdom has no matchMedia and zero-sizes every element; the shell reads both.
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() { /* */ }, removeEventListener() { /* */ }, addListener() { /* */ }, removeListener() { /* */ }, onchange: null, dispatchEvent: () => false }));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 10, y: 10, left: 10, top: 10, width: 120, height: 30, right: 130, bottom: 40, toJSON: () => ({}) } as DOMRect);

  container = document.createElement("div");
  document.body.appendChild(container);
  // the element a reviewer pins on — outside the overlay's own portal.
  target = document.createElement("div");
  target.setAttribute("data-review-node", "t1");
  target.setAttribute("data-review-label", "Target");
  target.textContent = "pin me";
  document.body.appendChild(target);
  root = createRoot(container);
});

afterEach(() => {
  try { act(() => root.unmount()); } catch { /* torn-down tree is fine */ }
  container.remove();
  target.remove();
  document.querySelectorAll("[data-review-widget]").forEach((n) => n.remove());
  try { sessionStorage.clear(); } catch { /* */ }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function enterCommentMode(): void {
  act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "c" })); });
}

function openComposerOn(el: Element): void {
  act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}
function openComposerOnTarget(): void { openComposerOn(target); }

function composerTextarea(): HTMLTextAreaElement {
  const ta = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Add a comment"]');
  if (!ta) throw new Error("composer did not open");
  return ta;
}

describe("the comment button files one issue per intent (#384)", () => {
  it("a second Enter during submission does not file a duplicate", async () => {
    const onComment = vi.fn(() => new Promise<void>(() => { /* pending: the slow pipeline, mid-flight */ }));
    act(() => { root.render(<ReviewShell enabled title="QA" onComment={onComment} store={memoryStore()} />); });

    enterCommentMode();
    openComposerOnTarget();

    const ta = composerTextarea();
    act(() => { typeInto(ta, "the button is misaligned"); });

    // two Enters in one synchronous turn — the exact double-fire the reviewer
    // produced by clicking a button that gave no sign the first click landed.
    act(() => { pressEnter(ta); pressEnter(ta); });

    expect(onComment).toHaveBeenCalledTimes(1);
  });

  it("keeps the composer open and the button disabled while the pipeline runs", () => {
    const onComment = vi.fn(() => new Promise<void>(() => { /* pending */ }));
    act(() => { root.render(<ReviewShell enabled title="QA" onComment={onComment} store={memoryStore()} />); });

    enterCommentMode();
    openComposerOnTarget();
    const ta = composerTextarea();
    act(() => { typeInto(ta, "still misaligned"); });
    act(() => { pressEnter(ta); });

    // the send control now reads as in-progress, not dead — which is what
    // stops the re-click being reasonable in the first place.
    const send = document.querySelector<HTMLButtonElement>('button[title="Sending…"]');
    expect(send).not.toBeNull();
    expect(send!.disabled).toBe(true);
    // the composer is still mounted (the reviewer sees their text and progress).
    expect(document.querySelector('textarea[placeholder="Add a comment"]')).not.toBeNull();
  });

  it("a DIFFERENT pin is never blocked by an in-flight one (the guard is per-composer)", () => {
    const onComment = vi.fn(() => new Promise<void>(() => { /* pending */ }));
    act(() => { root.render(<ReviewShell enabled title="QA" onComment={onComment} store={memoryStore()} />); });

    // a second anchor on the page
    const target2 = document.createElement("div");
    target2.setAttribute("data-review-node", "t2");
    target2.setAttribute("data-review-label", "Second");
    document.body.appendChild(target2);

    enterCommentMode();
    openComposerOnTarget();
    act(() => { typeInto(composerTextarea(), "first pin"); });
    act(() => { pressEnter(composerTextarea()); });
    expect(onComment).toHaveBeenCalledTimes(1);

    // pin a DIFFERENT element while the first still uploads; its submit must go
    // through — the lock is the first composer's, not global.
    openComposerOn(target2);
    act(() => { typeInto(composerTextarea(), "second pin"); });
    act(() => { pressEnter(composerTextarea()); });
    expect(onComment).toHaveBeenCalledTimes(2);

    target2.remove();
  });
});

describe("the reply box sends one reply per intent (#384, same class)", () => {
  it("a second Enter during an in-flight reply does not double-send", () => {
    const seeded: ReviewComment = { id: "c1", node: "t1", label: "Target", text: "a thing", author: "PM", createdAt: 1 };
    const onReply = vi.fn(() => new Promise<void>(() => { /* pending */ }));
    act(() => { root.render(<ReviewShell enabled title="QA" store={memoryStore([seeded])} onReply={onReply} onComment={() => { /* */ }} />); });

    // open the sidebar (the 🗨 list button), which renders a reply box per comment.
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-review-widget] button")];
    const listBtn = buttons.find((b) => b.textContent?.includes("🗨"));
    if (!listBtn) throw new Error("sidebar toggle did not render");
    act(() => { listBtn.click(); });

    const reply = document.querySelector<HTMLTextAreaElement>('textarea[placeholder="Reply"]');
    if (!reply) throw new Error("reply box did not open");
    act(() => { typeInto(reply, "agreed, fixing"); });
    act(() => { pressEnter(reply); pressEnter(reply); });

    expect(onReply).toHaveBeenCalledTimes(1);
  });
});
