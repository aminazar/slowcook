import { describe, it, expect } from "vitest";
import { storyFileMatcher, foldCrossSuiteTests } from "./cross-suite.js";

describe("storyFileMatcher", () => {
  it("matches the plain story file convention", () => {
    const m = storyFileMatcher("016");
    expect(m("supabase/tests/database/story-016-pins.test.sql")).toBe(true);
    expect(m("tests/integration/story-016.test.ts")).toBe(true);
    expect(m("e2e/story-016.spec.ts")).toBe(true);
  });

  it("tolerates zero-padding differences in both directions", () => {
    expect(storyFileMatcher("16")("db/story-016-pins.test.sql")).toBe(true);
    expect(storyFileMatcher("016")("db/story-16-pins.test.sql")).toBe(true);
    expect(storyFileMatcher("story-016")("db/story-016.test.sql")).toBe(true);
  });

  it("never cross-matches other stories (016 vs 16 vs 160 vs 1)", () => {
    const m = storyFileMatcher("016");
    expect(m("db/story-160-pins.test.sql")).toBe(false);
    expect(m("db/story-1.test.sql")).toBe(false);
    expect(m("db/story-0160.test.sql")).toBe(false);
    const m1 = storyFileMatcher("1");
    expect(m1("db/story-016.test.sql")).toBe(false);
    expect(m1("db/story-001.test.sql")).toBe(true);
  });
});

describe("foldCrossSuiteTests", () => {
  const manifest = [
    { id: "tests/integration/story-016.test.ts > a > b", file: "tests/integration/story-016.test.ts" },
  ];

  it("folds story-matched discovered tests the manifest missed (the missing-migration class)", () => {
    const discovered = [
      // tap-prove discovery: id === file
      { id: "supabase/tests/database/story-016-pins.test.sql", file: "supabase/tests/database/story-016-pins.test.sql" },
      { id: "supabase/tests/database/story-019-merge.test.sql", file: "supabase/tests/database/story-019-merge.test.sql" },
      { id: "tests/integration/story-016.test.ts > a > b", file: "tests/integration/story-016.test.ts" },
    ];
    const added = foldCrossSuiteTests(manifest, discovered, "016");
    expect(added).toEqual([
      {
        id: "supabase/tests/database/story-016-pins.test.sql",
        file: "supabase/tests/database/story-016-pins.test.sql",
      },
    ]);
  });

  it("adds nothing when discovery only repeats the manifest", () => {
    expect(
      foldCrossSuiteTests(manifest, [...manifest], "016")
    ).toEqual([]);
  });

  it("dedupes repeated discovery rows", () => {
    const sql = {
      id: "supabase/tests/database/story-016-pins.test.sql",
      file: "supabase/tests/database/story-016-pins.test.sql",
    };
    expect(foldCrossSuiteTests(manifest, [sql, sql], "016")).toHaveLength(1);
  });

  it("falls back to the id when discovery has no file (defensive)", () => {
    const added = foldCrossSuiteTests(
      manifest,
      [{ id: "db/story-016-x.test.sql", file: "" }],
      "016"
    );
    expect(added).toEqual([{ id: "db/story-016-x.test.sql", file: "db/story-016-x.test.sql" }]);
  });
});
