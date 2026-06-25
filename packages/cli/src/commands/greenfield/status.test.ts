import { describe, it, expect } from "vitest";
import { computeGreenfieldStatus, type GreenfieldInput, type GreenfieldLcr } from "./status.js";

const builtLcr: GreenfieldLcr = {
  surfacesDeclared: 2,
  entities: 5,
  conflicts: 0,
  schemaPresent: true,
  dataAdaptorPresent: true,
  appPresent: true,
  surfacesBuilt: 2,
};

const base: GreenfieldInput = {
  prdInitiatives: 3,
  specs: [
    { storyId: "001", anchored: true, addressableQuestions: 0 },
    { storyId: "002", anchored: true, addressableQuestions: 0 },
  ],
  brandPresent: true,
  traceViolations: 0,
  lcr: builtLcr,
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
      specs: [{ storyId: "001", anchored: false, addressableQuestions: 0 }],
    });
    expect(s.nextAction).toMatch(/provenance gap/i);
  });

  it("walks the whole-app LCR ladder: schema → adaptor → app → surfaces", () => {
    const noSchema = computeGreenfieldStatus({ ...base, lcr: { ...builtLcr, schemaPresent: false, dataAdaptorPresent: false, appPresent: false, surfacesBuilt: 0 } });
    expect(noSchema.nextAction).toMatch(/vibe schema/);

    const noAdaptor = computeGreenfieldStatus({ ...base, lcr: { ...builtLcr, dataAdaptorPresent: false, appPresent: false, surfacesBuilt: 0 } });
    expect(noAdaptor.nextAction).toMatch(/vibe seed/);

    const noApp = computeGreenfieldStatus({ ...base, lcr: { ...builtLcr, appPresent: false, surfacesBuilt: 0 } });
    expect(noApp.nextAction).toMatch(/vibe app/);

    const partial = computeGreenfieldStatus({ ...base, lcr: { ...builtLcr, surfacesBuilt: 1 } });
    expect(partial.nextAction).toMatch(/1\/2 surfaces built/);
    expect(partial.stages.find((st) => st.name === "LCR (whole-app)")!.done).toBe(false);
  });

  it("blocks the LCR on data-model conflicts before schema-gen", () => {
    const s = computeGreenfieldStatus({ ...base, lcr: { ...builtLcr, conflicts: 2, schemaPresent: false, appPresent: false, surfacesBuilt: 0 } });
    expect(s.nextAction).toMatch(/2 data-model conflict/);
  });

  it("LCR detail shows the staged build state", () => {
    const s = computeGreenfieldStatus({ ...base, lcr: { ...builtLcr, appPresent: false, surfacesBuilt: 0 } });
    expect(s.stages.find((st) => st.name === "LCR (whole-app)")!.detail).toMatch(/schema ✓ · adaptor ✓ · app ✗ · 0\/2 surfaces/);
  });

  it("blocks scope-complete on addressable open questions even when everything else is done", () => {
    const s = computeGreenfieldStatus({
      ...base,
      specs: [{ storyId: "001", anchored: true, addressableQuestions: 2 }],
      lcr: { ...builtLcr, surfacesDeclared: 1, surfacesBuilt: 1 },
    });
    expect(s.scopeComplete).toBe(false);
    expect(s.nextAction).toMatch(/2 addressable open question/);
  });

  it("surfaces trace violations before open questions", () => {
    const s = computeGreenfieldStatus({ ...base, traceViolations: 3 });
    expect(s.nextAction).toMatch(/trace check/i);
  });
});
