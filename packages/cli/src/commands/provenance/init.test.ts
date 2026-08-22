import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enumerateOwned } from "./index.js";
import { DEFAULT_OWNERSHIP, verifyProtection } from "../check/ratchet-protection.js";
import { readLedgerFile, appendAuthored } from "../../lib/provenance.js";

function repo(): string {
  const r = mkdtempSync(join(tmpdir(), "provinit-"));
  execSync('git init -q && git config user.email t@t && git config user.name tester', { cwd: r });
  mkdirSync(join(r, "specs"), { recursive: true });
  mkdirSync(join(r, "tests/integration"), { recursive: true });
  mkdirSync(join(r, ".brewing/manifests"), { recursive: true });
  writeFileSync(join(r, "specs/story-1.yaml"), "story_id: '1'\n");
  writeFileSync(join(r, "tests/integration/story-1.test.ts"), "// t\n");
  writeFileSync(
    join(r, ".brewing/manifests/story-1.json"),
    JSON.stringify({ tests: [{ file: "tests/integration/story-1.test.ts" }] })
  );
  execSync("git add -A && git commit -qm init", { cwd: r });
  return r;
}

describe("provenance init (install-time baseline)", () => {
  it("enumerates specs + manifest tests as the owned set", () => {
    const r = repo();
    const owned = enumerateOwned(r, DEFAULT_OWNERSHIP);
    expect(owned).toContain("specs/story-1.yaml");
    expect(owned).toContain("tests/integration/story-1.test.ts");
  });

  it("a later agent entry outranks the baseline for the same file (last-match)", () => {
    const r = repo();
    appendAuthored(r, {
      agent: "pre-provenance",
      files: ["specs/story-1.yaml"],
      derived: { reason: "baseline", evidence: "init" },
    });
    appendAuthored(r, {
      agent: "refine",
      files: ["specs/story-1.yaml"],
      derived: { reason: "(derived) spec-pr-review", evidence: "PR #7" },
      story_consent: { story_id: "1" },
    });
    const ledger = readLedgerFile(r);
    const v = verifyProtection({
      changedPaths: ["specs/story-1.yaml"],
      headHashes: { "specs/story-1.yaml": ledger.entries[1]!.hashes["specs/story-1.yaml"]! },
      ledger: ledger.entries,
      baseline: { commit: "c", at: "t", by: "tester" },
      config: DEFAULT_OWNERSHIP,
      manifestTestFiles: [],
    });
    expect(v.ok).toBe(true);
    expect(v.sanctioned[0]!.agent).toBe("refine");
  });
});
