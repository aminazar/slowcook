import { describe, it, expect } from "vitest";
import { isReadOnlyMode } from "./read-only.js";

describe("isReadOnlyMode", () => {
  it("returns false when SLOWCOOK_READ_ONLY is unset", () => {
    expect(isReadOnlyMode({})).toBe(false);
  });

  it("returns true for SLOWCOOK_READ_ONLY=1", () => {
    expect(isReadOnlyMode({ SLOWCOOK_READ_ONLY: "1" })).toBe(true);
  });

  it("returns true for SLOWCOOK_READ_ONLY=true (case-insensitive)", () => {
    expect(isReadOnlyMode({ SLOWCOOK_READ_ONLY: "true" })).toBe(true);
    expect(isReadOnlyMode({ SLOWCOOK_READ_ONLY: "TRUE" })).toBe(true);
    expect(isReadOnlyMode({ SLOWCOOK_READ_ONLY: "True" })).toBe(true);
  });

  it("returns true for SLOWCOOK_READ_ONLY=yes", () => {
    expect(isReadOnlyMode({ SLOWCOOK_READ_ONLY: "yes" })).toBe(true);
  });

  it("returns false for SLOWCOOK_READ_ONLY=0", () => {
    expect(isReadOnlyMode({ SLOWCOOK_READ_ONLY: "0" })).toBe(false);
  });

  it("returns false for SLOWCOOK_READ_ONLY=false", () => {
    expect(isReadOnlyMode({ SLOWCOOK_READ_ONLY: "false" })).toBe(false);
  });

  it("returns false for SLOWCOOK_READ_ONLY=''", () => {
    expect(isReadOnlyMode({ SLOWCOOK_READ_ONLY: "" })).toBe(false);
  });

  it("trims whitespace before evaluating", () => {
    expect(isReadOnlyMode({ SLOWCOOK_READ_ONLY: "  1  " })).toBe(true);
    expect(isReadOnlyMode({ SLOWCOOK_READ_ONLY: "  true\n" })).toBe(true);
  });
});
