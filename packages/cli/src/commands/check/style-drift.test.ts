// style-drift: skin-vs-geometry classification + the ratchet math.
import { describe, it, expect } from "vitest";
import { driftBlocks, isDrift } from "./style-drift.js";

describe("driftBlocks + isDrift", () => {
  it("geometry-only blocks are free; skin props are drift", () => {
    const src = `
      <div style={{ display: "flex", gap: 8, alignItems: "center" }} />
      <div style={{ background: "var(--color-surface)", padding: 12 }} />
      <span style={{ color: "red" }} />
    `;
    const blocks = driftBlocks(src);
    expect(blocks).toHaveLength(3);
    expect(isDrift(blocks[0]!.keys)).toBe(false); // pure geometry
    expect(isDrift(blocks[1]!.keys)).toBe(true);  // background = skin
    expect(isDrift(blocks[2]!.keys)).toBe(true);  // color = skin
  });

  it("handles spreads, nested expressions and quoted strings", () => {
    const src = `<div style={{ ...ui.card, marginTop: cond ? 10 : 0, borderTop: \`1px solid \${x}\`, gridTemplateColumns: "1fr auto" }} />`;
    const blocks = driftBlocks(src);
    expect(blocks).toHaveLength(1);
    const keys = blocks[0]!.keys;
    expect(keys).toContain("marginTop");
    expect(keys).toContain("borderTop");
    expect(isDrift(keys)).toBe(true); // borderTop = skin (spread ignored)
  });

  it("a spread-only block is not drift (the tokens live behind the spread)", () => {
    const blocks = driftBlocks(`<div style={{ ...ui.h1 }} />`);
    expect(isDrift(blocks[0]!.keys)).toBe(false);
  });
});
