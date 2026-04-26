import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initMock, planMockFiles, parseMockInitArgs } from "./mock.js";

function mkRepo(): string {
  return mkdtempSync(join(tmpdir(), "slowcook-init-mock-"));
}

describe("parseMockInitArgs", () => {
  it("defaults: cwd=process.cwd, no force, no dry-run", () => {
    const a = parseMockInitArgs([], "0.1.0");
    expect(a.cwd).toBe(process.cwd());
    expect(a.force).toBe(false);
    expect(a.dryRun).toBe(false);
    expect(a.runtimeVersion).toBe("0.1.0");
  });

  it("respects --cwd, --force, --dry-run, --runtime-version", () => {
    const a = parseMockInitArgs(
      ["--cwd", "/tmp/x", "--force", "--dry-run", "--runtime-version", "^0.2.0"],
      "0.1.0"
    );
    expect(a.cwd).toBe("/tmp/x");
    expect(a.force).toBe(true);
    expect(a.dryRun).toBe(true);
    expect(a.runtimeVersion).toBe("^0.2.0");
  });
});

describe("planMockFiles", () => {
  it("produces a stable list of mock/* paths", () => {
    const repo = mkRepo();
    try {
      const files = planMockFiles({
        cwd: repo,
        force: false,
        dryRun: false,
        runtimeVersion: "^0.1.0",
      });
      const paths = files.map((f) => f.path);
      // All under mock/
      expect(paths.every((p) => p.startsWith("mock/"))).toBe(true);
      // Key files present
      expect(paths).toContain("mock/package.json");
      expect(paths).toContain("mock/Dockerfile");
      expect(paths).toContain("mock/tsconfig.json");
      expect(paths).toContain("mock/next.config.js");
      expect(paths).toContain("mock/postcss.config.mjs");
      expect(paths).toContain("mock/.gitignore");
      expect(paths).toContain("mock/README.md");
      expect(paths).toContain("mock/src/app/layout.tsx");
      expect(paths).toContain("mock/src/app/page.tsx");
      expect(paths).toContain("mock/src/app/globals.css");
      expect(paths).toContain("mock/src/lib/scenario-registry.ts");
      expect(paths).toContain("mock/scenarios/.gitkeep");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("globals.css uses production src/app/globals.css when present", () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, "src/app"), { recursive: true });
      const productionContents =
        "/* PROJECT-SPECIFIC TOKENS */\n:root { --my-color: #abcdef; }\n";
      writeFileSync(join(repo, "src/app/globals.css"), productionContents, "utf8");
      const files = planMockFiles({
        cwd: repo,
        force: false,
        dryRun: false,
        runtimeVersion: "^0.1.0",
      });
      const globalsFile = files.find((f) => f.path === "mock/src/app/globals.css");
      expect(globalsFile).toBeDefined();
      expect(globalsFile!.contents).toContain("PROJECT-SPECIFIC TOKENS");
      expect(globalsFile!.contents).toContain("--my-color: #abcdef");
      expect(globalsFile!.contents).toContain("copied from src/app/globals.css");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("globals.css falls back to minimal Tailwind directives when src/app/globals.css absent", () => {
    const repo = mkRepo();
    try {
      const files = planMockFiles({
        cwd: repo,
        force: false,
        dryRun: false,
        runtimeVersion: "^0.1.0",
      });
      const globalsFile = files.find((f) => f.path === "mock/src/app/globals.css");
      expect(globalsFile).toBeDefined();
      expect(globalsFile!.contents).toContain('@import "tailwindcss"');
      expect(globalsFile!.contents).toContain("no src/app/globals.css found");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("package.json + layout.tsx pin the runtime version through", () => {
    const repo = mkRepo();
    try {
      const files = planMockFiles({
        cwd: repo,
        force: false,
        dryRun: false,
        runtimeVersion: "^0.5.0",
      });
      const pkg = files.find((f) => f.path === "mock/package.json")!;
      expect(pkg.contents).toContain('"@slowcook-ai/mock-runtime": "^0.5.0"');
      // (helper default in this version is ^0.1.1 — covered by initMock paths)
      const layout = files.find((f) => f.path === "mock/src/app/layout.tsx")!;
      expect(layout.contents).toContain('from "@slowcook-ai/mock-runtime"');
      const page = files.find((f) => f.path === "mock/src/app/page.tsx")!;
      expect(page.contents).toContain("ScenarioPicker");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("initMock", () => {
  it("dry-run: writes nothing", async () => {
    const repo = mkRepo();
    try {
      await initMock(["--cwd", repo, "--dry-run"], "0.1.0");
      expect(existsSync(join(repo, "mock"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("writes the full skeleton on first run", async () => {
    const repo = mkRepo();
    try {
      await initMock(["--cwd", repo], "0.1.0");
      expect(existsSync(join(repo, "mock/package.json"))).toBe(true);
      expect(existsSync(join(repo, "mock/Dockerfile"))).toBe(true);
      expect(existsSync(join(repo, "mock/tsconfig.json"))).toBe(true);
      expect(existsSync(join(repo, "mock/next.config.js"))).toBe(true);
      expect(existsSync(join(repo, "mock/postcss.config.mjs"))).toBe(true);
      expect(existsSync(join(repo, "mock/.gitignore"))).toBe(true);
      expect(existsSync(join(repo, "mock/README.md"))).toBe(true);
      expect(existsSync(join(repo, "mock/src/app/layout.tsx"))).toBe(true);
      expect(existsSync(join(repo, "mock/src/app/page.tsx"))).toBe(true);
      expect(existsSync(join(repo, "mock/src/app/globals.css"))).toBe(true);
      expect(existsSync(join(repo, "mock/src/lib/scenario-registry.ts"))).toBe(true);
      expect(existsSync(join(repo, "mock/scenarios/.gitkeep"))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("re-run preserves existing files (skip without --force)", async () => {
    const repo = mkRepo();
    try {
      await initMock(["--cwd", repo], "0.1.0");
      // Hand-edit one of the files to simulate consumer customization.
      writeFileSync(
        join(repo, "mock/src/app/page.tsx"),
        "// CONSUMER-EDITED\nexport default function P() { return null; }\n",
        "utf8"
      );
      // Re-run init.
      await initMock(["--cwd", repo], "0.1.0");
      // Customization preserved.
      expect(readFileSync(join(repo, "mock/src/app/page.tsx"), "utf8")).toContain("CONSUMER-EDITED");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("--force overwrites existing files", async () => {
    const repo = mkRepo();
    try {
      await initMock(["--cwd", repo], "0.1.0");
      writeFileSync(join(repo, "mock/src/app/page.tsx"), "// CONSUMER\n", "utf8");
      await initMock(["--cwd", repo, "--force"], "0.1.0");
      const after = readFileSync(join(repo, "mock/src/app/page.tsx"), "utf8");
      expect(after).not.toContain("CONSUMER");
      expect(after).toContain("ScenarioPicker");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
