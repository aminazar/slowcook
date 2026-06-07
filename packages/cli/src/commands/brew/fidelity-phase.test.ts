import { describe, it, expect } from "vitest";
import type { FidelityViolation } from "@slowcook-ai/gates";
import { formatViolationsForBrew, runFidelityPhase } from "./fidelity-phase.js";

const v = (over: Partial<FidelityViolation> = {}): FidelityViolation => ({
  selector: ".cta",
  axis: "color",
  property: "background-color",
  expected: "rgb(14, 38, 32)",
  actual: "rgb(255, 255, 255)",
  evidence: ".cta: background-color rgb(14, 38, 32) → rgb(255, 255, 255)",
  context: { viewport: "mobile", scheme: "dark" },
  ...over,
});

describe("formatViolationsForBrew", () => {
  it("groups by viewport/scheme and scopes to presentation-only edits", () => {
    const out = formatViolationsForBrew([
      v(),
      v({ selector: ".hero", property: "color", context: { viewport: "mobile", scheme: "dark" } }),
      v({ context: { viewport: "desktop", scheme: "light" } }),
    ]);
    expect(out).toContain("## mobile/dark");
    expect(out).toContain("## desktop/light");
    expect(out).toContain("`.cta`: background-color should be rgb(14, 38, 32)");
    expect(out).toMatch(/do not\s+change behaviour/i);
  });

  it("handles the empty case", () => {
    expect(formatViolationsForBrew([])).toBe("No fidelity violations.");
  });
});

describe("runFidelityPhase — gate-only (no applyFix)", () => {
  it("passes when the eye reports no drift", async () => {
    const r = await runFidelityPhase({ cwd: "/x", measure: async () => [] });
    expect(r).toMatchObject({ converged: true, escalated: false, gateAction: "pass", iterations: 1 });
    expect(r.matrixCells).toBe(4); // default matrix, no story
  });

  it("escalates to the designer gate on drift", async () => {
    const r = await runFidelityPhase({ cwd: "/x", measure: async () => [v()] });
    expect(r).toMatchObject({ converged: false, escalated: true, gateAction: "blocked-on-designer" });
    expect(r.remaining).toHaveLength(1);
  });
});

describe("runFidelityPhase — driving (applyFix supplied)", () => {
  it("converges: drift then clean → pass, applyFix called once", async () => {
    const measures = [[v()], []];
    let fixes = 0;
    const r = await runFidelityPhase({
      cwd: "/x",
      measure: async () => measures.shift() ?? [],
      applyFix: async () => { fixes++; },
    });
    expect(r).toMatchObject({ converged: true, gateAction: "pass" });
    expect(fixes).toBe(1);
  });

  it("escalates when the loop stalls (no improvement)", async () => {
    const r = await runFidelityPhase({
      cwd: "/x",
      measure: async () => [v()], // never improves
      applyFix: async () => {},
      maxIters: 6,
    });
    expect(r).toMatchObject({ escalated: true, gateAction: "blocked-on-designer" });
    expect(r.reason).toBe("stalled");
  });
});
