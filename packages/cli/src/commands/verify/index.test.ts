import { describe, it, expect } from "vitest";
import { migrationCollisions, tscErrorCounts, typecheckRegressions } from "./index.js";

describe("migrationCollisions", () => {
  it("flags a branch migration whose number a DIFFERENT base file owns", () => {
    const got = migrationCollisions(
      ["00021_story_021_publisher.sql", "00020_old.sql"],
      ["00021_story_013_backfill.sql", "00020_old.sql"]
    );
    expect(got).toEqual([
      {
        number: "00021",
        branch: "00021_story_021_publisher.sql",
        base: "00021_story_013_backfill.sql",
      },
    ]);
  });

  it("same file on both sides is not a collision", () => {
    expect(migrationCollisions(["00020_x.sql"], ["00020_x.sql"])).toEqual([]);
  });

  it("non-numeric files are ignored; empty base degrades to no collisions", () => {
    expect(migrationCollisions(["README.md", "00022_y.sql"], [])).toEqual([]);
  });
});

describe("typecheck ratchet", () => {
  it("parses per-file error counts from tsc output", () => {
    const counts = tscErrorCounts(
      [
        "tests/a.test.ts(1,2): error TS2307: x",
        "tests/a.test.ts(9,1): error TS2345: y",
        "src/b.ts(3,3): error TS1185: z",
        "not an error line",
      ].join("\n")
    );
    expect(Object.fromEntries(counts)).toEqual({ "tests/a.test.ts": 2, "src/b.ts": 1 });
  });

  it("pre-existing debt passes; increases and new files fail", () => {
    const baseline = new Map([
      ["tests/a.test.ts", 2],
      ["src/b.ts", 1],
    ]);
    expect(typecheckRegressions(baseline, new Map([["tests/a.test.ts", 2]]))).toEqual([]);
    expect(typecheckRegressions(baseline, new Map([["tests/a.test.ts", 3]]))).toEqual([
      { file: "tests/a.test.ts", was: 2, now: 3 },
    ]);
    expect(typecheckRegressions(baseline, new Map([["src/new.ts", 1]]))).toEqual([
      { file: "src/new.ts", was: 0, now: 1 },
    ]);
  });
});
