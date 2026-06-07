import { describe, it, expect } from "vitest";
import { parseEyeArgs, DEFAULT_MATRIX, VIEWPORTS, matrixFromModes, narrowMatrix } from "./plan.js";

const base = ["--reference", "http://ref", "--candidate", "http://cand"];

const cell = (c: { viewport: string; scheme: string }) => `${c.viewport}-${c.scheme}`;

describe("matrixFromModes", () => {
  it("expands a full mode list to the 4-cell product", () => {
    expect(matrixFromModes(["light", "dark", "mobile", "desktop"]).map(cell).sort()).toEqual([
      "desktop-dark", "desktop-light", "mobile-dark", "mobile-light",
    ]);
  });

  it("a scheme-only mode defaults the viewport dimension to its full set", () => {
    expect(matrixFromModes(["dark"]).map(cell).sort()).toEqual(["desktop-dark", "mobile-dark"]);
  });

  it("a viewport-only mode defaults the scheme dimension to its full set", () => {
    expect(matrixFromModes(["mobile"]).map(cell).sort()).toEqual(["mobile-dark", "mobile-light"]);
  });

  it("an explicit single cell yields one cell", () => {
    expect(matrixFromModes(["mobile", "dark"]).map(cell)).toEqual(["mobile-dark"]);
  });

  it("is case-insensitive and trims", () => {
    expect(matrixFromModes([" Dark ", "MOBILE"]).map(cell)).toEqual(["mobile-dark"]);
  });

  it("ignores unrecognised tokens; all-garbage fails open to the full matrix", () => {
    expect(matrixFromModes(["dark", "tablet"]).map(cell).sort()).toEqual(["desktop-dark", "mobile-dark"]);
    expect(matrixFromModes(["watch", "sepia"]).length).toBe(DEFAULT_MATRIX.length);
  });

  it("carries real pixel dimensions", () => {
    expect(matrixFromModes(["mobile", "dark"])[0]!.width).toBe(VIEWPORTS.mobile!.width);
  });
});

describe("narrowMatrix", () => {
  it("filters by viewport + scheme and validates", () => {
    expect(narrowMatrix(DEFAULT_MATRIX, { scheme: "dark" }).map(cell).sort()).toEqual(["desktop-dark", "mobile-dark"]);
    expect(narrowMatrix(DEFAULT_MATRIX, { viewport: "mobile", scheme: "light" }).map(cell)).toEqual(["mobile-light"]);
    expect(() => narrowMatrix(DEFAULT_MATRIX, { viewport: "watch" })).toThrow(/unknown --viewport/);
    expect(() => narrowMatrix(DEFAULT_MATRIX, { scheme: "sepia" })).toThrow(/light\|dark/);
  });
});

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

  it("records --story and --cwd for spec-driven matrix resolution", () => {
    const o = parseEyeArgs([...base, "--story", "020", "--cwd", "/repo"]);
    expect(o.story).toBe("020");
    expect(o.cwd).toBe("/repo");
    // matrix is still the flag default until the runner reads the spec
    expect(o.matrix).toHaveLength(4);
  });

  it("defaults watch off with sane interval/max-passes", () => {
    const o = parseEyeArgs(base);
    expect(o.watch).toBe(false);
    expect(o.intervalMs).toBe(2000);
    expect(o.untilConverged).toBe(false);
    expect(o.maxPasses).toBe(60);
  });

  it("parses --watch + --interval + --until-converged + --max-passes (sc#189)", () => {
    const o = parseEyeArgs([...base, "--watch", "--interval", "500", "--until-converged", "--max-passes", "10"]);
    expect(o.watch).toBe(true);
    expect(o.intervalMs).toBe(500);
    expect(o.untilConverged).toBe(true);
    expect(o.maxPasses).toBe(10);
  });

  it("DEFAULT_MATRIX is the 4-cell product", () => {
    expect(DEFAULT_MATRIX).toHaveLength(4);
  });
});
