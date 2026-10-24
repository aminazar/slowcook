import { describe, it, expect } from "vitest";
import { migrationCollisions, summarizeRun, tscErrorCounts, typecheckRegressions } from "./index.js";

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

describe("summarizeRun (verify --json, WP1)", () => {
  it("splits the story contract from the full-suite reds and sorts red files", () => {
    const tests = [
      { id: "t/a > one", file: "t/a", status: "passed" },
      { id: "t/a > two", file: "t/a", status: "failed", failure_message: "Unable to find an element by: [data-testid=\"save\"]" },
      { id: "t/z > other", file: "t/z", status: "failed" },
      { id: "t/b > other", file: "t/b", status: "failed" },
      { id: "t/c > fine", file: "t/c", status: "passed" },
    ];
    const got = summarizeRun(tests, new Set(["t/a > one", "t/a > two", "t/a > missing"]));
    // "missing" has no result at all: not run, never counted green.
    expect(got).toEqual({
      green: 1,
      total: 3,
      not_run: 1,
      red_ids: ["t/a > two"],
      red: [{ id: "t/a > two", message: "Unable to find an element by: [data-testid=\"save\"]" }],
      red_outside_story: 2,
      red_files: ["t/b", "t/z"],
    });
  });
});
