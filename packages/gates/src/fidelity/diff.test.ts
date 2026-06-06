import { describe, expect, it } from "vitest";
import { diffSnapshots, summariseFidelity } from "./diff.js";
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

describe("diffSnapshots", () => {
  it("returns no violations for identical snapshots", () => {
    const a = snap([el(".hero", { "padding-top": "16px", color: "rgb(0, 0, 0)" })]);
    const b = snap([el(".hero", { "padding-top": "16px", color: "rgb(0, 0, 0)" })]);
    expect(diffSnapshots(a, b)).toEqual([]);
  });

  it("flags a computed-style divergence with a hard fix-signal", () => {
    const ref = snap([el(".cta", { "padding-top": "16px" })]);
    const cand = snap([el(".cta", { "padding-top": "12px" })]);
    const v = diffSnapshots(ref, cand);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      selector: ".cta",
      axis: "computed-style",
      property: "padding-top",
      expected: "16px",
      actual: "12px",
    });
    expect(v[0].evidence).toBe(".cta: padding-top 16px → 12px");
  });

  it("tags color properties with the color axis", () => {
    const ref = snap([el(".cta", { "background-color": "rgb(26, 26, 26)" })]);
    const cand = snap([el(".cta", { "background-color": "rgb(34, 34, 34)" })]);
    const v = diffSnapshots(ref, cand);
    expect(v).toHaveLength(1);
    expect(v[0].axis).toBe("color");
    expect(v[0].property).toBe("background-color");
  });

  it("reports a reference element missing from the candidate", () => {
    const ref = snap([el(".hero"), el(".footer")]);
    const cand = snap([el(".hero")]);
    const v = diffSnapshots(ref, cand);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ selector: ".footer", axis: "missing" });
  });

  it("ignores candidate-only elements (extra prod chrome is allowed)", () => {
    const ref = snap([el(".hero")]);
    const cand = snap([el(".hero"), el(".analytics-pixel")]);
    expect(diffSnapshots(ref, cand)).toEqual([]);
  });

  it("flags box-dimension divergence beyond tolerance", () => {
    const ref = snap([el(".card", {}, { x: 0, y: 0, width: 320, height: 200 })]);
    const cand = snap([el(".card", {}, { x: 0, y: 0, width: 300, height: 200 })]);
    const v = diffSnapshots(ref, cand);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ axis: "box", property: "width" });
    expect(v[0].evidence).toBe(".card: width 320px → 300px (Δ-20px)");
  });

  it("respects box tolerance (sub-pixel jitter ignored)", () => {
    const ref = snap([el(".card", {}, { x: 0, y: 0, width: 320, height: 200 })]);
    const cand = snap([el(".card", {}, { x: 0, y: 0, width: 321, height: 200 })]);
    expect(diffSnapshots(ref, cand, { boxTolerancePx: 1 })).toEqual([]);
  });

  it("does not flag a candidate style key absent from the reference", () => {
    // reference is the contract; only graded reference props are compared
    const ref = snap([el(".hero", { color: "rgb(0, 0, 0)" })]);
    const cand = snap([el(".hero", { color: "rgb(0, 0, 0)", opacity: "0.5" })]);
    expect(diffSnapshots(ref, cand)).toEqual([]);
  });

  it("matches the first candidate occurrence for a duplicated selector", () => {
    const ref = snap([el(".item", { color: "rgb(0, 0, 0)" })]);
    const cand = snap([
      el(".item", { color: "rgb(0, 0, 0)" }),
      el(".item", { color: "rgb(255, 0, 0)" }),
    ]);
    expect(diffSnapshots(ref, cand)).toEqual([]);
  });

  it("carries the reference capture context onto every violation", () => {
    const ctx: SnapshotContext = { viewport: "mobile", scheme: "dark", step: "after:click submit" };
    const ref = snap([el(".cta", { "padding-top": "16px" })], ctx);
    const cand = snap([el(".cta", { "padding-top": "12px" })], ctx);
    expect(diffSnapshots(ref, cand)[0].context).toEqual(ctx);
  });

  it("accumulates multiple violations on one element", () => {
    const ref = snap([el(".cta", { "padding-top": "16px", color: "rgb(0, 0, 0)" })]);
    const cand = snap([el(".cta", { "padding-top": "12px", color: "rgb(255, 255, 255)" })]);
    expect(diffSnapshots(ref, cand)).toHaveLength(2);
  });
});

describe("summariseFidelity", () => {
  it("counts total + per-axis", () => {
    const ref = snap([
      el(".cta", { "padding-top": "16px", color: "rgb(0, 0, 0)" }, { x: 0, y: 0, width: 320, height: 40 }),
      el(".gone"),
    ]);
    const cand = snap([
      el(".cta", { "padding-top": "12px", color: "rgb(255, 255, 255)" }, { x: 0, y: 0, width: 300, height: 40 }),
    ]);
    const summary = summariseFidelity(diffSnapshots(ref, cand));
    expect(summary).toEqual({
      total: 4,
      byAxis: { "computed-style": 1, color: 1, box: 1, missing: 1 },
    });
  });

  it("zeroes cleanly for no violations", () => {
    expect(summariseFidelity([])).toEqual({
      total: 0,
      byAxis: { "computed-style": 0, color: 0, box: 0, missing: 0 },
    });
  });
});
