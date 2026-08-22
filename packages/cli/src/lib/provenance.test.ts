import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuthored, readLedgerFile, LEDGER_PATH, triggerFromEnv } from "./provenance.js";

describe("provenance ledger (producers)", () => {
  it("appends entries with content hashes and preserves the baseline header", () => {
    const r = mkdtempSync(join(tmpdir(), "prov-"));
    mkdirSync(join(r, ".brewing/provenance"), { recursive: true });
    writeFileSync(
      join(r, LEDGER_PATH),
      JSON.stringify({ baseline: { commit: "abc", at: "t", by: "amin" }, entries: [] })
    );
    mkdirSync(join(r, "specs"), { recursive: true });
    writeFileSync(join(r, "specs/story-1.yaml"), "story_id: '1'\n");
    const rel = appendAuthored(r, {
      agent: "refine",
      files: ["specs/story-1.yaml"],
      derived: { reason: "(derived) spec-pr-review", evidence: "PR #9" },
      story_consent: { story_id: "1" },
    });
    expect(rel).toBe(LEDGER_PATH);
    const ledger = readLedgerFile(r);
    expect(ledger.baseline?.by).toBe("amin");
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]!.hashes["specs/story-1.yaml"]).toMatch(/^[0-9a-f]{64}$/);
    expect(ledger.entries[0]!.at).toBeTruthy();
  });

  it("missing files are skipped, not fatal (deletions carry no hash)", () => {
    const r = mkdtempSync(join(tmpdir(), "prov-"));
    appendAuthored(r, { agent: "recipe", files: ["tests/gone.test.ts"], derived: { reason: "x", evidence: "y" } });
    const ledger = readLedgerFile(r);
    expect(ledger.entries[0]!.hashes).toEqual({});
  });

  it("triggerFromEnv reads the worker's SLOWCOOK_TRIGGER_* contract", () => {
    const old = { ...process.env };
    process.env["SLOWCOOK_TRIGGER_REASON"] = "(derived) spec-manifest-drift";
    process.env["SLOWCOOK_TRIGGER_EVIDENCE"] = "hash mismatch story-020";
    process.env["SLOWCOOK_TRIGGER_TRACE"] = "/logs/trace/123";
    expect(triggerFromEnv()).toEqual({
      reason: "(derived) spec-manifest-drift",
      evidence: "hash mismatch story-020",
      trace: "/logs/trace/123",
    });
    delete process.env["SLOWCOOK_TRIGGER_REASON"];
    expect(triggerFromEnv()).toBeNull();
    process.env = old;
  });
});
