import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeBaseline, pruneBaseline, extendRedBaseline, pruneRedBaseline } from "./red-baseline.js";

describe("pruneRedBaseline (WP2) — write-through", () => {
  it("removes now-green ids from the file and reports the count", () => {
    const r = mkdtempSync(join(tmpdir(), "rb-"));
    writeFileSync(join(r, "known-red.json"), JSON.stringify(["t1", "t2", "t3"]), "utf8");
    const res = pruneRedBaseline(r, "known-red.json", ["t2", "t9"]);
    expect(res).toEqual({ declared: true, path: "known-red.json", removed: 1, total: 2 });
    expect(JSON.parse(readFileSync(join(r, "known-red.json"), "utf8"))).toEqual(["t1", "t3"]);
  });

  it("no declared baseline → no-op; missing file → nothing written", () => {
    const r = mkdtempSync(join(tmpdir(), "rb-"));
    expect(pruneRedBaseline(r, undefined, ["t"])).toEqual({ declared: false });
    expect(pruneRedBaseline(r, "known-red.json", ["t"])).toMatchObject({ declared: true, removed: 0, total: 0 });
  });

  it("leaves the file untouched when nothing healed", () => {
    const r = mkdtempSync(join(tmpdir(), "rb-"));
    const p = join(r, "known-red.json");
    writeFileSync(p, '["t1"]', "utf8");
    expect(pruneRedBaseline(r, "known-red.json", ["other"])).toMatchObject({ removed: 0, total: 1 });
    expect(readFileSync(p, "utf8")).toBe('["t1"]');
  });

  it("refuses a corrupt baseline", () => {
    const r = mkdtempSync(join(tmpdir(), "rb-"));
    writeFileSync(join(r, "known-red.json"), "{oops", "utf8");
    expect(() => pruneRedBaseline(r, "known-red.json", ["t"])).toThrow(/not a JSON array/);
  });
});

describe("red baseline (#542)", () => {
  it("merge unions, sorts and dedupes; prune removes healed tests", () => {
    expect(mergeBaseline(["b", "a"], ["a", "c"])).toEqual(["a", "b", "c"]);
    expect(pruneBaseline(["a", "b", "c"], ["b"])).toEqual(["a", "c"]);
  });

  it("no declared baseline → no-op, never an error", () => {
    expect(extendRedBaseline(tmpdir(), undefined, ["x"])).toEqual({ declared: false });
  });

  it("creates the file when absent and reports what it added", () => {
    const r = mkdtempSync(join(tmpdir(), "rb-"));
    const res = extendRedBaseline(r, "known-red.json", ["t2", "t1"]);
    expect(res).toMatchObject({ declared: true, added: 2, total: 2 });
    expect(JSON.parse(readFileSync(join(r, "known-red.json"), "utf8"))).toEqual(["t1", "t2"]);
  });

  it("unions with an existing baseline without duplicating", () => {
    const r = mkdtempSync(join(tmpdir(), "rb-"));
    writeFileSync(join(r, "known-red.json"), JSON.stringify(["t1"]), "utf8");
    const res = extendRedBaseline(r, "known-red.json", ["t1", "t3"]);
    expect(res).toMatchObject({ added: 1, total: 2 });
  });

  it("refuses a corrupt baseline rather than erasing the honest record", () => {
    const r = mkdtempSync(join(tmpdir(), "rb-"));
    writeFileSync(join(r, "known-red.json"), "{oops", "utf8");
    expect(() => extendRedBaseline(r, "known-red.json", ["t"])).toThrow(/not a JSON array/);
  });
});
