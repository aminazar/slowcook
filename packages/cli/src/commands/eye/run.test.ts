import { describe, it, expect } from "vitest";
import { formatPassLine, withEyeParams, cellLabel } from "./run.js";
import type { EyeContext } from "./plan.js";
import type { FidelityGateResult } from "@slowcook-ai/gates";

const ctx = (over: Partial<EyeContext> = {}): EyeContext => ({
  viewport: "desktop", scheme: "light", width: 1280, height: 800, ...over,
});

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

describe("withEyeParams (§6 locale + §4 scenario)", () => {
  it("returns the url unchanged when neither locale nor scenario applies", () => {
    expect(withEyeParams("http://ref/patient", ctx())).toBe("http://ref/patient");
  });

  it("appends ?lang= for the locale axis", () => {
    expect(withEyeParams("http://ref/p", ctx({ locale: "fa" }))).toBe("http://ref/p?lang=fa");
  });

  it("appends ?scenario= for the shared fixture", () => {
    expect(withEyeParams("http://ref/p", ctx(), "matched-3")).toBe("http://ref/p?scenario=matched-3");
  });

  it("merges into an existing query (e.g. ?__preview=1) without clobbering it", () => {
    const out = withEyeParams("http://ref/p?__preview=1", ctx({ locale: "en" }), "empty");
    expect(out).toContain("__preview=1");
    expect(out).toContain("lang=en");
    expect(out).toContain("scenario=empty");
  });

  it("overwrites a stale lang param rather than duplicating it", () => {
    expect(withEyeParams("http://ref/p?lang=en", ctx({ locale: "fa" }))).toBe("http://ref/p?lang=fa");
  });
});

describe("cellLabel", () => {
  it("is viewport-scheme without a locale", () => {
    expect(cellLabel(ctx({ viewport: "mobile", scheme: "dark" }))).toBe("mobile-dark");
  });
  it("appends the locale when present", () => {
    expect(cellLabel(ctx({ viewport: "mobile", scheme: "dark", locale: "fa" }))).toBe("mobile-dark-fa");
  });
});
