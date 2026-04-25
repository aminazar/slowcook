import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitSchemaDiagram } from "./index.js";

function mkRepo(): string {
  return mkdtempSync(join(tmpdir(), "slowcook-emit-schema-"));
}

describe("emitSchemaDiagram", () => {
  it("skips silently when supabase/migrations/ is missing", () => {
    const repo = mkRepo();
    try {
      const result = emitSchemaDiagram(repo);
      expect(result.written).toBe(false);
      expect(result.skippedReason).toContain("no supabase/migrations/");
      expect(existsSync(join(repo, ".brewing/diagrams/schema.mmd"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("skips when supabase/migrations/ is empty", () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, "supabase/migrations"), { recursive: true });
      const result = emitSchemaDiagram(repo);
      expect(result.written).toBe(false);
      expect(result.skippedReason).toContain("empty");
      expect(existsSync(join(repo, ".brewing/diagrams/schema.mmd"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("writes a Mermaid erDiagram from concatenated migrations", () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, "supabase/migrations"), { recursive: true });
      writeFileSync(
        join(repo, "supabase/migrations/00001_init.sql"),
        `create table profiles (
  id uuid primary key,
  handle text not null
);
`,
        "utf8"
      );
      writeFileSync(
        join(repo, "supabase/migrations/00002_rewos.sql"),
        `create table rewos (
  id uuid primary key,
  owner_id uuid references profiles(id),
  url text not null
);
`,
        "utf8"
      );

      const result = emitSchemaDiagram(repo);
      expect(result.written).toBe(true);
      expect(result.migrationsCount).toBe(2);
      expect(result.entityCount).toBe(2);

      const out = readFileSync(
        join(repo, ".brewing/diagrams/schema.mmd"),
        "utf8"
      );
      expect(out).toContain("Auto-emitted by");
      expect(out).toContain("erDiagram");
      expect(out).toMatch(/PROFILES\s*\{/);
      expect(out).toMatch(/REWOS\s*\{/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("processes migrations in lexical order (so later DDL wins)", () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, "supabase/migrations"), { recursive: true });
      writeFileSync(
        join(repo, "supabase/migrations/00002_b.sql"),
        `create table b (id uuid primary key);\n`,
        "utf8"
      );
      writeFileSync(
        join(repo, "supabase/migrations/00001_a.sql"),
        `create table a (id uuid primary key);\n`,
        "utf8"
      );
      const result = emitSchemaDiagram(repo);
      expect(result.written).toBe(true);
      expect(result.migrationsCount).toBe(2);
      const out = readFileSync(
        join(repo, ".brewing/diagrams/schema.mmd"),
        "utf8"
      );
      // Both entities present.
      expect(out).toMatch(/A\s*\{/);
      expect(out).toMatch(/B\s*\{/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
