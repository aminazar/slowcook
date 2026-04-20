import { describe, it, expect } from "vitest";
import {
  applySupersede,
  makeEmptyIndex,
  type SpecIndex,
  type SpecIndexEntry,
} from "./spec.js";

function mkEntry(title: string, status: SpecIndexEntry["status"] = "active"): SpecIndexEntry {
  return { title, status };
}

describe("makeEmptyIndex", () => {
  it("produces a schema-versioned empty index", () => {
    const idx = makeEmptyIndex();
    expect(idx.schema_version).toBe(1);
    expect(idx.stories).toEqual({});
  });
});

describe("applySupersede", () => {
  it("adds the new story and marks old stories as superseded_by", () => {
    const idx: SpecIndex = {
      schema_version: 1,
      stories: {
        "007": mkEntry("seven"),
        "012": mkEntry("twelve"),
        "013": mkEntry("thirteen"),
      },
    };
    const next = applySupersede(
      idx,
      { id: "042", entry: mkEntry("forty-two") },
      ["007", "012"]
    );
    expect(next.stories["007"]?.status).toBe("superseded");
    expect(next.stories["007"]?.superseded_by).toBe("042");
    expect(next.stories["012"]?.status).toBe("superseded");
    expect(next.stories["013"]?.status).toBe("active");
    expect(next.stories["042"]?.status).toBe("active");
    expect(next.stories["042"]?.supersedes).toEqual(["007", "012"]);
  });

  it("is pure — does not mutate the input index", () => {
    const idx: SpecIndex = {
      schema_version: 1,
      stories: { "007": mkEntry("seven") },
    };
    const before = JSON.stringify(idx);
    applySupersede(idx, { id: "042", entry: mkEntry("forty-two") }, ["007"]);
    expect(JSON.stringify(idx)).toBe(before);
  });

  it("handles empty supersedes list (pure add)", () => {
    const idx = makeEmptyIndex();
    const next = applySupersede(idx, { id: "001", entry: mkEntry("first") }, []);
    expect(next.stories["001"]?.status).toBe("active");
    expect(next.stories["001"]?.supersedes).toEqual([]);
  });

  it("silently skips supersedes for unknown story ids (idempotent)", () => {
    const idx = makeEmptyIndex();
    const next = applySupersede(
      idx,
      { id: "042", entry: mkEntry("forty-two") },
      ["nonexistent"]
    );
    expect(next.stories["042"]?.supersedes).toEqual(["nonexistent"]);
    expect(next.stories["nonexistent"]).toBeUndefined();
  });

  it("preserves existing supersedes on the new story if no override provided", () => {
    const idx = makeEmptyIndex();
    const next = applySupersede(
      idx,
      { id: "042", entry: { ...mkEntry("forty-two"), supersedes: ["prior"] } },
      []
    );
    // Empty supersedesIds → entry's own supersedes field is preserved
    expect(next.stories["042"]?.supersedes).toEqual(["prior"]);
  });
});
