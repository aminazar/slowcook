import { describe, it, expect } from "vitest";
import { diffManifest, buildManifest, type Manifest, type TestEntry } from "./manifest.js";

function entry(id: string, file = "tests/a.test.ts"): TestEntry {
  return { id, file };
}

function mkManifest(ids: string[]): Manifest {
  return {
    schema_version: 1,
    slowcook_version: "0.2.0-test",
    recorded_at: "2026-04-20T00:00:00.000Z",
    story_id: null,
    tests: ids.map((id) => entry(id)),
    suites: [
      { suite: "backend", command: "npx vitest list", test_count: ids.length },
    ],
  };
}

describe("diffManifest", () => {
  it("returns empty diff when recorded and current match exactly", () => {
    const m = mkManifest(["a", "b", "c"]);
    const d = diffManifest(m, [entry("a"), entry("b"), entry("c")]);
    expect(d.missing).toEqual([]);
    expect(d.added).toEqual([]);
    expect(d.retained.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("flags a manifest test that is no longer discoverable as missing", () => {
    const m = mkManifest(["a", "b", "c"]);
    const d = diffManifest(m, [entry("a"), entry("c")]); // b gone
    expect(d.missing.map((t) => t.id)).toEqual(["b"]);
    expect(d.added).toEqual([]);
  });

  it("reports newly-discovered tests as added (informational)", () => {
    const m = mkManifest(["a"]);
    const d = diffManifest(m, [entry("a"), entry("new1"), entry("new2")]);
    expect(d.missing).toEqual([]);
    expect(d.added.map((t) => t.id)).toEqual(["new1", "new2"]);
    expect(d.retained.map((t) => t.id)).toEqual(["a"]);
  });

  it("handles disjoint recorded and current sets", () => {
    const m = mkManifest(["old1", "old2"]);
    const d = diffManifest(m, [entry("new1"), entry("new2")]);
    expect(d.missing.map((t) => t.id)).toEqual(["old1", "old2"]);
    expect(d.added.map((t) => t.id)).toEqual(["new1", "new2"]);
    expect(d.retained).toEqual([]);
  });

  it("handles empty manifest", () => {
    const m = mkManifest([]);
    const d = diffManifest(m, [entry("a"), entry("b")]);
    expect(d.missing).toEqual([]);
    expect(d.added.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("handles empty current discovery (total wipe = all missing)", () => {
    const m = mkManifest(["a", "b"]);
    const d = diffManifest(m, []);
    expect(d.missing.map((t) => t.id)).toEqual(["a", "b"]);
    expect(d.added).toEqual([]);
  });

  it("is stable with duplicate ids in current (uses set semantics for missing)", () => {
    // Duplicates are not expected in discovery output, but be robust.
    const m = mkManifest(["a"]);
    const d = diffManifest(m, [entry("a"), entry("a")]);
    expect(d.missing).toEqual([]);
    // "added" reports duplicates as they appear — discovery should not emit them,
    // but we don't silently dedupe since that'd hide a real oddity.
    expect(d.added.map((t) => t.id)).toEqual([]);
  });
});

describe("buildManifest", () => {
  it("produces a schema-versioned manifest with the given data", () => {
    const now = new Date("2026-04-20T12:34:56.000Z");
    const m = buildManifest({
      slowcookVersion: "0.2.0",
      storyId: "42",
      tests: [entry("t1"), entry("t2")],
      suites: [{ suite: "backend", command: "npx vitest list", test_count: 2 }],
      now,
    });
    expect(m.schema_version).toBe(1);
    expect(m.slowcook_version).toBe("0.2.0");
    expect(m.recorded_at).toBe("2026-04-20T12:34:56.000Z");
    expect(m.story_id).toBe("42");
    expect(m.tests).toHaveLength(2);
    expect(m.suites).toHaveLength(1);
  });

  it("defaults story_id to null for whole-repo manifests", () => {
    const m = buildManifest({
      slowcookVersion: "0.2.0",
      storyId: null,
      tests: [],
      suites: [],
    });
    expect(m.story_id).toBeNull();
  });
});
