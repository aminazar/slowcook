import { describe, it, expect } from "vitest";
import { parseEyeArgs, DEFAULT_MATRIX, VIEWPORTS } from "./plan.js";

const base = ["--reference", "http://ref", "--candidate", "http://cand"];

describe("parseEyeArgs", () => {
  it("requires --reference and --candidate", () => {
    expect(() => parseEyeArgs([])).toThrow(/reference/);
    expect(() => parseEyeArgs(["--reference", "x"])).toThrow(/candidate/);
  });

  it("defaults to the full mobile/desktop × light/dark matrix + .brewing/eye", () => {
    const o = parseEyeArgs(base);
    expect(o.referenceUrl).toBe("http://ref");
    expect(o.candidateUrl).toBe("http://cand");
    expect(o.outDir).toBe(".brewing/eye");
    expect(o.matrix).toHaveLength(4);
    expect(o.matrix.map((c) => `${c.viewport}-${c.scheme}`).sort()).toEqual([
      "desktop-dark", "desktop-light", "mobile-dark", "mobile-light",
    ]);
  });

  it("attaches real pixel dimensions per viewport", () => {
    const o = parseEyeArgs([...base, "--viewport", "mobile"]);
    expect(o.matrix.every((c) => c.width === VIEWPORTS.mobile.width)).toBe(true);
  });

  it("narrows the matrix by --viewport and --scheme", () => {
    expect(parseEyeArgs([...base, "--viewport", "desktop"]).matrix).toHaveLength(2);
    expect(parseEyeArgs([...base, "--scheme", "dark"]).matrix).toHaveLength(2);
    const one = parseEyeArgs([...base, "--viewport", "mobile", "--scheme", "dark"]).matrix;
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ viewport: "mobile", scheme: "dark" });
  });

  it("rejects unknown viewport / scheme", () => {
    expect(() => parseEyeArgs([...base, "--viewport", "watch"])).toThrow(/unknown --viewport/);
    expect(() => parseEyeArgs([...base, "--scheme", "sepia"])).toThrow(/light\|dark/);
  });

  it("maps --max-violations and --fail-on into gate options", () => {
    const o = parseEyeArgs([...base, "--max-violations", "3", "--fail-on", "color,box"]);
    expect(o.gate.maxViolations).toBe(3);
    expect(o.gate.failOnAxes).toEqual(["color", "box"]);
  });

  it("DEFAULT_MATRIX is the 4-cell product", () => {
    expect(DEFAULT_MATRIX).toHaveLength(4);
  });
});
