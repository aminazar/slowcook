import { describe, it, expect } from "vitest";
import { checkFrozenPaths } from "./frozen-paths.js";

describe("checkFrozenPaths", () => {
  describe("directory rules", () => {
    it("returns no violations for unrelated files", () => {
      const result = checkFrozenPaths(
        [{ path: "src/foo.ts" }, { path: "README.md" }],
        { directories: ["tests/"] }
      );
      expect(result).toEqual([]);
    });

    it("catches changes under a frozen directory (with trailing slash)", () => {
      const result = checkFrozenPaths(
        [{ path: "tests/story-042.test.ts" }],
        { directories: ["tests/"] }
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        file: "tests/story-042.test.ts",
        rule: "directory tests/",
      });
    });

    it("catches changes under a frozen directory (without trailing slash)", () => {
      const result = checkFrozenPaths([{ path: "tests/a/b.ts" }], {
        directories: ["tests"],
      });
      expect(result).toHaveLength(1);
    });

    it("does not match directory prefix on similarly-named files", () => {
      // "tests-fake.ts" is NOT under "tests/"
      const result = checkFrozenPaths([{ path: "tests-fake.ts" }], {
        directories: ["tests/"],
      });
      expect(result).toEqual([]);
    });

    it("reports each file only once per directory match", () => {
      const result = checkFrozenPaths([{ path: "tests/a.ts" }], {
        directories: ["tests/", "tests/"],
      });
      // Same dir listed twice shouldn't produce two violations
      expect(result).toHaveLength(1);
    });
  });

  describe("exact file rules", () => {
    it("catches edits to an exact frozen file", () => {
      const result = checkFrozenPaths([{ path: "vitest.config.ts" }], {
        files: ["vitest.config.ts"],
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.rule).toContain("vitest.config.ts");
    });

    it("ignores files not in the exact list", () => {
      const result = checkFrozenPaths([{ path: "vitest.config.mjs" }], {
        files: ["vitest.config.ts"],
      });
      expect(result).toEqual([]);
    });
  });

  describe("partial rules (JSON key freeze)", () => {
    it("catches changes to a frozen JSON key path", () => {
      const result = checkFrozenPaths(
        [
          {
            path: "package.json",
            baseContent: JSON.stringify({ scripts: { test: "vitest run" } }),
            headContent: JSON.stringify({
              scripts: { test: "vitest run --reporter=verbose" },
            }),
          },
        ],
        { partial: { "package.json": { frozen_key_paths: ["scripts.test"] } } }
      );
      expect(result).toHaveLength(1);
      expect(result[0]?.rule).toContain("scripts.test");
    });

    it("allows changes to non-frozen keys in the same file", () => {
      const result = checkFrozenPaths(
        [
          {
            path: "package.json",
            baseContent: JSON.stringify({
              scripts: { test: "vitest run", dev: "next dev" },
            }),
            headContent: JSON.stringify({
              scripts: { test: "vitest run", dev: "next dev --port 3001" },
            }),
          },
        ],
        { partial: { "package.json": { frozen_key_paths: ["scripts.test"] } } }
      );
      expect(result).toEqual([]);
    });

    it("treats frozen key deletion as a violation", () => {
      const result = checkFrozenPaths(
        [
          {
            path: "package.json",
            baseContent: JSON.stringify({ scripts: { test: "vitest run" } }),
            headContent: JSON.stringify({ scripts: {} }),
          },
        ],
        { partial: { "package.json": { frozen_key_paths: ["scripts.test"] } } }
      );
      expect(result).toHaveLength(1);
    });

    it("skips partial check when file is not in the changed set", () => {
      const result = checkFrozenPaths([{ path: "src/other.ts" }], {
        partial: { "package.json": { frozen_key_paths: ["scripts.test"] } },
      });
      expect(result).toEqual([]);
    });

    it("tolerates malformed base content (treats as empty)", () => {
      // If base content is garbage, any head value for a frozen key reads as a change.
      const result = checkFrozenPaths(
        [
          {
            path: "package.json",
            baseContent: "not json {",
            headContent: JSON.stringify({ scripts: { test: "vitest run" } }),
          },
        ],
        { partial: { "package.json": { frozen_key_paths: ["scripts.test"] } } }
      );
      expect(result).toHaveLength(1);
    });
  });

  describe("combined rules", () => {
    it("reports every applicable violation", () => {
      const result = checkFrozenPaths(
        [
          { path: "tests/a.ts" },
          { path: "vitest.config.ts" },
          { path: "src/ok.ts" },
          {
            path: "package.json",
            baseContent: JSON.stringify({ scripts: { test: "a" } }),
            headContent: JSON.stringify({ scripts: { test: "b" } }),
          },
        ],
        {
          directories: ["tests/"],
          files: ["vitest.config.ts"],
          partial: {
            "package.json": { frozen_key_paths: ["scripts.test"] },
          },
        }
      );
      expect(result).toHaveLength(3);
      expect(result.map((v) => v.file)).toEqual([
        "tests/a.ts",
        "vitest.config.ts",
        "package.json",
      ]);
    });
  });

  describe("empty input", () => {
    it("returns no violations for an empty changed list", () => {
      expect(checkFrozenPaths([], { directories: ["tests/"] })).toEqual([]);
    });

    it("returns no violations for an empty config", () => {
      expect(checkFrozenPaths([{ path: "tests/a.ts" }], {})).toEqual([]);
    });
  });
});
