// 0.14.0 — the conversational-markdown subset the thread renders.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MdLite } from "./md-lite.js";

const html = (text: string) => renderToStaticMarkup(<MdLite text={text} />);

describe("MdLite", () => {
  it("renders bold, italic, code and links", () => {
    const h = html("**Plain words:** a *station* is `docs` — see [EPSS](https://x.y/e)");
    expect(h).toContain("<strong>Plain words:</strong>");
    expect(h).toContain("<em>station</em>");
    expect(h).toContain(">docs</code>");
    expect(h).toContain('href="https://x.y/e"');
  });
  it("renders bullet lists and blockquotes", () => {
    const h = html("- one\n- two\n\n> quoted line");
    expect(h).toContain("<li");
    expect((h.match(/<li/g) ?? []).length).toBe(2);
    expect(h).toContain("quoted line");
  });
  it("plain text passes through unchanged", () => {
    expect(html("just a sentence")).toContain("just a sentence");
  });
  it("never injects HTML from content", () => {
    expect(html("<img src=x onerror=alert(1)>")).not.toContain("<img");
  });
});
