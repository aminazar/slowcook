import { describe, it, expect } from "vitest";
import { REFINEMENT_ANALYST_SYSTEM } from "./refine.js";


describe("existing-behavior evidence rule (2026-08-24)", () => {
  it("the analyst system prompt demands extract citations for claims about current code", () => {
    const system = REFINEMENT_ANALYST_SYSTEM("checklist", "ctx");
    expect(system).toContain("Existing-behavior claims need evidence");
    expect(system).toContain("ASSUMPTION (unverified against extracts)");
    expect(system).toContain("treat the capability as NOT existing");
  });
});
