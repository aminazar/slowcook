import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHistoryIndex,
  discoverPackageDirs,
  scanMigrations,
  parseTypeOrmMigration,
  scanMockSurface,
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

describe("scanMockSurface — 0.19.0-α.23 mock-aware refine context", () => {
  it("returns empty when mock/src is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "slowcook-no-mock-"));
    try {
      expect(scanMockSurface(root, "mock/src")).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("captures a page.tsx with inferred route + name + excerpt", () => {
    const root = mkdtempSync(join(tmpdir(), "slowcook-mock-page-"));
    try {
      mkdirSync(join(root, "mock/src/app/login"), { recursive: true });
      writeFileSync(
        join(root, "mock/src/app/login/page.tsx"),
        `export default function LoginPage() {
  return <form>email + password</form>;
}`,
        "utf8"
      );
      const out = scanMockSurface(root, "mock/src");
      expect(out).toHaveLength(1);
      expect(out[0]!.route).toBe("/login");
      expect(out[0]!.name).toBe("LoginPage");
      expect(out[0]!.excerpt).toContain("email + password");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("strips parenthesised layout-group segments from the route", () => {
    const root = mkdtempSync(join(tmpdir(), "slowcook-mock-group-"));
    try {
      mkdirSync(join(root, "mock/src/app/(patient)/dashboard"), { recursive: true });
      writeFileSync(
        join(root, "mock/src/app/(patient)/dashboard/page.tsx"),
        `export default function Dashboard() { return <div />; }`,
        "utf8"
      );
      const out = scanMockSurface(root, "mock/src");
      // (patient) is a layout group — should NOT appear in the URL
      expect(out[0]!.route).toBe("/dashboard");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("collapses the root page to / not /page.tsx", () => {
    const root = mkdtempSync(join(tmpdir(), "slowcook-mock-root-"));
    try {
      mkdirSync(join(root, "mock/src/app"), { recursive: true });
      writeFileSync(
        join(root, "mock/src/app/page.tsx"),
        `export default function Root() { return <div/>; }`,
        "utf8"
      );
      const out = scanMockSurface(root, "mock/src");
      expect(out[0]!.route).toBe("/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("captures non-page components with route=null", () => {
    const root = mkdtempSync(join(tmpdir(), "slowcook-mock-comp-"));
    try {
      mkdirSync(join(root, "mock/src/components"), { recursive: true });
      writeFileSync(
        join(root, "mock/src/components/TicketCard.tsx"),
        `export function TicketCard() { return null; }`,
        "utf8"
      );
      const out = scanMockSurface(root, "mock/src");
      expect(out).toHaveLength(1);
      expect(out[0]!.route).toBeNull();
      expect(out[0]!.name).toBe("TicketCard");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("truncates excerpts over the 8000-char budget", () => {
    const root = mkdtempSync(join(tmpdir(), "slowcook-mock-big-"));
    try {
      mkdirSync(join(root, "mock/src/app/big"), { recursive: true });
      const huge = "// padding\n".repeat(1500); // ~16KB, well over budget
      writeFileSync(
        join(root, "mock/src/app/big/page.tsx"),
        `export default function Big() {\n${huge}\n  return null;\n}`,
        "utf8"
      );
      const out = scanMockSurface(root, "mock/src");
      expect(out[0]!.excerpt.length).toBeLessThan(8200);
      expect(out[0]!.excerpt).toContain("truncated");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does NOT truncate a typical real-world login mock (~6.4KB)", () => {
    const root = mkdtempSync(join(tmpdir(), "slowcook-mock-realistic-"));
    try {
      mkdirSync(join(root, "mock/src/app/login"), { recursive: true });
      // Approximates delgoosh's 6411-char login mock
      const realisticBody = "x".repeat(6400);
      writeFileSync(join(root, "mock/src/app/login/page.tsx"), realisticBody, "utf8");
      const out = scanMockSurface(root, "mock/src");
      expect(out[0]!.excerpt).not.toContain("truncated");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is exposed via buildHistoryIndex's mock_surface field", () => {
    const root = mkdtempSync(join(tmpdir(), "slowcook-mock-build-"));
    try {
      mkdirSync(join(root, "mock/src/app/login"), { recursive: true });
      writeFileSync(
        join(root, "mock/src/app/login/page.tsx"),
        `export default function L(){return <div/>;}`,
        "utf8"
      );
      const idx = buildHistoryIndex({ repoRoot: root });
      expect(idx.mock_surface).toHaveLength(1);
      expect(idx.mock_surface[0]!.route).toBe("/login");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── workspace-blindness regression (dash dogfood): multi-package repos ──
describe("discoverPackageDirs + multi-root scanning", () => {
  it("indexes tests and components living inside sub-packages", () => {
    const root = mkdtempSync(join(tmpdir(), "hx-ws-"));
    try {
      // dash-like layout: server/ and mock/ are first-level packages
      mkdirSync(join(root, "server", "test"), { recursive: true });
      mkdirSync(join(root, "mock", "src", "components"), { recursive: true });
      writeFileSync(join(root, "server", "package.json"), "{}");
      writeFileSync(join(root, "mock", "package.json"), "{}");
      writeFileSync(join(root, "server", "test", "auth.test.ts"), 'import { x } from "../src/auth.js";\nit("a", () => {});\n');
      writeFileSync(join(root, "mock", "src", "components", "ArtifactGate.tsx"), "export function ArtifactGate() { return null; }\n");

      const dirs = discoverPackageDirs(root);
      expect(dirs).toContain("server");
      expect(dirs).toContain("mock");

      const idx = buildHistoryIndex({ repoRoot: root });
      expect(idx.test_files.length).toBeGreaterThanOrEqual(1);
      expect(idx.test_files.some((t) => t.file.includes("server/test/auth.test.ts"))).toBe(true);
      expect(idx.components.some((c) => c.name === "ArtifactGate")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("scanCodeRoutes (Hono/Express)", () => {
  it("finds app.<method> literal registrations across package src trees", () => {
    const root = mkdtempSync(join(tmpdir(), "hx-cr-"));
    try {
      mkdirSync(join(root, "server", "src"), { recursive: true });
      writeFileSync(join(root, "server", "package.json"), "{}");
      writeFileSync(join(root, "server", "src", "http.ts"),
        'app.get("/api/health", (c) => c.json({ ok: true }));\n' +
        'app.post("/api/webhooks/stripe", handler);\n');
      const idx = buildHistoryIndex({ repoRoot: root });
      const paths = idx.api_routes.map((r) => `${r.method} ${r.path}`);
      expect(paths).toContain("GET /api/health");
      expect(paths).toContain("POST /api/webhooks/stripe");
      expect(idx.api_routes.find((r) => r.path === "/api/health")?.file).toBe("server/src/http.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
