import { describe, it, expect } from "vitest";
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
  it("throws with a clear message until implemented", () => {
    expect(() => parsePlaywrightList("anything")).toThrow(
      /Playwright discovery is not implemented/
    );
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

  it("throws for playwright formats (not yet implemented)", () => {
    expect(() => parseByReporterFormat("playwright-list-lines", "")).toThrow(
      /Playwright discovery is not implemented/
    );
  });

  it("throws for unknown formats with a helpful message", () => {
    expect(() => parseByReporterFormat("martian-yaml", "")).toThrow(
      /Unknown reporter_format/
    );
  });
});
