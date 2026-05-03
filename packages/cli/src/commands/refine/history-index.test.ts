import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHistoryIndex } from "./history-index.js";

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
