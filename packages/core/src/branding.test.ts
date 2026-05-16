import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SLOWCOOK_LOGO_SVG } from "./branding.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("SLOWCOOK_LOGO_SVG (sc#82 follow-up)", () => {
  it("is a non-empty string containing SVG markup", () => {
    expect(SLOWCOOK_LOGO_SVG).toBeTypeOf("string");
    expect(SLOWCOOK_LOGO_SVG.length).toBeGreaterThan(0);
    expect(SLOWCOOK_LOGO_SVG).toContain("<svg");
    expect(SLOWCOOK_LOGO_SVG).toContain("</svg>");
  });

  it("uses slowcook brand coral (#FF6B6B)", () => {
    expect(SLOWCOOK_LOGO_SVG).toContain("#FF6B6B");
  });

  it("declares viewBox 0 0 24 24", () => {
    expect(SLOWCOOK_LOGO_SVG).toMatch(/viewBox=["']0 0 24 24["']/);
  });

  it("matches the canonical file at packages/core/assets/slowcook-logo.svg exactly", () => {
    const canonicalPath = join(__dirname, "..", "assets", "slowcook-logo.svg");
    const fileContent = readFileSync(canonicalPath, "utf8");
    expect(SLOWCOOK_LOGO_SVG).toBe(fileContent);
  });

  it("has no <script> tag (XSS-safe for dangerouslySetInnerHTML)", () => {
    expect(SLOWCOOK_LOGO_SVG).not.toContain("<script");
  });
});
