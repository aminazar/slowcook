import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./markdown.js";

describe("renderMarkdown", () => {
  it("renders headings, bold, inline code, links", () => {
    const h = renderMarkdown("# Title\n\nA **bold** and `code` and [x](https://y).");
    expect(h).toContain("<h1>Title</h1>");
    expect(h).toContain("<strong>bold</strong>");
    expect(h).toContain("<code>code</code>");
    expect(h).toContain('<a href="https://y" target="_blank" rel="noreferrer">x</a>');
  });
  it("renders lists, blockquotes, hr, fenced code", () => {
    expect(renderMarkdown("- a\n- b")).toContain("<ul><li>a</li><li>b</li></ul>");
    expect(renderMarkdown("> quote")).toContain("<blockquote>quote</blockquote>");
    expect(renderMarkdown("---")).toContain("<hr/>");
    expect(renderMarkdown("```\nx<y\n```")).toContain("<pre><code>x&lt;y</code></pre>");
  });
  it("renders GFM tables", () => {
    const h = renderMarkdown("| A | B |\n|---|---|\n| 1 | 2 |");
    expect(h).toContain("<table>");
    expect(h).toContain("<th>A</th>");
    expect(h).toContain("<td>1</td>");
  });
  it("escapes raw HTML in text (no injection)", () => {
    expect(renderMarkdown("a <script>alert(1)</script>")).not.toContain("<script>");
    expect(renderMarkdown("a <script>")).toContain("&lt;script&gt;");
  });
});
