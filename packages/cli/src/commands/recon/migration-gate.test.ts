import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMigrationGate, formatMigrationGap } from "./migration-gate.js";

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "slowcook-mig-gate-"));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function writeSpec(storyId: string, schemaSql: string | undefined): void {
  mkdirSync(join(repo, "specs"), { recursive: true });
  const body: string[] = [
    "schema_version: 1",
    `story_id: "${storyId}"`,
    `title: Test story ${storyId}`,
    "status: active",
    `created_at: "2026-05-13T00:00:00Z"`,
    "supersedes: []",
    "superseded_by: null",
    "actors: []",
    "preconditions: []",
    "invariants: []",
    "acceptance_scenarios: []",
    "non_goals: []",
  ];
  if (schemaSql !== undefined) {
    body.push("proposals:");
    body.push("  schema:");
    body.push("    status: pending");
    body.push("    proposed_by: refine-agent");
    body.push(`    sql: |`);
    for (const line of schemaSql.split("\n")) body.push(`      ${line}`);
  }
  writeFileSync(join(repo, "specs", `story-${storyId}.yaml`), body.join("\n") + "\n", "utf8");
}

function writeMigration(name: string, body: string, format: "sql" | "ts" = "sql"): void {
  const dir = format === "sql" ? "supabase/migrations" : "packages/postgres/src/migrations";
  mkdirSync(join(repo, dir), { recursive: true });
  writeFileSync(join(repo, dir, name), body, "utf8");
}

describe("checkMigrationGate — no-op cases", () => {
  it("returns no gaps when spec is missing", () => {
    const r = checkMigrationGate(repo, "001");
    expect(r.gaps).toEqual([]);
    expect(r.spec_proposes_schema).toBe(false);
    expect(r.notes.some((n) => n.includes("Spec not found"))).toBe(true);
  });

  it("returns no gaps when spec has no schema proposal", () => {
    writeSpec("001", undefined);
    const r = checkMigrationGate(repo, "001");
    expect(r.gaps).toEqual([]);
    expect(r.spec_proposes_schema).toBe(false);
  });

  it("returns no gaps when proposals.schema.sql is empty string", () => {
    writeSpec("001", "");
    const r = checkMigrationGate(repo, "001");
    expect(r.gaps).toEqual([]);
    expect(r.spec_proposes_schema).toBe(false);
  });
});

describe("checkMigrationGate — coverage detection (Supabase)", () => {
  it("clean: spec proposes a table that a SQL migration creates", () => {
    writeSpec("002", "CREATE TABLE notifications (id uuid PRIMARY KEY, kind text);");
    writeMigration(
      "00001_notifications.sql",
      "create table notifications (id uuid primary key, kind text);"
    );
    const r = checkMigrationGate(repo, "002");
    expect(r.spec_proposes_schema).toBe(true);
    expect(r.gaps).toEqual([]);
  });

  it("gap: spec proposes a table no migration creates", () => {
    writeSpec("003", "CREATE TABLE notifications (id uuid PRIMARY KEY);");
    // No migration written.
    mkdirSync(join(repo, "supabase/migrations"), { recursive: true });
    const r = checkMigrationGate(repo, "003");
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0]!.table).toBe("notifications");
    expect(r.gaps[0]!.table_missing).toBe(true);
  });

  it("gap: spec proposes column on existing table but migration doesn't add it", () => {
    writeSpec("004", "ALTER TABLE patients ADD COLUMN consent_version text;");
    writeMigration("00001_patients.sql", "create table patients (id uuid primary key, name text);");
    const r = checkMigrationGate(repo, "004");
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0]!.table).toBe("patients");
    expect(r.gaps[0]!.table_missing).toBe(false);
    expect(r.gaps[0]!.missing_columns).toContain("consent_version");
  });

  it("clean: ALTER TABLE proposal matched by a follow-up migration", () => {
    writeSpec("005", "ALTER TABLE patients ADD COLUMN consent_version text;");
    writeMigration("00001_patients.sql", "create table patients (id uuid primary key);");
    writeMigration(
      "00002_consent.sql",
      "alter table patients add column consent_version text;"
    );
    const r = checkMigrationGate(repo, "005");
    expect(r.gaps).toEqual([]);
  });
});

describe("checkMigrationGate — TypeORM auto-discovery", () => {
  it("uses TypeORM migrations when supabase/migrations is absent", () => {
    writeSpec("006", "CREATE TABLE intake_patients (id uuid PRIMARY KEY, consent_version text);");
    writeMigration(
      "1700-intake.ts",
      `await queryRunner.query(\`CREATE TABLE intake_patients (id uuid PRIMARY KEY, consent_version text)\`);`,
      "ts"
    );
    const r = checkMigrationGate(repo, "006");
    expect(r.spec_proposes_schema).toBe(true);
    expect(r.gaps).toEqual([]);
    expect(r.migrations_scanned).toBe(1);
  });

  it("flags missing-column gap against TypeORM migrations", () => {
    writeSpec(
      "007",
      "ALTER TABLE intake_patients ADD COLUMN new_column text;"
    );
    writeMigration(
      "1700-intake.ts",
      `await queryRunner.query(\`CREATE TABLE intake_patients (id uuid PRIMARY KEY)\`);`,
      "ts"
    );
    const r = checkMigrationGate(repo, "007");
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0]!.missing_columns).toContain("new_column");
  });

  it("treats DatabaseCreateTable helper as authoritative for table existence", () => {
    writeSpec("008", "ALTER TABLE patient_intakes ADD COLUMN consent_version text;");
    writeMigration(
      "1700-intake.ts",
      `await DatabaseCreateTable(queryRunner, 'patient_intakes', [
         { name: 'patient_id', type: 'uuid' },
         { name: 'consent_version', type: 'varchar' },
       ]);`,
      "ts"
    );
    const r = checkMigrationGate(repo, "008");
    // patient_intakes IS created by the helper; consent_version IS one of its
    // columns; the gate is clean.
    expect(r.gaps).toEqual([]);
  });
});

describe("formatMigrationGap", () => {
  it("renders table-missing gap with TypeORM + Supabase recommendation paths", () => {
    const { detail, recommendation } = formatMigrationGap({
      source: "specs/story-009.yaml#proposals.schema.sql",
      table: "notifications",
      missing_columns: ["id", "kind"],
      table_missing: true,
    });
    expect(detail).toContain("notifications");
    expect(detail).toContain("kind");
    expect(recommendation).toContain("packages/postgres/src/migrations");
    expect(recommendation).toContain("supabase/migrations");
  });

  it("renders column-missing gap with ALTER TABLE recommendation", () => {
    const { detail, recommendation } = formatMigrationGap({
      source: "x",
      table: "patients",
      missing_columns: ["consent_version", "verified_at"],
      table_missing: false,
    });
    expect(detail).toContain("consent_version");
    expect(detail).toContain("patients");
    expect(recommendation).toContain("ALTER TABLE patients ADD COLUMN");
    expect(recommendation).toContain("consent_version");
  });
});
