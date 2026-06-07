import { describe, it, expect } from "vitest";
import {
  extractElementClasses,
  isUtilityShaped,
  synthesiseShapeTestFile,
  type ExtractedShape,
} from "./shape-preserve.js";

describe("isUtilityShaped (design #10)", () => {
  it("keeps lowercase bare utilities", () => {
    for (const t of ["flex", "grid", "block", "hidden", "relative"]) {
      expect(isUtilityShaped(t)).toBe(true);
    }
  });
  it("keeps dashed / colon / bracket utilities", () => {
    for (const t of ["bg-primary", "px-4", "hover:bg-primary/90", "min-h-[44px]", "focus-visible:ring-2"]) {
      expect(isUtilityShaped(t)).toBe(true);
    }
  });
  it("drops capitalised identifiers + empties", () => {
    for (const t of ["Button", "Root", ""]) {
      expect(isUtilityShaped(t)).toBe(false);
    }
  });
});

describe("extractElementClasses (design #10)", () => {
  it("extracts the FULL utility set, not just an allowlist subset", () => {
    const src = `<button data-testid="cta" className="bg-primary px-4 py-3 text-sm font-medium shadow-md gap-2 rounded-lg">Go</button>`;
    const facts = extractElementClasses(src);
    expect(facts).toHaveLength(1);
    expect(facts[0].testid).toBe("cta");
    // every token is captured — the pre-#10 allowlist would only keep rounded-lg
    expect(facts[0].tokens).toEqual([
      "bg-primary", "px-4", "py-3", "text-sm", "font-medium", "shadow-md", "gap-2", "rounded-lg",
    ]);
  });

  it("keeps state + responsive variant tokens", () => {
    const src = `<a data-testid="link" className="text-blue-600 hover:underline md:text-lg focus-visible:ring-2">x</a>`;
    expect(extractElementClasses(src)[0].tokens).toEqual([
      "text-blue-600", "hover:underline", "md:text-lg", "focus-visible:ring-2",
    ]);
  });

  it("records null testid for unanchored elements (with tokens)", () => {
    const facts = extractElementClasses(`<div className="flex gap-2">x</div>`);
    expect(facts).toEqual([{ testid: null, tokens: ["flex", "gap-2"] }]);
  });

  it("skips dynamic / CSS-module classNames (paradigm-aware — avoids over-extraction)", () => {
    expect(extractElementClasses(`<div className={styles.root}>x</div>`)).toEqual([]);
    expect(extractElementClasses(`<div className={cx("a", cond && "b")}>x</div>`)).toEqual([]);
    expect(extractElementClasses("<div className={`p-2 ${active ? 'on' : 'off'}`}>x</div>")).toEqual([]);
  });

  it("reads a plain backtick literal (no interpolation)", () => {
    expect(extractElementClasses("<div className=`flex p-4`>x</div>")[0].tokens).toEqual(["flex", "p-4"]);
  });

  it("dedupes repeated tokens on one element", () => {
    expect(extractElementClasses(`<div className="flex flex gap-2">x</div>`)[0].tokens).toEqual(["flex", "gap-2"]);
  });

  it("ignores elements with no utility tokens", () => {
    expect(extractElementClasses(`<span>plain</span>`)).toEqual([]);
  });
});

describe("synthesiseShapeTestFile — #10 containment emission", () => {
  const shape: ExtractedShape = {
    file: "mock/src/components/Cta.tsx",
    componentName: "Cta",
    testids: ["cta"],
    visualTokens: ["rounded-lg"],
    hasHeader: false,
    elementClasses: [{ testid: "cta", tokens: ["bg-primary", "px-4", "rounded-lg"] }],
  };

  it("v2 emits per-testid containment that keeps the mock token set", () => {
    const out = synthesiseShapeTestFile({ story: "020", emitMode: "v2", shapes: [shape] });
    expect(out).toContain("[data-testid=cta] keeps mock class tokens");
    expect(out).toContain(`queryByTestId("cta")`);
    expect(out).toContain(`["bg-primary","px-4","rounded-lg"].filter((t) => !have.includes(t))`);
    expect(out).toContain(`expect(missing, "dropped mock class tokens").toEqual([]);`);
  });

  it("v1 emits dense file-level token containment for non-allowlist tokens", () => {
    const out = synthesiseShapeTestFile({ story: "020", emitMode: "v1", shapes: [shape] });
    // dense tokens NOT already in visualTokens get a containment assertion
    expect(out).toContain(`preserves mock class token 'bg-primary'`);
    expect(out).toContain(`expect(src).toContain("bg-primary");`);
    expect(out).toContain(`preserves mock class token 'px-4'`);
    // rounded-lg is already a visualToken → not duplicated as a dense token
    expect(out).not.toContain(`preserves mock class token 'rounded-lg'`);
  });

  it("does not emit #10 containment when elementClasses is absent (back-compat)", () => {
    const legacy: ExtractedShape = {
      file: "mock/src/components/Old.tsx",
      componentName: "Old",
      testids: ["old"],
      visualTokens: ["rounded-full"],
      hasHeader: false,
    };
    const out = synthesiseShapeTestFile({ story: "001", emitMode: "v2", shapes: [legacy] });
    expect(out).not.toContain("keeps mock class tokens");
  });
});
