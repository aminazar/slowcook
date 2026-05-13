import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extract } from "./index.js";

function mkRepo(): string {
  return mkdtempSync(join(tmpdir(), "slowcook-extract-"));
}

describe("extract command", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it("with no flag: runs schema + tokens + entities (default)", async () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, "supabase/migrations"), { recursive: true });
      writeFileSync(
        join(repo, "supabase/migrations/00001.sql"),
        `create table p (id uuid primary key);\n`,
        "utf8"
      );
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(
        join(repo, "src/style.css"),
        `:root { --c: #fff; }\n`,
        "utf8"
      );
      mkdirSync(join(repo, "src/entities"), { recursive: true });
      writeFileSync(
        join(repo, "src/entities/p.entity.ts"),
        `import { Entity } from 'typeorm';\n@Entity('p')\nexport class P extends BaseEntity { }\n`,
        "utf8"
      );

      await extract(["--cwd", repo], "0.0.0-test");

      expect(existsSync(join(repo, ".brewing/diagrams/schema.mmd"))).toBe(true);
      expect(existsSync(join(repo, ".brewing/diagrams/tokens.md"))).toBe(true);
      expect(existsSync(join(repo, ".brewing/diagrams/entities.md"))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("with --entities only: skips schema + tokens", async () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, "src/entities"), { recursive: true });
      writeFileSync(
        join(repo, "src/entities/p.entity.ts"),
        `import { Entity } from 'typeorm';\n@Entity('p')\nexport class P extends BaseEntity { }\n`,
        "utf8"
      );

      await extract(["--cwd", repo, "--entities"], "0.0.0-test");

      expect(existsSync(join(repo, ".brewing/diagrams/schema.mmd"))).toBe(false);
      expect(existsSync(join(repo, ".brewing/diagrams/tokens.md"))).toBe(false);
      expect(existsSync(join(repo, ".brewing/diagrams/entities.md"))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("with --schema only: skips tokens", async () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, "supabase/migrations"), { recursive: true });
      writeFileSync(
        join(repo, "supabase/migrations/00001.sql"),
        `create table p (id uuid primary key);\n`,
        "utf8"
      );
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(
        join(repo, "src/style.css"),
        `:root { --c: #fff; }\n`,
        "utf8"
      );

      await extract(["--cwd", repo, "--schema"], "0.0.0-test");

      expect(existsSync(join(repo, ".brewing/diagrams/schema.mmd"))).toBe(true);
      expect(existsSync(join(repo, ".brewing/diagrams/tokens.md"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("with --tokens only: skips schema", async () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, "supabase/migrations"), { recursive: true });
      writeFileSync(
        join(repo, "supabase/migrations/00001.sql"),
        `create table p (id uuid primary key);\n`,
        "utf8"
      );
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(
        join(repo, "src/style.css"),
        `:root { --c: #fff; }\n`,
        "utf8"
      );

      await extract(["--cwd", repo, "--tokens"], "0.0.0-test");

      expect(existsSync(join(repo, ".brewing/diagrams/schema.mmd"))).toBe(false);
      expect(existsSync(join(repo, ".brewing/diagrams/tokens.md"))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("logs friendly skip-message when no inputs are present (greenfield)", async () => {
    const repo = mkRepo();
    try {
      await extract(["--cwd", repo], "0.0.0-test");
      const logs = logSpy.mock.calls.flat().join("\n");
      expect(logs).toContain("Skipped schema extract");
      expect(logs).toContain("Skipped tokens extract");
      expect(logs).toContain("Skipped entities extract");
      expect(existsSync(join(repo, ".brewing/diagrams/schema.mmd"))).toBe(false);
      expect(existsSync(join(repo, ".brewing/diagrams/tokens.md"))).toBe(false);
      expect(existsSync(join(repo, ".brewing/diagrams/entities.md"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
