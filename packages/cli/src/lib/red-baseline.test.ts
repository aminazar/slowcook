import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeBaseline, pruneBaseline, extendRedBaseline } from "./red-baseline.js";

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
