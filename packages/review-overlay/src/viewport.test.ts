import { describe, it, expect } from "vitest";
import { isPillOffViewport, clampPillPosition } from "./selector.js";

describe("isPillOffViewport", () => {
  const VW = 1000, VH = 800;
  it("is false for an on-screen position", () => {
    expect(isPillOffViewport(12, 12, VW, VH)).toBe(false);
    expect(isPillOffViewport(500, 400, VW, VH)).toBe(false);
  });
  it("is true when dragged/stranded off the right or bottom", () => {
    expect(isPillOffViewport(1200, 12, VW, VH)).toBe(true);   // off right
    expect(isPillOffViewport(12, 900, VW, VH)).toBe(true);    // off bottom
  });
  it("is true for negative (off top/left) coordinates", () => {
    expect(isPillOffViewport(-2000, 12, VW, VH)).toBe(true);  // the old -2000 drag floor
    expect(isPillOffViewport(12, -50, VW, VH)).toBe(true);
  });
  it("treats a position flush to the edge (within margin) as off-screen", () => {
    expect(isPillOffViewport(VW - 4, 12, VW, VH)).toBe(true); // <8px visible
    expect(isPillOffViewport(VW - 20, 12, VW, VH)).toBe(false);
  });
});

describe("clampPillPosition", () => {
  const VW = 1000, VH = 800;
  it("leaves an in-bounds position unchanged", () => {
    expect(clampPillPosition(300, 200, VW, VH)).toEqual({ left: 300, top: 200 });
  });
  it("clamps a negative position back to the top-left edge", () => {
    expect(clampPillPosition(-500, -500, VW, VH)).toEqual({ left: 0, top: 0 });
  });
  it("keeps a sliver visible at the right/bottom edges", () => {
    expect(clampPillPosition(5000, 5000, VW, VH)).toEqual({ left: VW - 40, top: VH - 30 });
  });
  it("never returns a negative coordinate even in a tiny viewport", () => {
    const { left, top } = clampPillPosition(10, 10, 20, 10);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
  });
});
