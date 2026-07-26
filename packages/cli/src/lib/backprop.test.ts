// Backprop claims: mirror-first, dedup, offline-safe.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileBackpropClaims, loadClaims, openClaimCount } from "./backprop.js";

const claim = (summary: string) => ({ target: "concept" as const, summary, detail: "d", source: "s" });

describe("backprop claims", () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "bp-")); });

  it("mirrors claims to .brewing/backprop-claims.json without a forge", async () => {
    const res = await fileBackpropClaims(cwd, [claim("a"), claim("b")]);
    expect(res.mirrored).toBe(2);
    expect(res.issued).toBe(0);
    const raw = JSON.parse(readFileSync(join(cwd, ".brewing/backprop-claims.json"), "utf8"));
    expect(raw).toHaveLength(2);
    expect(openClaimCount(cwd)).toBe(2);
  });

  it("dedupes open claims by target+summary", async () => {
    await fileBackpropClaims(cwd, [claim("a")]);
    const res = await fileBackpropClaims(cwd, [claim("a"), claim("c")]);
    expect(res.mirrored).toBe(1);
    expect(res.skippedDuplicates).toBe(1);
    expect(loadClaims(cwd)).toHaveLength(2);
  });

  it("dedupes WITHIN a batch — one gap tripped by many journeys is one claim", async () => {
    const res = await fileBackpropClaims(cwd, [claim("no route"), claim("no route"), claim("no route"), claim("other")]);
    expect(res.mirrored).toBe(2);
    expect(res.skippedDuplicates).toBe(2);
    expect(openClaimCount(cwd)).toBe(2);
  });
});
