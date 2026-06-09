import { describe, it, expect } from "vitest";
import { extractSvgColors, tokenizeSvg, untokenizedColors } from "./logo.js";

const svg = `<svg><path fill="#3BAFA0" stroke="#2a8f82"/><circle fill="#FFF"/><rect fill="#3bafa0"/></svg>`;

describe("extractSvgColors", () => {
  it("returns distinct canonical colors in order", () => {
    expect(extractSvgColors(svg)).toEqual(["#3bafa0", "#2a8f82", "#ffffff"]);
  });
});

describe("tokenizeSvg", () => {
  it("rewrites mapped colors to var(--token), case/shorthand-insensitive", () => {
    const out = tokenizeSvg(svg, { "#3bafa0": "brand-primary", "#2A8F82": "brand-primary-dark", "#ffffff": "bg" });
    expect(out).toContain('fill="var(--brand-primary)"');
    expect(out).toContain('stroke="var(--brand-primary-dark)"');
    expect(out).toContain('fill="var(--bg)"'); // #FFF matched via #ffffff
    // both occurrences of the primary recolored
    expect(out.match(/var\(--brand-primary\)/g)).toHaveLength(2);
  });

  it("leaves unmapped colors untouched", () => {
    const out = tokenizeSvg(svg, { "#3bafa0": "brand-primary" });
    expect(out).toContain('stroke="#2a8f82"');
  });
});

describe("untokenizedColors", () => {
  it("reports the colors the PM still needs to map", () => {
    expect(untokenizedColors(svg, { "#3bafa0": "brand-primary" })).toEqual(["#2a8f82", "#ffffff"]);
  });
});
