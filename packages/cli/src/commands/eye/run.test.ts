import { describe, it, expect } from "vitest";
import { formatPassLine } from "./run.js";
import type { FidelityGateResult } from "@slowcook-ai/gates";

const res = (count: number, passed: boolean): FidelityGateResult => ({
  passed,
  violations: Array.from({ length: count }, () => ({
    selector: ".x", axis: "color", property: "color",
    expected: "a", actual: "b", evidence: "x",
    context: { viewport: "mobile", scheme: "dark" },
  })),
  summary: { total: count, byAxis: { "computed-style": 0, color: count, box: 0, missing: 0 } },
  byContext: [],
});

describe("formatPassLine (sc#189 watch loop)", () => {
  it("omits the delta on the first pass (no previous total)", () => {
    const line = formatPassLine(1, null, res(7, false));
    expect(line).toContain("pass 1: 7 violation(s)");
    expect(line).not.toContain("Δ");
    expect(line).toContain("FAIL");
  });

  it("shows a negative delta as violations shrink", () => {
    expect(formatPassLine(2, 7, res(3, false))).toContain("(Δ-4)");
  });

  it("shows +0 when unchanged and PASS at zero", () => {
    expect(formatPassLine(3, 3, res(3, false))).toContain("(Δ+0)");
    const conv = formatPassLine(4, 3, res(0, true));
    expect(conv).toContain("0 violation(s) (Δ-3)");
    expect(conv).toContain("PASS");
  });

  it("includes the per-axis summary", () => {
    expect(formatPassLine(1, null, res(2, false))).toContain('"color":2');
  });
});
