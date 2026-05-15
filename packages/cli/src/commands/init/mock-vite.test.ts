import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { planMockViteFiles, applyMockViteFiles } from "./mock-vite.js";

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), "mock-vite-test-"));
}

describe("planMockViteFiles", () => {
  it("includes every required path", () => {
    const files = planMockViteFiles({
      cwd: "/tmp/x",
      force: false,
      dryRun: false,
      runtimeVersion: "0.19.0",
    });
    const paths = files.map((f) => f.path);
    for (const required of [
      "mock/package.json",
      "mock/vite.config.ts",
      "mock/tsconfig.json",
      "mock/index.html",
      "mock/.gitignore",
      "mock/README.md",
      "mock/src/main.tsx",
      "mock/src/App.tsx",
      "mock/src/design-system/tokens.ts",
      "mock/src/design-system/css.ts",
      "mock/src/design-system/index.ts",
      "mock/src/lib/scenario-registry.tsx",
      "mock/src/apps/.gitkeep",
      "mock/scenarios/.gitkeep",
      ".brewing/mock.yaml",
    ]) {
      expect(paths).toContain(required);
    }
  });

  it("package.json declares vite + react + react-router-dom (no mock-runtime)", () => {
    const files = planMockViteFiles({
      cwd: "/tmp/x",
      force: false,
      dryRun: false,
      runtimeVersion: "0.19.5",
    });
    const pkg = JSON.parse(files.find((f) => f.path === "mock/package.json")!.contents);
    // mock-runtime is intentionally NOT a vite-mock dep — its peer set
    // pins next + react@>=19. Vite mock inlines scenario primitives.
    expect(pkg.dependencies["@slowcook-ai/mock-runtime"]).toBeUndefined();
    expect(pkg.dependencies["react"]).toMatch(/^\^?18/);
    expect(pkg.dependencies["react-router-dom"]).toBeDefined();
    expect(pkg.devDependencies["vite"]).toBeDefined();
    expect(pkg.devDependencies["@vitejs/plugin-react"]).toBeDefined();
    expect(pkg.scripts.dev).toBe("vite");
  });

  it("mock package.json name derives from parent package name", () => {
    const files = planMockViteFiles({
      cwd: "/tmp/x",
      force: false,
      dryRun: false,
      runtimeVersion: "0.19",
    });
    // No parent package.json at /tmp/x → fallback name 'slowcook-mock'.
    const pkg = JSON.parse(files.find((f) => f.path === "mock/package.json")!.contents);
    expect(pkg.name).toBe("slowcook-mock");
  });

  it(".brewing/mock.yaml declares shape: vite", () => {
    const files = planMockViteFiles({
      cwd: "/tmp/x",
      force: false,
      dryRun: false,
      runtimeVersion: "0.19.0",
    });
    const yaml = files.find((f) => f.path === ".brewing/mock.yaml")!.contents;
    const parsed = YAML.parse(yaml);
    expect(parsed.shape).toBe("vite");
    expect(parsed.schema_version).toBe(1);
    expect(parsed.router_file).toBe("mock/src/App.tsx");
    expect(parsed.screens_root).toBe("mock/src/apps");
    expect(parsed.design_system_dir).toBe("mock/src/design-system");
  });

  it("App.tsx exposes a vibe-managed router-append marker", () => {
    const files = planMockViteFiles({
      cwd: "/tmp/x",
      force: false,
      dryRun: false,
      runtimeVersion: "0.19.0",
    });
    const app = files.find((f) => f.path === "mock/src/App.tsx")!.contents;
    expect(app).toContain("Vibe-managed route imports");
    expect(app).toContain("Vibe-managed routes");
    expect(app).toContain("<Routes>");
    expect(app).toContain("<ScenarioPicker />");
  });

  it("vite.config sets port 3100 (parity with legacy nextjs mock)", () => {
    const files = planMockViteFiles({
      cwd: "/tmp/x",
      force: false,
      dryRun: false,
      runtimeVersion: "0.19.0",
    });
    const cfg = files.find((f) => f.path === "mock/vite.config.ts")!.contents;
    expect(cfg).toContain("port: 3100");
  });
});

describe("applyMockViteFiles (write)", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });

  it("writes every planned file to the cwd", () => {
    const args = { cwd: repo, force: false, dryRun: false, runtimeVersion: "0.19.0" };
    applyMockViteFiles(args, planMockViteFiles(args));
    for (const p of [
      "mock/package.json",
      "mock/vite.config.ts",
      "mock/src/main.tsx",
      "mock/src/App.tsx",
      "mock/src/design-system/tokens.ts",
      ".brewing/mock.yaml",
    ]) {
      expect(existsSync(join(repo, p)), p).toBe(true);
    }
  });

  it("skips existing files without --force", () => {
    const args = { cwd: repo, force: false, dryRun: false, runtimeVersion: "0.19.0" };
    // Pre-create a file that planMockViteFiles will try to write.
    mkdirSync(join(repo, "mock", "src"), { recursive: true });
    writeFileSync(join(repo, "mock", "src", "App.tsx"), "// hand-edited\n", "utf8");
    applyMockViteFiles(args, planMockViteFiles(args));
    expect(readFileSync(join(repo, "mock", "src", "App.tsx"), "utf8")).toBe("// hand-edited\n");
  });

  it("overwrites on --force", () => {
    const args = { cwd: repo, force: true, dryRun: false, runtimeVersion: "0.19.0" };
    mkdirSync(join(repo, "mock", "src"), { recursive: true });
    writeFileSync(join(repo, "mock", "src", "App.tsx"), "// hand-edited\n", "utf8");
    applyMockViteFiles(args, planMockViteFiles(args));
    expect(readFileSync(join(repo, "mock", "src", "App.tsx"), "utf8")).toContain("<Routes>");
  });

  it("dry-run writes nothing", () => {
    const args = { cwd: repo, force: false, dryRun: true, runtimeVersion: "0.19.0" };
    applyMockViteFiles(args, planMockViteFiles(args));
    expect(existsSync(join(repo, "mock", "package.json"))).toBe(false);
    expect(existsSync(join(repo, ".brewing", "mock.yaml"))).toBe(false);
  });

  it("uses parent package.json name when present", () => {
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "@myorg/myapp" }),
      "utf8",
    );
    const args = { cwd: repo, force: false, dryRun: false, runtimeVersion: "0.19.0" };
    applyMockViteFiles(args, planMockViteFiles(args));
    const mockPkg = JSON.parse(readFileSync(join(repo, "mock", "package.json"), "utf8"));
    expect(mockPkg.name).toBe("myapp-mock");
  });
});
