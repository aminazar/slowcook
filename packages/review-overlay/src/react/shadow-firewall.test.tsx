// @vitest-environment jsdom
//
// 0.7.3 — proves the Shadow-DOM style firewall. Reproduces the delgoosh
// failure mode (an RTL host with a universal `*{}` reset) and asserts the
// overlay mounts its UI inside a shadow root whose :host reset severs the
// leaked inheritance — so the disk can't "lose its shape" or mirror.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";

// React 19 wants this flag set before act() is used outside a test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { createRoot, type Root } from "react-dom/client";
import { SlowcookReviewOverlay } from "./overlay.js";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // Simulate a hostile host: RTL + a universal reset + a button reset,
  // exactly the kind of global CSS that used to bleed into the overlay.
  document.documentElement.setAttribute("dir", "rtl");
  document.body.style.direction = "rtl";
  const hostCss = document.createElement("style");
  hostCss.textContent =
    "*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}" +
    "button{all:unset}";
  document.head.appendChild(hostCss);

  // The overlay fetches LCR issues + reads matchMedia on mount; stub both
  // so the effects settle without network or a missing browser API.
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true, status: 200, headers: new Headers(), json: async () => [], text: async () => "[]",
  })));
  if (!window.matchMedia) {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    })));
  }

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  document.querySelectorAll("[data-slowcook-overlay-host]").forEach((n) => n.remove());
});

function render() {
  act(() => {
    root.render(
      <SlowcookReviewOverlay
        enabled
        reviewMode="lcr"
        owner="acme"
        repo="app"
        prNumber={1}
        branch="main"
      />,
    );
  });
}

describe("shadow-DOM style firewall (0.7.3)", () => {
  it("mounts the overlay UI inside a shadow root, not the light DOM", () => {
    render();
    const host = document.querySelector("[data-slowcook-overlay-host]") as HTMLElement | null;
    expect(host, "a body-level shadow host is created").toBeTruthy();
    expect(host!.shadowRoot, "host has an open shadow root").toBeTruthy();
    // The overlay UI lives in the shadow tree...
    expect(host!.shadowRoot!.querySelector("[data-slowcook-overlay-ui]")).toBeTruthy();
    // ...and is therefore invisible to a light-DOM query (true encapsulation).
    expect(document.querySelector("[data-slowcook-overlay-ui]")).toBeNull();
  });

  it("injects a :host reset that severs inherited host CSS (incl. the RTL exception)", () => {
    render();
    const host = document.querySelector("[data-slowcook-overlay-host]") as HTMLElement;
    const css = Array.from(host.shadowRoot!.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .join("\n");
    expect(css).toContain(":host{all:initial");
    // `all` deliberately skips direction/unicode-bidi — the explicit reset is
    // what actually un-mirrors the toolbar on an RTL host.
    expect(css).toContain("direction:ltr");
    expect(css).toContain("unicode-bidi:isolate");
  });
});
