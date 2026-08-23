import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAnsweredIds, recordAnsweredIds } from "./answered-store.js";

let repoRoot: string;
beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "plate-answered-"));
});

describe("answered-comment ledger", () => {
  it("starts empty and round-trips recorded ids per PR", () => {
    expect(loadAnsweredIds(repoRoot, 237).size).toBe(0);
    recordAnsweredIds(repoRoot, 237, [11, 22]);
    recordAnsweredIds(repoRoot, 129, [33]);
    expect([...loadAnsweredIds(repoRoot, 237)]).toEqual([11, 22]);
    expect([...loadAnsweredIds(repoRoot, 129)]).toEqual([33]);
  });

  it("the no-op echo storm is dead: a considered id stays excluded on the next tick", () => {
    // tick 1: plate sees comment 555, decides nothing-to-amend, records it
    recordAnsweredIds(repoRoot, 237, [555]);
    // tick 2 (no commit happened — the old date cutoff would re-admit 555)
    expect(loadAnsweredIds(repoRoot, 237).has(555)).toBe(true);
  });

  it("merges without duplicates and keeps ids sorted", () => {
    recordAnsweredIds(repoRoot, 1, [5, 3]);
    recordAnsweredIds(repoRoot, 1, [4, 3]);
    expect([...loadAnsweredIds(repoRoot, 1)]).toEqual([3, 4, 5]);
  });

  it("caps per-PR history keeping the newest (highest) ids", () => {
    recordAnsweredIds(repoRoot, 9, Array.from({ length: 1005 }, (_, i) => i + 1));
    const got = loadAnsweredIds(repoRoot, 9);
    expect(got.size).toBe(1000);
    expect(got.has(1)).toBe(false);
    expect(got.has(1005)).toBe(true);
  });

  it("recording nothing writes nothing", () => {
    recordAnsweredIds(repoRoot, 7, []);
    expect(() =>
      readFileSync(join(repoRoot, ".brewing", "local", "plate-answered.json"), "utf8")
    ).toThrow();
  });

  it("survives a corrupt store file (fails open to empty, then rewrites)", () => {
    const dir = join(repoRoot, ".brewing", "local");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "plate-answered.json"), "{not json", "utf8");
    expect(loadAnsweredIds(repoRoot, 3).size).toBe(0);
    recordAnsweredIds(repoRoot, 3, [1]);
    expect(loadAnsweredIds(repoRoot, 3).has(1)).toBe(true);
  });
});
