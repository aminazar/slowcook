import { describe, it, expect } from "vitest";
import { INVESTIGATE_SYSTEM } from "./investigate.js";

describe("advisory triage (docs/LCR-TRIAGE.md)", () => {
  it("classifies as suggestion only, refuses profiles for gaps, and demands reproduction first", () => {
    expect(INVESTIGATE_SYSTEM).toContain("which artifact does reality contradict?");
    expect(INVESTIGATE_SYSTEM).toContain("SUGGESTION with evidence");
    expect(INVESTIGATE_SYSTEM).toContain("Do NOT emit a bug profile for a gap");
    expect(INVESTIGATE_SYSTEM).toContain("green covering test over a true violation is itself defective");
    expect(INVESTIGATE_SYSTEM).toContain("Reproduction before questions");
  });
});
