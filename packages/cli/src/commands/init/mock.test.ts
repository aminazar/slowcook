import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initMock,
  planMockFiles,
  parseMockInitArgs,
  ensureMockInTsconfigExclude,
  detectPackageManager,
  isMockInPnpmWorkspace,
  ensurePnpmWorkspace,
} from "./mock.js";

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
      await initMock(["--cwd", repo, "--shape", "nextjs", "--dry-run"], "0.1.0");
      expect(existsSync(join(repo, "mock"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("writes the full skeleton on first run", async () => {
    const repo = mkRepo();
    try {
      await initMock(["--cwd", repo, "--shape", "nextjs"], "0.1.0");
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
      await initMock(["--cwd", repo, "--shape", "nextjs"], "0.1.0");
      // Hand-edit one of the files to simulate consumer customization.
      writeFileSync(
        join(repo, "mock/src/app/page.tsx"),
        "// CONSUMER-EDITED\nexport default function P() { return null; }\n",
        "utf8"
      );
      // Re-run init.
      await initMock(["--cwd", repo, "--shape", "nextjs"], "0.1.0");
      // Customization preserved.
      expect(readFileSync(join(repo, "mock/src/app/page.tsx"), "utf8")).toContain("CONSUMER-EDITED");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("--force overwrites existing files", async () => {
    const repo = mkRepo();
    try {
      await initMock(["--cwd", repo, "--shape", "nextjs"], "0.1.0");
      writeFileSync(join(repo, "mock/src/app/page.tsx"), "// CONSUMER\n", "utf8");
      await initMock(["--cwd", repo, "--shape", "nextjs", "--force"], "0.1.0");
      const after = readFileSync(join(repo, "mock/src/app/page.tsx"), "utf8");
      expect(after).not.toContain("CONSUMER");
      expect(after).toContain("ScenarioPicker");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("ensureMockInTsconfigExclude", () => {
  function withTmp(fn: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "slowcook-tsconfig-"));
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it("adds 'mock' to a tsconfig with existing exclude", () => {
    withTmp((dir) => {
      const path = join(dir, "tsconfig.json");
      writeFileSync(path, JSON.stringify({ exclude: ["node_modules"] }, null, 2), "utf8");
      expect(ensureMockInTsconfigExclude(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toMatch(/"exclude"\s*:\s*\[[^\]]*"mock"[^\]]*\]/);
    });
  });

  it("no-op when 'mock' already in exclude", () => {
    withTmp((dir) => {
      const path = join(dir, "tsconfig.json");
      const original = JSON.stringify({ exclude: ["node_modules", "mock"] }, null, 2);
      writeFileSync(path, original, "utf8");
      expect(ensureMockInTsconfigExclude(path)).toBe(false);
      expect(readFileSync(path, "utf8")).toBe(original);
    });
  });

  it("no-op when tsconfig has no exclude field", () => {
    withTmp((dir) => {
      const path = join(dir, "tsconfig.json");
      const original = JSON.stringify({ compilerOptions: { strict: true } }, null, 2);
      writeFileSync(path, original, "utf8");
      expect(ensureMockInTsconfigExclude(path)).toBe(false);
      expect(readFileSync(path, "utf8")).toBe(original);
    });
  });

  it("handles inline exclude (rewo-shape)", () => {
    withTmp((dir) => {
      const path = join(dir, "tsconfig.json");
      writeFileSync(path, `{\n  "exclude": ["node_modules", "supabase/functions"]\n}\n`, "utf8");
      expect(ensureMockInTsconfigExclude(path)).toBe(true);
      const after = readFileSync(path, "utf8");
      expect(after).toContain('"node_modules"');
      expect(after).toContain('"supabase/functions"');
      expect(after).toContain('"mock"');
    });
  });

  it("handles empty exclude array", () => {
    withTmp((dir) => {
      const path = join(dir, "tsconfig.json");
      writeFileSync(path, `{ "exclude": [] }`, "utf8");
      expect(ensureMockInTsconfigExclude(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toContain('["mock"]');
    });
  });
});

describe("detectPackageManager", () => {
  const exists = (paths: string[]) => (p: string) => paths.includes(p);

  it("returns pnpm when pnpm-workspace.yaml is present", () => {
    expect(detectPackageManager("/repo", exists(["/repo/pnpm-workspace.yaml"]))).toBe("pnpm");
  });

  it("returns pnpm when only pnpm-lock.yaml is present", () => {
    expect(detectPackageManager("/repo", exists(["/repo/pnpm-lock.yaml"]))).toBe("pnpm");
  });

  it("returns yarn when yarn.lock is present", () => {
    expect(detectPackageManager("/repo", exists(["/repo/yarn.lock"]))).toBe("yarn");
  });

  it("returns npm when package-lock.json is present", () => {
    expect(detectPackageManager("/repo", exists(["/repo/package-lock.json"]))).toBe("npm");
  });

  it("returns unknown when no lockfile present", () => {
    expect(detectPackageManager("/repo", exists([]))).toBe("unknown");
  });

  it("prefers pnpm signal even if a package-lock.json also exists", () => {
    expect(detectPackageManager("/repo", exists(["/repo/pnpm-lock.yaml", "/repo/package-lock.json"]))).toBe("pnpm");
  });
});

describe("isMockInPnpmWorkspace", () => {
  it("detects mock in block-list form", () => {
    expect(isMockInPnpmWorkspace(`packages:\n  - mock\n  - apps/web\n`)).toBe(true);
  });

  it("detects mock in quoted block-list form", () => {
    expect(isMockInPnpmWorkspace(`packages:\n  - "mock"\n`)).toBe(true);
  });

  it("detects mock in flow-array form", () => {
    expect(isMockInPnpmWorkspace(`packages: [mock, "apps/*"]\n`)).toBe(true);
  });

  it("returns false when mock not present", () => {
    expect(isMockInPnpmWorkspace(`packages:\n  - apps/web\n  - packages/*\n`)).toBe(false);
  });

  it("ignores 'mock' inside comments", () => {
    expect(isMockInPnpmWorkspace(`packages:\n  - apps/web\n  # - mock (commented out)\n`)).toBe(false);
  });

  it("matches mock-as-substring only when whole-entry", () => {
    // 'mock-runtime' as a substring should NOT count as 'mock'
    expect(isMockInPnpmWorkspace(`packages:\n  - mock-runtime\n  - apps/*\n`)).toBe(false);
  });
});

describe("ensurePnpmWorkspace", () => {
  function withTmp(fn: (dir: string) => void): void {
    const dir = mkRepo();
    try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it("returns not-pnpm when consumer has no pnpm signal", () => {
    withTmp((dir) => {
      writeFileSync(join(dir, "package-lock.json"), "{}", "utf8");
      const r = ensurePnpmWorkspace(dir);
      expect(r.kind).toBe("not-pnpm");
      if (r.kind === "not-pnpm") expect(r.pkgManager).toBe("npm");
      expect(existsSync(join(dir, "pnpm-workspace.yaml"))).toBe(false);
    });
  });

  it("creates pnpm-workspace.yaml when consumer is pnpm but has no workspace file", () => {
    withTmp((dir) => {
      writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9.0\n", "utf8");
      const r = ensurePnpmWorkspace(dir);
      expect(r.kind).toBe("created");
      const written = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf8");
      expect(written).toContain("packages:");
      expect(written).toContain("- mock");
    });
  });

  it("appends mock to existing block-list workspace", () => {
    withTmp((dir) => {
      writeFileSync(
        join(dir, "pnpm-workspace.yaml"),
        `packages:\n  - apps/web\n  - packages/*\n`,
        "utf8",
      );
      const r = ensurePnpmWorkspace(dir);
      expect(r.kind).toBe("added-to-existing");
      const written = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf8");
      expect(written).toContain("- mock");
      // Prior entries preserved
      expect(written).toContain("- apps/web");
      expect(written).toContain("- packages/*");
    });
  });

  it("reports already-listed when mock is already declared", () => {
    withTmp((dir) => {
      writeFileSync(
        join(dir, "pnpm-workspace.yaml"),
        `packages:\n  - mock\n  - apps/*\n`,
        "utf8",
      );
      const before = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf8");
      const r = ensurePnpmWorkspace(dir);
      expect(r.kind).toBe("already-listed");
      // File untouched
      expect(readFileSync(join(dir, "pnpm-workspace.yaml"), "utf8")).toBe(before);
    });
  });

  it("preserves prior list-item indentation when appending", () => {
    withTmp((dir) => {
      writeFileSync(
        join(dir, "pnpm-workspace.yaml"),
        `packages:\n    - apps/web\n`,  // 4-space indent
        "utf8",
      );
      const r = ensurePnpmWorkspace(dir);
      expect(r.kind).toBe("added-to-existing");
      const written = readFileSync(join(dir, "pnpm-workspace.yaml"), "utf8");
      expect(written).toContain("    - mock");
    });
  });
});
