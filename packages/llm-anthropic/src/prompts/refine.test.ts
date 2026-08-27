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

describe("S2 clarify gate (#527, adapted from Spec Kit)", () => {
  const system = REFINEMENT_ANALYST_SYSTEM("checklist", "ctx");

  it("carries the vendored 9-category coverage scan with attribution", () => {
    expect(system).toContain("Coverage scan before every round");
    expect(system).toContain("github.com/github/spec-kit");
    expect(system).toContain("functional scope & behavior");
    expect(system).toContain("completion signals");
    expect(system).toContain("Clear / Partial / Missing");
  });

  it("question trees: fork-only nesting, node budget, walked-path pruning, recommended marks, don't-know routing", () => {
    expect(system).toContain("Nest only at a true fork");
    expect(system).toContain("≤6 question nodes total per round");
    expect(system).toContain("un-walked branches are pruned");
    expect(system).toContain("(recommended)");
    expect(system).toContain('"I don\'t know" is a valid answer');
  });

  it("spec schema demands the verbatim clarifications log", () => {
    expect(system).toContain("clarifications?:");
    expect(system).toContain("VERBATIM");
    expect(system).toContain("a paraphrase here is a defect");
  });
});

describe("S2 amendment discipline", () => {
  it("amendments treat clarifications as append-only verbatim law", async () => {
    const { AMENDMENT_SYSTEM } = await import("./refine.js");
    const amend = AMENDMENT_SYSTEM("ctx");
    expect(amend).toContain("`clarifications` is append-only");
    expect(amend).toContain("never edit, reword, or delete");
  });
});
