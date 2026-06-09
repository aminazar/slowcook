import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMockShapeConfig, isViteMock } from "./mock-shape.js";

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), "mock-shape-test-"));
}

describe("loadMockShapeConfig", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });

  it("returns nextjs default when no .brewing/mock.yaml + no Vite App.tsx", () => {
    const out = loadMockShapeConfig(repo);
    expect(out.shape).toBe("nextjs");
    expect(out.screens_root).toBe("mock/src/app");
  });

  it("heuristic: returns vite default when mock/src/App.tsx exists without config", () => {
    mkdirSync(join(repo, "mock", "src"), { recursive: true });
    writeFileSync(join(repo, "mock", "src", "App.tsx"), "export const App = () => null;\n", "utf8");
    const out = loadMockShapeConfig(repo);
    expect(out.shape).toBe("vite");
    expect(out.router_file).toBe("mock/src/App.tsx");
  });

  it("reads + validates explicit mock.yaml", () => {
    mkdirSync(join(repo, ".brewing"), { recursive: true });
    writeFileSync(
      join(repo, ".brewing", "mock.yaml"),
      `schema_version: 1
shape: vite
mock_root: mock
screens_root: mock/src/apps
design_system_dir: mock/src/design-system
router_file: mock/src/App.tsx
scenarios_dir: mock/scenarios
scenario_registry_file: mock/src/lib/scenario-registry.ts
`,
      "utf8",
    );
    const out = loadMockShapeConfig(repo);
    expect(out.shape).toBe("vite");
    expect(out.router_file).toBe("mock/src/App.tsx");
    expect(out.screens_root).toBe("mock/src/apps");
    // 0.6.0 — review_mode defaults to scenarios when omitted.
    expect(out.review_mode).toBe("scenarios");
  });

  it("reads review_mode: lcr for a GUCDI/LCR mock", () => {
    mkdirSync(join(repo, ".brewing"), { recursive: true });
    writeFileSync(
      join(repo, ".brewing", "mock.yaml"),
      "schema_version: 1\nshape: vite\nreview_mode: lcr\n",
      "utf8",
    );
    expect(loadMockShapeConfig(repo).review_mode).toBe("lcr");
  });

  it("throws on schema violation", () => {
    mkdirSync(join(repo, ".brewing"), { recursive: true });
    writeFileSync(
      join(repo, ".brewing", "mock.yaml"),
      "schema_version: 1\nshape: angular\n",
      "utf8",
    );
    expect(() => loadMockShapeConfig(repo)).toThrow();
  });

  it("isViteMock helper returns true when config says vite", () => {
    mkdirSync(join(repo, ".brewing"), { recursive: true });
    writeFileSync(
      join(repo, ".brewing", "mock.yaml"),
      "schema_version: 1\nshape: vite\nmock_root: mock\n",
      "utf8",
    );
    expect(isViteMock(repo)).toBe(true);
  });

  it("isViteMock returns false for legacy projects with no config", () => {
    expect(isViteMock(repo)).toBe(false);
  });
});
