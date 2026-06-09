import { describe, it, expect } from "vitest";
import { computeGreenfieldStatus, type GreenfieldInput } from "./status.js";

const base: GreenfieldInput = {
  prdInitiatives: 3,
  specs: [
    { storyId: "001", anchored: true, addressableQuestions: 0, hasLcr: true },
    { storyId: "002", anchored: true, addressableQuestions: 0, hasLcr: true },
  ],
  brandPresent: true,
  traceViolations: 0,
};

describe("computeGreenfieldStatus", () => {
  it("reports scope-complete when every stage is done", () => {
    const s = computeGreenfieldStatus(base);
    expect(s.scopeComplete).toBe(true);
    expect(s.stages.every((st) => st.done)).toBe(true);
    expect(s.nextAction).toMatch(/ready for backend/i);
  });

  it("next action is `menu` when the PRD exists but no stories", () => {
    const s = computeGreenfieldStatus({ ...base, specs: [] });
    expect(s.scopeComplete).toBe(false);
    expect(s.nextAction).toMatch(/slowcook menu/);
  });

  it("next action is to write the PRD when there's none", () => {
    const s = computeGreenfieldStatus({ ...base, prdInitiatives: 0, specs: [] });
    expect(s.nextAction).toMatch(/Write the PRD/);
  });

  it("flags provenance gaps before brand", () => {
    const s = computeGreenfieldStatus({
      ...base,
      brandPresent: false,
      specs: [{ storyId: "001", anchored: false, addressableQuestions: 0, hasLcr: false }],
    });
    expect(s.nextAction).toMatch(/provenance gap/i);
  });

  it("points at the next un-vibed story", () => {
    const s = computeGreenfieldStatus({
      ...base,
      specs: [
        { storyId: "001", anchored: true, addressableQuestions: 0, hasLcr: true },
        { storyId: "007", anchored: true, addressableQuestions: 0, hasLcr: false },
      ],
    });
    expect(s.nextAction).toMatch(/Vibe story-007/);
    expect(s.stages.find((st) => st.name === "LCR (vibe×eye)")!.detail).toBe("1/2 stories vibed");
  });

  it("blocks scope-complete on addressable open questions even when everything else is done", () => {
    const s = computeGreenfieldStatus({
      ...base,
      specs: [{ storyId: "001", anchored: true, addressableQuestions: 2, hasLcr: true }],
    });
    expect(s.scopeComplete).toBe(false);
    expect(s.nextAction).toMatch(/2 addressable open question/);
  });

  it("surfaces trace violations before open questions", () => {
    const s = computeGreenfieldStatus({ ...base, traceViolations: 3 });
    expect(s.nextAction).toMatch(/trace check/i);
  });
});
