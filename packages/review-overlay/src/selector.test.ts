// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { extractSelector } from "./selector.js";

function root(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

describe("extractSelector — strategy order", () => {
  it("prefers id when present + meaningful", () => {
    const body = root('<span id="unread-badge">3</span>');
    const r = extractSelector(body.firstElementChild!);
    expect(r.strategy).toBe("id");
    expect(r.selector).toBe("#unread-badge");
    expect(r.tag).toBe("span");
    expect(r.textHint).toBe("3");
  });

  it("ignores React useId-style synthetic ids", () => {
    const body = root('<div id=":r3:" data-testid="real-thing">x</div>');
    const r = extractSelector(body.firstElementChild!);
    expect(r.strategy).toBe("data-testid");
    expect(r.selector).toBe('[data-testid="real-thing"]');
  });

  it("ignores Radix-injected ids", () => {
    const body = root('<div id="radix-:r5:" data-testid="real-radix-target">x</div>');
    const r = extractSelector(body.firstElementChild!);
    expect(r.strategy).toBe("data-testid");
  });

  it("falls through to data-testid when no id", () => {
    const body = root('<button data-testid="save-btn">Save</button>');
    const r = extractSelector(body.firstElementChild!);
    expect(r.strategy).toBe("data-testid");
    expect(r.selector).toBe('[data-testid="save-btn"]');
  });

  it("uses role + accessible-name for buttons / links with aria-label", () => {
    const body = root('<button aria-label="Sign in to your account">X</button>');
    const r = extractSelector(body.firstElementChild!);
    expect(r.strategy).toBe("role-name");
    expect(r.selector).toBe('button[aria-label="Sign in to your account"]');
  });

  it("uses role + button textContent when no aria-label", () => {
    const body = root('<div><button>Submit form</button></div>');
    const btn = body.querySelector("button")!;
    const r = extractSelector(btn);
    expect(r.strategy).toBe("role-name");
    expect(r.selector).toBe('button[aria-label="Submit form"]');
  });

  it("falls through to tag.classes when no id/testid/role-name", () => {
    const body = root('<div><span class="badge counter important-thing">3</span></div>');
    const span = body.querySelector("span")!;
    const r = extractSelector(span);
    expect(r.strategy).toBe("tag-classes");
    expect(r.selector).toContain("span.badge.counter");
  });

  it("adds nth-child suffix when parent has multiple same-tag children", () => {
    const body = root(
      '<ul><li class="row first-row">a</li><li class="row second-row">b</li><li class="row">c</li></ul>'
    );
    const second = body.querySelectorAll("li")[1]!;
    const r = extractSelector(second);
    expect(r.strategy).toBe("tag-classes");
    expect(r.selector).toBe("li.row.second-row:nth-child(2)");
  });

  it("filters out Tailwind utility classes when seeding tag.classes", () => {
    const body = root(
      '<div><span class="bg-mint text-coral p-2 badge counter">3</span></div>'
    );
    const span = body.querySelector("span")!;
    const r = extractSelector(span);
    expect(r.strategy).toBe("tag-classes");
    // Should pick badge.counter, not bg-mint or text-coral
    expect(r.selector).toBe("span.badge.counter");
  });

  it("filters out emotion-style hashed classes", () => {
    const body = root(
      '<div><span class="css-1abc2 real-class also-real">x</span></div>'
    );
    const r = extractSelector(body.querySelector("span")!);
    expect(r.selector).toBe("span.real-class.also-real");
  });

  it("falls through to xpath when no other strategy hits", () => {
    const body = root('<div><span>only-text</span></div>');
    const r = extractSelector(body.querySelector("span")!);
    // span has no id/testid/role/classes — xpath fallback
    expect(r.strategy).toBe("xpath");
    expect(r.selector).toMatch(/^\/html\/body\//);
  });
});

describe("extractSelector — populated metadata", () => {
  it("captures fallback selector (next priority down)", () => {
    const body = root('<button id="signin" data-testid="signin-btn" aria-label="Sign in">x</button>');
    const r = extractSelector(body.firstElementChild!);
    expect(r.strategy).toBe("id");
    expect(r.selector).toBe("#signin");
    expect(r.fallbackSelector).toBe('[data-testid="signin-btn"]');
  });

  it("truncates long text hints to 80 chars + adds ellipsis", () => {
    const long = "x".repeat(120);
    const body = root(`<p id="p1">${long}</p>`);
    const r = extractSelector(body.firstElementChild!);
    expect(r.textHint!.length).toBeLessThanOrEqual(81); // 80 + 1 char ellipsis
    expect(r.textHint!.endsWith("…")).toBe(true);
  });

  it("collapses whitespace in text hints", () => {
    const body = root('<p id="p1">  hello\n\n   world  </p>');
    const r = extractSelector(body.firstElementChild!);
    expect(r.textHint).toBe("hello world");
  });

  it("returns null textHint when element has only whitespace", () => {
    const body = root('<p id="p1">   \n   </p>');
    const r = extractSelector(body.firstElementChild!);
    expect(r.textHint).toBeNull();
  });
});

describe("extractSelector — accessible-name fallbacks", () => {
  it("uses aria-labelledby's referenced text", () => {
    const body = root(
      '<div><label id="l1">Email address</label><input role="textbox" aria-labelledby="l1" /></div>'
    );
    const input = body.querySelector("input")!;
    const r = extractSelector(input);
    expect(r.strategy).toBe("role-name");
    expect(r.selector).toBe('input[aria-label="Email address"]');
  });

  it("uses <label for> for form controls without aria attrs", () => {
    const body = root(
      '<div><label for="email-input">Your email</label><input id="email-input" type="text" /></div>'
    );
    const input = body.querySelector("input")!;
    const r = extractSelector(input);
    // id wins; nothing else should
    expect(r.strategy).toBe("id");
    expect(r.selector).toBe("#email-input");
  });
});
