import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHistoryIndex,
  scanMigrations,
  parseTypeOrmMigration,
} from "./history-index.js";

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "slowcook-history-"));
  // src/components/members/MyComp.tsx
  mkdirSync(join(repo, "src/components/members"), { recursive: true });
  writeFileSync(
    join(repo, "src/components/members/MyComp.tsx"),
    `"use client";
interface Props { owner: string; viewer?: string; reactions?: unknown[]; pins?: unknown[] }
export function MyComp({ owner }: Props) { return <div>{owner}</div>; }
export default MyComp;
`,
    "utf8"
  );
  // src/app/api/things/route.ts
  mkdirSync(join(repo, "src/app/api/things"), { recursive: true });
  writeFileSync(
    join(repo, "src/app/api/things/route.ts"),
    `export async function GET() {} export async function POST() {}`,
    "utf8"
  );
  // supabase/migrations/00001_things.sql
  mkdirSync(join(repo, "supabase/migrations"), { recursive: true });
  writeFileSync(
    join(repo, "supabase/migrations/00001_things.sql"),
    `create table things (id uuid primary key, name text, created_at timestamptz);
alter table things add column status text;`,
    "utf8"
  );
  // tests/helpers/render.tsx
  mkdirSync(join(repo, "tests/helpers"), { recursive: true });
  writeFileSync(
    join(repo, "tests/helpers/render.tsx"),
    `/** Wrap component with providers for testing. */
export function renderWithProviders() {}
`,
    "utf8"
  );
  // tests/integration/foo.test.tsx — imports MyComp
  mkdirSync(join(repo, "tests/integration"), { recursive: true });
  writeFileSync(
    join(repo, "tests/integration/foo.test.tsx"),
    `import { MyComp } from "@/components/members/MyComp";
describe("foo", () => { it("renders", () => {}) });`,
    "utf8"
  );
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("buildHistoryIndex", () => {
  it("scans components + extracts props", () => {
    const idx = buildHistoryIndex({ repoRoot: repo });
    const c = idx.components.find((c) => c.name === "MyComp");
    expect(c).toBeDefined();
    expect(c!.props).toEqual(["owner", "viewer?", "reactions?", "pins?"]);
    expect(c!.file).toBe("src/components/members/MyComp.tsx");
  });

  it("scans api routes + extracts methods", () => {
    const idx = buildHistoryIndex({ repoRoot: repo });
    const get = idx.api_routes.find((r) => r.path.includes("things") && r.method === "GET");
    const post = idx.api_routes.find((r) => r.path.includes("things") && r.method === "POST");
    expect(get).toBeDefined();
    expect(post).toBeDefined();
  });

  it("scans migrations + extracts tables + columns", () => {
    const idx = buildHistoryIndex({ repoRoot: repo });
    const m = idx.migrations.find((m) => m.file === "00001_things.sql");
    expect(m).toBeDefined();
    expect(m!.tables_created).toContain("things");
    expect(m!.columns_added.things).toEqual(expect.arrayContaining(["id", "name", "created_at", "status"]));
  });

  it("scans test helpers + extracts purpose from JSDoc", () => {
    const idx = buildHistoryIndex({ repoRoot: repo });
    const h = idx.test_helpers.find((h) => h.name === "renderWithProviders");
    expect(h).toBeDefined();
    expect(h!.purpose).toContain("providers");
  });

  it("reverse-indexes test → component coverage", () => {
    const idx = buildHistoryIndex({ repoRoot: repo });
    const c = idx.components.find((c) => c.name === "MyComp")!;
    expect(c.tests_covering).toContain("tests/integration/foo.test.tsx");
  });

  it("captures test file imports + test names", () => {
    const idx = buildHistoryIndex({ repoRoot: repo });
    const t = idx.test_files.find((t) => t.file.includes("foo.test"));
    expect(t).toBeDefined();
    expect(t!.imports).toContain("@/components/members/MyComp");
    expect(t!.test_names).toEqual(expect.arrayContaining(["foo", "renders"]));
  });

  it("returns empty arrays for missing scan paths", () => {
    const empty = mkdtempSync(join(tmpdir(), "slowcook-empty-"));
    try {
      const idx = buildHistoryIndex({ repoRoot: empty });
      expect(idx.components).toEqual([]);
      expect(idx.api_routes).toEqual([]);
      expect(idx.migrations).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("parseTypeOrmMigration — raw SQL via queryRunner.query", () => {
  it("extracts CREATE TABLE from a template-string SQL body", () => {
    const body = `
      import { MigrationInterface, QueryRunner } from 'typeorm';
      export class X1700 implements MigrationInterface {
        async up(qr: QueryRunner) {
          await queryRunner.query(\`
            CREATE TABLE notifications (
              id uuid PRIMARY KEY,
              user_id uuid NOT NULL,
              kind text NOT NULL,
              seen_at timestamptz
            );
          \`);
        }
      }
    `;
    const entry = parseTypeOrmMigration("1700-notifications.ts", body);
    expect(entry.tables_created).toContain("notifications");
    expect(entry.columns_added.notifications).toEqual(
      expect.arrayContaining(["id", "user_id", "kind", "seen_at"])
    );
  });

  it("captures ALTER TABLE ADD COLUMN", () => {
    const body = `
      await queryRunner.query(\`ALTER TABLE patients ADD COLUMN consent_version text\`);
    `;
    const entry = parseTypeOrmMigration("alter.ts", body);
    expect(entry.columns_added.patients).toContain("consent_version");
  });
});

describe("parseTypeOrmMigration — DatabaseCreateTable helper", () => {
  it("extracts table + explicit columns + implicit helper-added columns", () => {
    const body = `
      import { DatabaseCreateTable } from './utils';
      await DatabaseCreateTable(queryRunner, 'patient_intakes', [
        { name: 'patient_id', type: 'uuid', isNullable: false },
        { name: 'consent_version', type: 'varchar', length: '50' },
        { name: 'submitted_at', type: 'timestamptz' },
      ]);
    `;
    const entry = parseTypeOrmMigration("intake.ts", body);
    expect(entry.tables_created).toContain("patient_intakes");
    const cols = entry.columns_added.patient_intakes;
    // explicit
    expect(cols).toEqual(
      expect.arrayContaining(["patient_id", "consent_version", "submitted_at"])
    );
    // implicit helper columns
    expect(cols).toEqual(
      expect.arrayContaining(["id", "created_at", "updated_at", "deleted_at"])
    );
  });

  it("handles multiple DatabaseCreateTable calls in one migration", () => {
    const body = `
      await DatabaseCreateTable(queryRunner, 'one', [{ name: 'a', type: 'text' }]);
      await DatabaseCreateTable(queryRunner, 'two', [{ name: 'b', type: 'int' }]);
    `;
    const entry = parseTypeOrmMigration("multi.ts", body);
    expect(entry.tables_created).toEqual(expect.arrayContaining(["one", "two"]));
    expect(entry.columns_added.one).toContain("a");
    expect(entry.columns_added.two).toContain("b");
  });

  it("combines helper + raw SQL within the same migration", () => {
    const body = `
      await DatabaseCreateTable(queryRunner, 'parent', [{ name: 'label', type: 'text' }]);
      await queryRunner.query(\`CREATE TABLE child (id uuid PRIMARY KEY, parent_id uuid)\`);
      await queryRunner.query(\`ALTER TABLE parent ADD COLUMN extra text\`);
    `;
    const entry = parseTypeOrmMigration("hybrid.ts", body);
    expect(entry.tables_created).toEqual(expect.arrayContaining(["parent", "child"]));
    expect(entry.columns_added.parent).toEqual(
      expect.arrayContaining(["label", "extra", "id", "created_at"])
    );
    expect(entry.columns_added.child).toContain("parent_id");
  });
});

describe("scanMigrations — auto-discovery + mixed formats", () => {
  it("falls back to packages/postgres/src/migrations when supabase/migrations is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "slowcook-typeorm-"));
    try {
      mkdirSync(join(root, "packages/postgres/src/migrations"), { recursive: true });
      writeFileSync(
        join(root, "packages/postgres/src/migrations/1700-x.ts"),
        `await queryRunner.query(\`CREATE TABLE x (id uuid PRIMARY KEY)\`);`,
        "utf8"
      );
      const migrations = scanMigrations(root, "supabase/migrations");
      expect(migrations).toHaveLength(1);
      expect(migrations[0]!.tables_created).toContain("x");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers the configured directory when it exists (Supabase still wins)", () => {
    const root = mkdtempSync(join(tmpdir(), "slowcook-mixed-"));
    try {
      // BOTH dirs exist. Configured `supabase/migrations` should be preferred —
      // a hybrid project shouldn't double-count.
      mkdirSync(join(root, "supabase/migrations"), { recursive: true });
      writeFileSync(
        join(root, "supabase/migrations/01_supabase.sql"),
        `create table supabase_only (id uuid primary key);`,
        "utf8"
      );
      mkdirSync(join(root, "packages/postgres/src/migrations"), { recursive: true });
      writeFileSync(
        join(root, "packages/postgres/src/migrations/02_typeorm.ts"),
        `await queryRunner.query(\`CREATE TABLE typeorm_only (id uuid)\`);`,
        "utf8"
      );
      const migrations = scanMigrations(root, "supabase/migrations");
      const tables = migrations.flatMap((m) => m.tables_created);
      expect(tables).toContain("supabase_only");
      expect(tables).not.toContain("typeorm_only");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns empty when neither configured nor fallback dirs exist", () => {
    const root = mkdtempSync(join(tmpdir(), "slowcook-none-"));
    try {
      expect(scanMigrations(root, "supabase/migrations")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
