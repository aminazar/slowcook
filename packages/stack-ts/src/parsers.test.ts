import {
  parsePlaywrightList, describe, it, expect } from "vitest";
import {
  parseVitestList,
  parsePlaywrightList,
  parseByReporterFormat,
} from "./parsers.js";

const SAMPLE = `src/lib/links/normalize.test.ts > normalizeUrl > enforces https
src/lib/links/normalize.test.ts > normalizeUrl > adds https when no protocol
src/lib/links/normalize.test.ts > extractDomain > returns empty string for invalid URL
`;

describe("parseVitestList", () => {
  it("parses real vitest list output", () => {
    const tests = parseVitestList(SAMPLE);
    expect(tests).toHaveLength(3);
    expect(tests[0]).toEqual({
      id: "src/lib/links/normalize.test.ts > normalizeUrl > enforces https",
      file: "src/lib/links/normalize.test.ts",
    });
  });

  it("uses the full line as the id (preserves describe hierarchy)", () => {
    const tests = parseVitestList(
      "tests/a.test.ts > outer > inner > deep > case\n"
    );
    expect(tests[0]?.id).toBe(
      "tests/a.test.ts > outer > inner > deep > case"
    );
    expect(tests[0]?.file).toBe("tests/a.test.ts");
  });

  it("skips empty lines and lines without the separator", () => {
    const tests = parseVitestList(
      "\nsome warning line\n\ntests/a.test.ts > d > t\n"
    );
    expect(tests).toHaveLength(1);
    expect(tests[0]?.file).toBe("tests/a.test.ts");
  });

  it("trims trailing whitespace", () => {
    const tests = parseVitestList("tests/a.test.ts > d > t   \n");
    expect(tests[0]?.id).toBe("tests/a.test.ts > d > t");
  });

  it("handles empty input", () => {
    expect(parseVitestList("")).toEqual([]);
  });

  it("handles test names that contain '>' characters (stable id still works)", () => {
    // file segment is everything before the FIRST ' > ', not the last.
    const tests = parseVitestList(
      "tests/a.test.ts > describes > with > arrows\n"
    );
    expect(tests[0]?.file).toBe("tests/a.test.ts");
    // id preserves the full line so duplicates are still distinguishable
    expect(tests[0]?.id).toBe("tests/a.test.ts > describes > with > arrows");
  });
});

describe("parsePlaywrightList (stub)", () => {
  it("returns [] until full Playwright discovery is implemented (degrade-don't-halt)", () => {
    expect(parsePlaywrightList("anything")).toEqual([]);
  });
});

describe("parseByReporterFormat", () => {
  it("routes vitest-list-lines to vitest parser", () => {
    const tests = parseByReporterFormat("vitest-list-lines", SAMPLE);
    expect(tests).toHaveLength(3);
  });

  it("accepts legacy vitest-json as an alias", () => {
    const tests = parseByReporterFormat("vitest-json", SAMPLE);
    expect(tests).toHaveLength(3);
  });

  it("returns [] for playwright formats until discovery is implemented (degrade-don't-halt)", () => {
    expect(parseByReporterFormat("playwright-list-lines", "")).toEqual([]);
    expect(parseByReporterFormat("playwright-list", "")).toEqual([]);
  });

  it("throws for unknown formats with a helpful message", () => {
    expect(() => parseByReporterFormat("martian-yaml", "")).toThrow(
      /Unknown reporter_format/
    );
  });
});

describe("parsePlaywrightList (2026-08-23 — real implementation)", () => {
  it("parses list lines into vitest-shaped ids with project suffix", () => {
    const out = [
      "Listing tests:",
      "  [chromium-desktop] › tests/acceptance/story-005.spec.ts:21:7 › story-005 /u/<handle> — acceptance › unauthenticated visit redirects to /login",
      "  [chromium-desktop] › tests/acceptance/story-005.spec.ts:34:7 › story-005 /u/<handle> — acceptance › Gate 1: /login page is clean at mobile viewport",
      "Total: 2 tests in 1 file",
    ].join("\n");
    const got = parsePlaywrightList(out);
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual({
      id: "tests/acceptance/story-005.spec.ts > story-005 /u/<handle> — acceptance > unauthenticated visit redirects to /login [chromium-desktop]",
      file: "tests/acceptance/story-005.spec.ts",
    });
  });

  it("returns [] on non-list output instead of throwing", () => {
    expect(parsePlaywrightList("Error: something broke")).toEqual([]);
  });
});
