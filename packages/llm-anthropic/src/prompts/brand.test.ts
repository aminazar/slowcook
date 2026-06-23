import { describe, it, expect } from "vitest";
import { BRAND_SYSTEM } from "./brand.js";

describe("BRAND_SYSTEM (sc#82 Phase 4)", () => {
  it("includes the consumer's project-context block", () => {
    const out = BRAND_SYSTEM("(my brand context)");
    expect(out).toContain("(my brand context)");
  });

  it("requires the canonical COLORS keys", () => {
    const out = BRAND_SYSTEM("");
    for (const key of [
      "primary",
      "primaryLight",
      "primaryDark",
      "primaryGhost",
      "accent",
      "success",
      "danger",
      "warn",
      "bg",
      "bgDark",
      "sand",
      "cream",
      "textDark",
      "textMid",
      "textLight",
    ]) {
      expect(out).toContain(key);
    }
  });

  it("requires SPACING + RADIUS + SHADOW + FONTS exports", () => {
    const out = BRAND_SYSTEM("");
    expect(out).toContain("export const SPACING");
    expect(out).toContain("export const RADIUS");
    expect(out).toContain("export const SHADOW");
    expect(out).toContain("export const FONTS");
  });

  it("requires makeGlobalCSS with direction-aware branching", () => {
    const out = BRAND_SYSTEM("");
    expect(out).toContain("makeGlobalCSS");
    expect(out).toContain("dir = lang === 'fa'");
  });

  it("specifies file paths for all four emitted files", () => {
    const out = BRAND_SYSTEM("");
    expect(out).toContain("mock/src/design-system/tokens.ts");
    expect(out).toContain("mock/src/design-system/css.ts");
    expect(out).toContain("mock/src/design-system/theme.css");
    expect(out).toContain("mock/src/design-system/brand-board.html");
  });

  it("requires a dual-mode Tailwind theme.css", () => {
    const out = BRAND_SYSTEM("");
    expect(out).toContain('@import "tailwindcss"');
    expect(out).toContain("[data-theme]");
    expect(out).toContain("@theme");
    // dual mode is not optional when the brief asks
    expect(out).toContain("Dual mode is not optional");
  });

  it("requires first-class tokens for 'must read distinctly' domain semantics", () => {
    const out = BRAND_SYSTEM("");
    expect(out).toContain("Domain semantics get first-class tokens");
    expect(out).toContain("--color-agent");
  });

  it("requires a felt, self-contained brand board with a day/dark toggle", () => {
    const out = BRAND_SYSTEM("");
    expect(out).toContain("brand-board.html");
    expect(out).toContain("felt, not read");
    expect(out).toContain("day/dark toggle");
  });

  it("instructs the agent to derive ghost from primary at coherent alpha", () => {
    const out = BRAND_SYSTEM("");
    expect(out).toContain("primary at 12% alpha");
    expect(out).toContain("Pick consistent variants");
  });

  it("requires Google Fonts URLs (not self-hosted)", () => {
    const out = BRAND_SYSTEM("");
    expect(out).toContain("Google Fonts");
    expect(out).toContain("fonts.googleapis.com");
  });

  it("instructs the agent to emit Output format only — XML blocks, no prose", () => {
    const out = BRAND_SYSTEM("");
    expect(out).toContain("Output ONLY the XML-tagged file blocks");
    expect(out).toContain("No prose preamble");
  });

  it("includes self-check rules", () => {
    const out = BRAND_SYSTEM("");
    expect(out).toContain("Self-check before emitting");
  });
});
