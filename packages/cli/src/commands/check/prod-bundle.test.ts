import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProdBundleCheck } from "./prod-bundle.js";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "pb-")); mkdirSync(join(root, "dist", "assets"), { recursive: true }); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("prod-bundle check", () => {
  it("fails when sql-wasm.wasm is emitted", () => {
    writeFileSync(join(root, "dist/assets/sql-wasm-abc.wasm"), "\0asm");
    const r = runProdBundleCheck(root, "dist");
    expect(r.violations.map(v => v.reason)).toContain("sql.js SQLite WASM");
  });

  it("fails when a js chunk carries initSqlJs / mock-runtime markers", () => {
    writeFileSync(join(root, "dist/assets/index.js"), "function initSqlJs(){} import('@slowcook-ai/mock-runtime')");
    const r = runProdBundleCheck(root, "dist");
    const labels = r.violations.map(v => v.reason);
    expect(labels).toContain("sql.js runtime");
    expect(labels).toContain("slowcook mock-runtime fixture engine");
  });

  it("passes a clean bundle", () => {
    writeFileSync(join(root, "dist/assets/index.js"), "fetch('/api/projects').then(r=>r.json())");
    const r = runProdBundleCheck(root, "dist");
    expect(r.violations).toHaveLength(0);
    expect(r.filesScanned).toBe(1);
  });

  it("dedupes repeated markers per file+label", () => {
    writeFileSync(join(root, "dist/assets/index.js"), "initSqlJs initSqlJs initSqlJs");
    const r = runProdBundleCheck(root, "dist");
    expect(r.violations.filter(v => v.reason === "sql.js runtime")).toHaveLength(1);
  });
});
