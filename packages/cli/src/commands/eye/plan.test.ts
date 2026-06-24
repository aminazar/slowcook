import { describe, it, expect } from "vitest";
import {
  parseEyeArgs, DEFAULT_MATRIX, VIEWPORTS, matrixFromModes, narrowMatrix,
  localesFromModes, applyLocaleAxis,
} from "./plan.js";

const base = ["--reference", "http://ref", "--candidate", "http://cand"];

const cell = (c: { viewport: string; scheme: string; locale?: string }) =>
  `${c.viewport}-${c.scheme}${c.locale ? `-${c.locale}` : ""}`;

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

  it("narrows a locale axis when the matrix already has one (CLI can't widen the spec)", () => {
    const m = applyLocaleAxis([{ viewport: "mobile", scheme: "light", width: 390, height: 844 }], ["fa", "en"]);
    expect(narrowMatrix(m, { locales: ["fa"] }).map(cell)).toEqual(["mobile-light-fa"]);
  });

  it("ignores --locale when the matrix has no locale dimension (opt-in happens elsewhere)", () => {
    expect(narrowMatrix(DEFAULT_MATRIX, { locales: ["fa"] }).map(cell).sort()).toEqual(
      DEFAULT_MATRIX.map(cell).sort(),
    );
  });
});

describe("localesFromModes (§6)", () => {
  it("extracts namespaced locale: tokens", () => {
    expect(localesFromModes(["light", "dark", "locale:fa", "locale:en"])).toEqual(["fa", "en"]);
  });
  it("is case-insensitive, trims, ignores non-locale tokens", () => {
    expect(localesFromModes([" Locale:FA ", "mobile"])).toEqual(["fa"]);
  });
  it("returns [] when none are declared", () => {
    expect(localesFromModes(["light", "mobile"])).toEqual([]);
  });
});

describe("applyLocaleAxis (§6)", () => {
  const oneCell = [{ viewport: "mobile", scheme: "light" as const, width: 390, height: 844 }];

  it("multiplies a locale-less matrix by the locales", () => {
    expect(applyLocaleAxis(oneCell, ["fa", "en"]).map(cell)).toEqual(["mobile-light-fa", "mobile-light-en"]);
  });
  it("narrows an existing locale dimension instead of multiplying", () => {
    const withLoc = applyLocaleAxis(oneCell, ["fa", "en"]);
    expect(applyLocaleAxis(withLoc, ["en"]).map(cell)).toEqual(["mobile-light-en"]);
  });
  it("is a no-op when locales is empty/undefined", () => {
    expect(applyLocaleAxis(oneCell, undefined)).toEqual(oneCell);
    expect(applyLocaleAxis(oneCell, [])).toEqual(oneCell);
  });
});

describe("matrixFromModes — locale axis", () => {
  it("expands viewport × scheme × locale when locale: tokens are present", () => {
    expect(matrixFromModes(["mobile", "dark", "locale:fa", "locale:en"]).map(cell).sort()).toEqual([
      "mobile-dark-en", "mobile-dark-fa",
    ]);
  });
  it("delgoosh's declared 6-of-8 subset: fa full + en light (via two specs is overkill; here the product)", () => {
    // fa × {mobile,desktop} × {light,dark} = 4 ; declaring locale alone keeps viewport/scheme full
    expect(matrixFromModes(["locale:fa"]).length).toBe(4);
  });
  it("no locale token → no locale dimension (unchanged behaviour)", () => {
    expect(matrixFromModes(["mobile", "dark"]).every((c) => c.locale == null)).toBe(true);
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

  it("adds a locale axis from --locale (CLI opts the axis in on the default matrix)", () => {
    const o = parseEyeArgs([...base, "--locale", "fa,en"]);
    expect(o.locales).toEqual(["fa", "en"]);
    expect(o.matrix).toHaveLength(8); // 4 cells × 2 locales
    expect(o.matrix.map(cell)).toContain("desktop-light-fa");
    expect(o.matrix.map(cell)).toContain("mobile-dark-en");
  });

  it("--locale composes with --viewport/--scheme narrowing", () => {
    const o = parseEyeArgs([...base, "--viewport", "mobile", "--scheme", "dark", "--locale", "fa,en"]);
    expect(o.matrix.map(cell).sort()).toEqual(["mobile-dark-en", "mobile-dark-fa"]);
  });

  it("records --scenario for the shared-fixture data adaptor (§4)", () => {
    expect(parseEyeArgs([...base, "--scenario", "matched-3"]).scenario).toBe("matched-3");
    expect(parseEyeArgs(base).scenario).toBeUndefined();
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
