// @vitest-environment jsdom
//
// #1 — semantic (a11y-tree) anchoring. Proves a comment anchored by role +
// accessible name + container survives DOM restructuring (where a CSS selector
// would drift), disambiguates duplicate names by container, and degrades to the
// selector when an element has no semantic identity.
import { describe, it, expect, beforeEach } from "vitest";
import { extractA11yPath, resolveA11yPath, resolveAnchor, extractSelector } from "./selector.js";

const set = (html: string) => { document.body.innerHTML = html; };

describe("a11y anchoring (#1)", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("extracts role + accessible name from a control", () => {
    set(`<button>Save rewo</button>`);
    expect(extractA11yPath(document.querySelector("button")!)).toEqual({
      segs: [{ role: "button", name: "Save rewo" }],
    });
  });

  it("includes the nearest named container in the path", () => {
    set(`<section aria-label="Feed"><button>Save</button></section>`);
    expect(extractA11yPath(document.querySelector("button")!)!.segs).toEqual([
      { role: "region", name: "Feed" },
      { role: "button", name: "Save" },
    ]);
  });

  it("round-trips — resolve finds the same element back", () => {
    set(`<button>Save</button>`);
    const p = extractA11yPath(document.querySelector("button")!)!;
    expect(resolveA11yPath(document, p)).toBe(document.querySelector("button"));
  });

  it("survives DOM restructuring (a selector would have drifted)", () => {
    set(`<main aria-label="App"><button>Publish</button></main>`);
    const p = extractA11yPath(document.querySelector("button")!)!;
    // re-render with the same semantics but different wrapping + sibling order
    set(`<main aria-label="App"><div class="toolbar"><span>x</span><button>Publish</button></div></main>`);
    expect(resolveA11yPath(document, p)).toBe(document.querySelector("button"));
  });

  it("disambiguates duplicate names by container", () => {
    set(`<section aria-label="Drafts"><button>Delete</button></section>` +
        `<section aria-label="Published"><button>Delete</button></section>`);
    const buttons = document.querySelectorAll("button");
    const published = extractA11yPath(buttons[1]!)!;
    expect(resolveA11yPath(document, published)).toBe(buttons[1]);
  });

  it("has no semantic anchor for a plain div → selector is the only anchor", () => {
    set(`<div id="card-7">content</div>`);
    const sel = extractSelector(document.getElementById("card-7")!);
    expect(sel.a11y).toBeNull();
    const hit = resolveAnchor(document, { selector: sel.selector, fallback_selector: sel.fallbackSelector, a11y: sel.a11y });
    expect(hit?.element).toBe(document.getElementById("card-7"));
    expect(hit?.via).toBe("selector");
  });

  it("resolveAnchor prefers the a11y anchor over the selector", () => {
    set(`<button>Go</button>`);
    const sel = extractSelector(document.querySelector("button")!);
    const hit = resolveAnchor(document, { selector: "button", fallback_selector: null, a11y: sel.a11y });
    expect(hit?.via).toBe("a11y");
    expect(hit?.element).toBe(document.querySelector("button"));
  });
});
