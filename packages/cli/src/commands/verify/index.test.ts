import { describe, it, expect } from "vitest";
import { migrationCollisions } from "./index.js";

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
