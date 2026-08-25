import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirtyDiscoveryPaths } from "./discovery-hygiene.js";

function initRepo(): string {
  const r = mkdtempSync(join(tmpdir(), "hyg-"));
  execSync(
    'git init -q && git -c user.email=test@slowcook.local -c user.name=test commit -q --allow-empty -m init',
    { cwd: r },
  );
  return r;
}

describe("dirtyDiscoveryPaths (G20)", () => {
  it("flags untracked files under src/ and tests/, ignores elsewhere", () => {
    const r = initRepo();
    mkdirSync(join(r, "src/lib"), { recursive: true });
    mkdirSync(join(r, "tests"), { recursive: true });
    writeFileSync(join(r, "src/lib/residue.ts"), "export {}");
    writeFileSync(join(r, "tests/leftover.test.ts"), "export {}");
    writeFileSync(join(r, "notes.md"), "irrelevant");
    const dirty = dirtyDiscoveryPaths(r);
    expect(dirty.some((p) => p.includes("src/lib/residue.ts"))).toBe(true);
    expect(dirty.some((p) => p.includes("tests/leftover.test.ts"))).toBe(true);
    expect(dirty.some((p) => p.includes("notes.md"))).toBe(false);
  });

  it("clean tree = empty", () => {
    expect(dirtyDiscoveryPaths(initRepo())).toEqual([]);
  });
});
