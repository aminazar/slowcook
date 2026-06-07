import { describe, expect, it } from "vitest";
import { gradeFidelity } from "./gate.js";
import type { ElementSnapshot, SnapshotContext, StyleSnapshot } from "./snapshot.js";

const CTX: SnapshotContext = { viewport: "desktop", scheme: "light" };

function el(
  selector: string,
  styles: Record<string, string> = {},
  box: ElementSnapshot["box"] = { x: 0, y: 0, width: 100, height: 40 }
): ElementSnapshot {
  return { selector, styles, box };
}

function snap(elements: ElementSnapshot[], context: SnapshotContext = CTX): StyleSnapshot {
  return { context, elements };
}

describe("gradeFidelity", () => {
  it("passes a clean pair with no violations", () => {
    const reference = snap([el(".hero", { "padding-top": "16px", color: "rgb(0, 0, 0)" })]);
    const candidate = snap([el(".hero", { "padding-top": "16px", color: "rgb(0, 0, 0)" })]);
    const result = gradeFidelity([{ reference, candidate }]);
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.summary.total).toBe(0);
    expect(result.byContext).toHaveLength(1);
    expect(result.byContext[0].context).toEqual(CTX);
    expect(result.byContext[0].violations).toEqual([]);
    expect(result.byContext[0].summary.total).toBe(0);
  });

  it("fails a pair with a color divergence", () => {
    const reference = snap([el(".cta", { "background-color": "rgb(26, 26, 26)" })]);
    const candidate = snap([el(".cta", { "background-color": "rgb(34, 34, 34)" })]);
    const result = gradeFidelity([{ reference, candidate }]);
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({ axis: "color", property: "background-color" });
    expect(result.summary.byAxis.color).toBe(1);
  });

  it("tolerates up to maxViolations", () => {
    const reference = snap([
      el(".cta", { "padding-top": "16px", color: "rgb(0, 0, 0)" }),
    ]);
    const candidate = snap([
      el(".cta", { "padding-top": "12px", color: "rgb(255, 255, 255)" }),
    ]);
    const result = gradeFidelity([{ reference, candidate }], { maxViolations: 2 });
    expect(result.violations).toHaveLength(2);
    expect(result.passed).toBe(true);
  });

  it("fails when violations exceed maxViolations", () => {
    const reference = snap([
      el(".cta", { "padding-top": "16px", color: "rgb(0, 0, 0)" }),
    ]);
    const candidate = snap([
      el(".cta", { "padding-top": "12px", color: "rgb(255, 255, 255)" }),
    ]);
    const result = gradeFidelity([{ reference, candidate }], { maxViolations: 1 });
    expect(result.violations).toHaveLength(2);
    expect(result.passed).toBe(false);
  });

  it("failOnAxes only counts the listed axes for pass/fail and returned violations", () => {
    // one color violation + one box violation + one computed-style violation
    const reference = snap([
      el(
        ".card",
        { "background-color": "rgb(0, 0, 0)", "padding-top": "16px" },
        { x: 0, y: 0, width: 320, height: 200 }
      ),
    ]);
    const candidate = snap([
      el(
        ".card",
        { "background-color": "rgb(255, 255, 255)", "padding-top": "12px" },
        { x: 0, y: 0, width: 300, height: 200 }
      ),
    ]);
    const result = gradeFidelity([{ reference, candidate }], { failOnAxes: ["color"] });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].axis).toBe("color");
    expect(result.passed).toBe(false);
    expect(result.summary.byAxis).toEqual({
      "computed-style": 0,
      color: 1,
      box: 0,
      missing: 0,
    });
  });

  it("passes when the only violations are on non-failing axes", () => {
    const reference = snap([
      el(".card", { "padding-top": "16px" }, { x: 0, y: 0, width: 320, height: 200 }),
    ]);
    const candidate = snap([
      el(".card", { "padding-top": "12px" }, { x: 0, y: 0, width: 300, height: 200 }),
    ]);
    // box + computed-style diffs exist, but we only fail on color
    const result = gradeFidelity([{ reference, candidate }], { failOnAxes: ["color"] });
    expect(result.violations).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it("aggregates a multi-pair matrix with one byContext entry per pair", () => {
    const mobileCtx: SnapshotContext = { viewport: "mobile", scheme: "light" };
    const darkCtx: SnapshotContext = { viewport: "desktop", scheme: "dark" };

    const pairs = [
      {
        // clean
        reference: snap([el(".hero", { "padding-top": "16px" })], mobileCtx),
        candidate: snap([el(".hero", { "padding-top": "16px" })], mobileCtx),
      },
      {
        // one color diff
        reference: snap([el(".cta", { color: "rgb(0, 0, 0)" })], darkCtx),
        candidate: snap([el(".cta", { color: "rgb(255, 255, 255)" })], darkCtx),
      },
    ];

    const result = gradeFidelity(pairs);
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.summary.total).toBe(1);

    expect(result.byContext).toHaveLength(2);
    expect(result.byContext[0].context).toEqual(mobileCtx);
    expect(result.byContext[0].violations).toEqual([]);
    expect(result.byContext[0].summary.total).toBe(0);
    expect(result.byContext[1].context).toEqual(darkCtx);
    expect(result.byContext[1].violations).toHaveLength(1);
    expect(result.byContext[1].violations[0].context).toEqual(darkCtx);
    expect(result.byContext[1].summary.byAxis.color).toBe(1);
  });

  it("forwards diff options (box tolerance) to diffSnapshots", () => {
    const reference = snap([el(".card", {}, { x: 0, y: 0, width: 320, height: 200 })]);
    const candidate = snap([el(".card", {}, { x: 0, y: 0, width: 325, height: 200 })]);
    const strict = gradeFidelity([{ reference, candidate }]);
    expect(strict.passed).toBe(false);
    const lenient = gradeFidelity([{ reference, candidate }], { diff: { boxTolerancePx: 10 } });
    expect(lenient.passed).toBe(true);
    expect(lenient.violations).toEqual([]);
  });

  it("passes with empty pairs", () => {
    const result = gradeFidelity([]);
    expect(result.passed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.summary.total).toBe(0);
    expect(result.byContext).toEqual([]);
  });
});
