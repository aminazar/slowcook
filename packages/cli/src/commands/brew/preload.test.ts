// Orientation carry (dovizir §13). The live failure: every fresh-context
// iteration re-read the same ~20 files, two turns got cut at the round cap
// mid-orientation, and the run never reached a surviving edit.
import { describe, it, expect } from "vitest";
import { recordRead, buildPreloadBlock, type ReadCacheEntry } from "./preload.js";

const mkCache = (entries: [string, ReadCacheEntry][] = []) => new Map(entries);

describe("recordRead", () => {
  it("counts hits — the run's most-consulted files rank first", () => {
    const cache = mkCache();
    recordRead(cache, "a.ts", "A");
    recordRead(cache, "a.ts", "A");
    recordRead(cache, "b.ts", "B");
    expect(cache.get("a.ts")!.hits).toBe(2);
    expect(cache.get("b.ts")!.hits).toBe(1);
  });
});

describe("buildPreloadBlock", () => {
  it("always pre-loads the target test, even with an empty cache (iteration 1)", () => {
    const block = buildPreloadBlock({
      cache: mkCache(),
      targetTestFile: "tests/integration/story-001.test.ts",
      readFile: (p) => (p.includes("story-001") ? "describe('x')" : null),
    });
    expect(block).toContain("tests/integration/story-001.test.ts");
    expect(block).toContain("describe('x')");
    expect(block).toContain("do NOT spend tool calls re-reading");
  });

  it("pre-loads the most-consulted cached files, most hits first", () => {
    const cache = mkCache([
      ["pkg.json", { content: "PKG", hits: 5 }],
      ["src/index.ts", { content: "SRC", hits: 9 }],
    ]);
    const files: Record<string, string> = { "t.test.ts": "T", "pkg.json": "PKG", "src/index.ts": "SRC" };
    const block = buildPreloadBlock({ cache, targetTestFile: "t.test.ts", readFile: (p) => files[p] ?? null });
    expect(block.indexOf("src/index.ts")).toBeLessThan(block.indexOf("pkg.json"));
  });

  it("drops a cached file whose on-disk content changed — the cache must never lie", () => {
    const cache = mkCache([["src/index.ts", { content: "OLD", hits: 9 }]]);
    const block = buildPreloadBlock({
      cache,
      targetTestFile: "t.test.ts",
      readFile: (p) => (p === "t.test.ts" ? "T" : "NEW CONTENT"),
    });
    expect(block).not.toContain("NEW CONTENT");
    expect(block).not.toContain("src/index.ts");
  });

  it("accepts a truncated cache entry when it is a prefix of the current file", () => {
    const full = "x".repeat(50) + "yz-tail";
    const cache = mkCache([["big.ts", { content: "x".repeat(50) + "\n…(truncated)", hits: 3 }]]);
    const block = buildPreloadBlock({
      cache,
      targetTestFile: "t.test.ts",
      readFile: (p) => (p === "t.test.ts" ? "T" : full),
    });
    expect(block).toContain("big.ts");
  });

  it("respects the character budget — one giant file cannot crowd out the set", () => {
    const cache = mkCache([
      ["huge.ts", { content: "H".repeat(30_000), hits: 9 }],
      ["small.ts", { content: "S", hits: 8 }],
    ]);
    const files: Record<string, string> = { "t.test.ts": "T", "huge.ts": "H".repeat(30_000), "small.ts": "S" };
    const block = buildPreloadBlock({ cache, targetTestFile: "t.test.ts", readFile: (p) => files[p] ?? null, budgetChars: 12_000 });
    expect(block).toContain("huge.ts");                       // included, but capped…
    expect(block).toContain("read_file for the rest");        // …with a truncation pointer
    expect(block).toContain("small.ts");                      // and the small file still fits
  });

  it("returns empty when nothing is readable — no fabricated section", () => {
    expect(buildPreloadBlock({ cache: mkCache(), targetTestFile: "gone.ts", readFile: () => null })).toBe("");
  });
});
