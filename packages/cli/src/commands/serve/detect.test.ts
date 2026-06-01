import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectMockRunnable } from "./detect.js";

describe("detectMockRunnable", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "slowcook-mock-detect-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports exists:false when mock/ is absent", () => {
    const out = detectMockRunnable(dir);
    expect(out.exists).toBe(false);
    expect(out.hasDevScript).toBe(false);
    expect(out.reason).toMatch(/mock\//);
  });

  it("reports hasDevScript:false when scripts.dev is missing", () => {
    mkdirSync(join(dir, "mock"));
    writeFileSync(join(dir, "mock", "package.json"), JSON.stringify({ name: "mock", scripts: { build: "vite build" } }));
    const out = detectMockRunnable(dir);
    expect(out.exists).toBe(true);
    expect(out.hasDevScript).toBe(false);
    expect(out.reason).toMatch(/scripts\.dev/);
  });

  it("reports hasDevScript:true + returns the script command", () => {
    mkdirSync(join(dir, "mock"));
    writeFileSync(join(dir, "mock", "package.json"), JSON.stringify({ name: "mock", scripts: { dev: "vite" } }));
    const out = detectMockRunnable(dir);
    expect(out.exists).toBe(true);
    expect(out.hasDevScript).toBe(true);
    expect(out.devScript).toBe("vite");
  });

  it("surfaces JSON parse errors with the failing path", () => {
    mkdirSync(join(dir, "mock"));
    writeFileSync(join(dir, "mock", "package.json"), "not json {");
    const out = detectMockRunnable(dir);
    expect(out.exists).toBe(true);
    expect(out.hasDevScript).toBe(false);
    expect(out.reason).toMatch(/not valid JSON/);
  });
});
