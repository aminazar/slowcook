/**
 * @slowcook 0.17.0 — refine becomes history-aware.
 *
 * Builds a structured snapshot of the consumer's existing brownfield
 * surface so refine (and downstream vibe + testgen + brew) can answer
 * "what already exists for this story?" mechanically instead of by
 * hallucination.
 *
 * The output (`.brewing/history-index.json`) is the input contract for:
 *   - refine's brownfield-conflict Q&A (does new spec collide with
 *     existing component prop shape, existing migration columns, etc.?)
 *   - vibe's "extend existing file, don't create duplicate" rule
 *   - testgen's "use existing prop names + existing test helpers" rule
 *   - brew's "what already exists in migrations/handlers?" pre-check
 *   - recon's brownfield rename-safety check
 *
 * Pure functions over the filesystem. No LLM. Generated on every refine
 * invocation so it's always current.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { GitAttentionData } from "./git-attention.js";

export interface ComponentEntry {
  /** PascalCase component name (the default-export or first named export). */
  name: string;
  /** repo-relative path */
  file: string;
  /** Top-level Props interface keys (e.g. ["owner", "viewer", "reactions?", "pins?"]). */
  props: string[];
  /** Test files (repo-relative) that import this component. */
  tests_covering: string[];
}

export interface ApiRouteEntry {
  /** HTTP method exported by the route (GET/POST/PUT/PATCH/DELETE). */
  method: string;
  /** URL path (e.g. /api/bookmarks, /api/members/[handle]/reactions). */
  path: string;
  /** repo-relative file */
  file: string;
}

export interface MigrationEntry {
  /** Migration file basename. */
  file: string;
  /** Tables created in this migration (`create table X`). */
  tables_created: string[];
  /** Map of table → columns added (in this migration's create + alter add column). */
  columns_added: Record<string, string[]>;
}

export interface TestHelperEntry {
  /** Exported symbol name. */
  name: string;
  /** repo-relative file. */
  file: string;
  /** Best-effort one-line purpose extracted from JSDoc or first comment. */
  purpose: string;
}

export interface TestFileEntry {
  /** repo-relative path. */
  file: string;
  /** Imports the file makes (only `@/...` and relative paths captured). */
  imports: string[];
  /** describe / it titles found in the file (best-effort regex). */
  test_names: string[];
}

/**
 * A mock page or component, captured so refine can answer
 * "match the mock" without making the PM cite paths.
 *
 * 0.19.0-α.23 — added because real PM issues describe user pain
 * ("registration should look like the mock"), and the indexer
 * previously only saw production `src/`. Refine then either
 * hallucinated a design or had to ask. Surfacing mock files in
 * context closes the loop: PM says "as mock" → refine reads the
 * actual mock excerpt → spec mirrors it.
 *
 * The excerpt is bounded to the first ~1.5KB so refine's prompt
 * doesn't blow up on a 5KB mock file.
 */
export interface MockEntry {
  /** repo-relative path. */
  file: string;
  /** Route inferred from app/router-shape file location, or null for components. */
  route: string | null;
  /** Component or page name (best-effort extraction, falls back to file basename). */
  name: string;
  /** First ~1500 chars of the file (after trimming whitespace) so refine sees the actual JSX/markup. */
  excerpt: string;
}

export interface HistoryIndex {
  generated_at: string;
  generator: "slowcook-refine-history-index@0.17.0";
  components: ComponentEntry[];
  api_routes: ApiRouteEntry[];
  migrations: MigrationEntry[];
  test_helpers: TestHelperEntry[];
  test_files: TestFileEntry[];
  /** 0.19.0-α.23 — mock surface (design source-of-truth). */
  mock_surface: MockEntry[];
  /**
   * 0.19.0-α.43 — git-history attention layer. Set when enrichment ran
   * (refine emits with it on by default; pure-filesystem callers / tests
   * may leave it undefined). See git-attention.ts for the four sub-signals.
   */
  git_attention?: GitAttentionData;
}

interface BuildOptions {
  repoRoot: string;
  /** Override default scan paths (used by tests). */
  scanPaths?: {
    components?: string;
    api?: string;
    migrations?: string;
    tests?: string;
    helpers?: string;
    /** Default: `mock/src` (matches slowcook init scaffold). */
    mockRoot?: string;
  };
}

export function buildHistoryIndex(opts: BuildOptions): HistoryIndex {
  const { repoRoot } = opts;

  // sc: workspace-blindness fix. Single hardcoded roots made the index report
  // "0 components · 0 api routes · 0 tests" on any multi-package repo (dash:
  // components under mock/src, 60+ tests under server/test), so agents
  // invented parallel conventions instead of following the repo's. Every
  // convention path now scans across ALL package roots (repo root + any
  // first-level dir holding a package.json + pnpm-workspace globs). An
  // explicit scanPaths override still pins a single path (test seam).
  const pkgDirs = discoverPackageDirs(repoRoot);
  const expand = (sub: string): string[] =>
    pkgDirs.map((d) => (d === "" ? sub : `${d}/${sub}`));
  const candidates = {
    components: opts.scanPaths?.components
      ? [opts.scanPaths.components]
      : [...expand("src/components"), ...expand("src/pages")],
    api: opts.scanPaths?.api ? [opts.scanPaths.api] : expand("src/app/api"),
    migrations: opts.scanPaths?.migrations
      ? [opts.scanPaths.migrations]
      : [...expand("supabase/migrations"), ...expand("migrations"), ...expand("src/db")],
    tests: opts.scanPaths?.tests
      ? [opts.scanPaths.tests]
      : [...expand("tests"), ...expand("test")],
    helpers: opts.scanPaths?.helpers
      ? [opts.scanPaths.helpers]
      : [...expand("tests/helpers"), ...expand("test/helpers"), ...expand("test/mocks")],
    mockRoot: opts.scanPaths?.mockRoot ?? "mock/src",
  };
  const scanAll = <T>(dirs: string[], scan: (repoRoot: string, dir: string) => T[]): T[] =>
    dirs.flatMap((d) => scan(repoRoot, d));

  const components = scanAll(candidates.components, scanComponents);
  const api_routes = [
    ...scanAll(candidates.api, scanApiRoutes),
    ...scanCodeRoutes(repoRoot, pkgDirs),
  ];
  const migrations = scanAll(candidates.migrations, scanMigrations);
  const test_helpers = scanAll(candidates.helpers, scanTestHelpers);
  const test_files = scanAll(candidates.tests, scanTestFiles);
  const mock_surface = scanMockSurface(repoRoot, candidates.mockRoot);

  // Reverse-index test → component coverage (which components each test
  // imports → annotate components.tests_covering).
  for (const t of test_files) {
    for (const imp of t.imports) {
      const match = components.find((c) => imp.endsWith(c.name) || imp.endsWith(c.name + "\""));
      if (match && !match.tests_covering.includes(t.file)) {
        match.tests_covering.push(t.file);
      }
    }
  }

  return {
    generated_at: new Date().toISOString(),
    generator: "slowcook-refine-history-index@0.17.0",
    components,
    api_routes,
    migrations,
    test_helpers,
    mock_surface,
    test_files,
  };
}

// ----- Component scanner -----

function scanComponents(repoRoot: string, dir: string): ComponentEntry[] {
  const root = join(repoRoot, dir);
  if (!existsSync(root)) return [];
  const out: ComponentEntry[] = [];
  for (const file of walkFiles(root, /\.tsx$/)) {
    const rel = relative(repoRoot, file).replace(/\\/g, "/");
    const body = readFileSync(file, "utf8");
    const name = extractComponentName(body, rel);
    if (!name) continue;
    const props = extractPropsFields(body, name);
    out.push({ name, file: rel, props, tests_covering: [] });
  }
  return out;
}

function extractComponentName(body: string, file: string): string | null {
  // Prefer explicit `export function ComponentName` / `export default function ComponentName`
  const fnMatch = body.match(/export\s+(?:default\s+)?function\s+([A-Z][A-Za-z0-9_]*)/);
  if (fnMatch && fnMatch[1]) return fnMatch[1];
  // Fall back to `export const ComponentName = (...) =>`
  const arrowMatch = body.match(/export\s+(?:default\s+)?const\s+([A-Z][A-Za-z0-9_]*)\s*[:=]/);
  if (arrowMatch && arrowMatch[1]) return arrowMatch[1];
  // Default export of a name elsewhere in the file
  const defaultExportMatch = body.match(/export\s+default\s+([A-Z][A-Za-z0-9_]*)\s*;?/);
  if (defaultExportMatch && defaultExportMatch[1]) return defaultExportMatch[1];
  // PascalCase from filename as last resort
  const baseName = file.split("/").pop()?.replace(/\.tsx$/, "") ?? "";
  if (/^[A-Z]/.test(baseName)) return baseName;
  return null;
}

function extractPropsFields(body: string, componentName: string): string[] {
  // Look for `interface XProps { ... }` or `type XProps = { ... }` near component.
  const propsRe = new RegExp(
    `(?:interface|type)\\s+${componentName}Props\\s*=?\\s*\\{([^}]+)\\}`,
    "s"
  );
  let match = body.match(propsRe);
  if (!match) {
    // Fall back to generic `Props` (common in single-component files).
    match = body.match(/(?:interface|type)\s+Props\s*=?\s*\{([^}]+)\}/s);
  }
  if (!match || !match[1]) return [];
  const inside = match[1];
  // Field lines: `name: T` or `name?: T`. Capture name + optional `?`.
  const fields: string[] = [];
  for (const line of inside.split(/\n|;/)) {
    const m = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)(\??)\s*:/);
    if (m && m[1] !== undefined && m[2] !== undefined) fields.push(m[1] + m[2]);
  }
  return fields;
}

// ----- API route scanner -----

function scanApiRoutes(repoRoot: string, dir: string): ApiRouteEntry[] {
  const root = join(repoRoot, dir);
  if (!existsSync(root)) return [];
  const out: ApiRouteEntry[] = [];
  for (const file of walkFiles(root, /route\.(ts|tsx)$/)) {
    const rel = relative(repoRoot, file).replace(/\\/g, "/");
    const body = readFileSync(file, "utf8");
    const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];
    const path = pathFromRouteFile(rel, dir);
    for (const m of methods) {
      if (new RegExp(`\\bexport\\s+async\\s+function\\s+${m}\\b`).test(body)) {
        out.push({ method: m, path, file: rel });
      }
    }
  }
  return out;
}

function pathFromRouteFile(routeRel: string, apiDir: string): string {
  // src/app/api/foo/[id]/route.ts → /api/foo/[id]
  const segments = routeRel
    .replace(/route\.(ts|tsx)$/, "")
    .replace(new RegExp(`^src/app/${apiDir.replace("src/app/", "").replace(/\/$/, "")}/?`), "");
  // Easier: just strip everything before `/api/` and the route filename.
  const idx = routeRel.indexOf("/api/");
  if (idx === -1) return "/" + segments.replace(/\/$/, "");
  const apiPath = routeRel.slice(idx).replace(/route\.(ts|tsx)$/, "").replace(/\/$/, "");
  return apiPath || "/api";
}

// ----- Migrations scanner -----
//
// Two flavours supported, dispatched per-file:
//   *.sql → Supabase / Postgres / plain DDL                (existing)
//   *.ts  → TypeORM `MigrationInterface` migrations        (added 0.19.0-α.18)
//
// Auto-discovery: if the configured `dir` doesn't exist, we try a list of
// known TypeORM conventions (`packages/postgres/src/migrations`, `src/migrations`,
// `migrations`). This is how slowcook starts seeing brownfield TypeORM repos
// like delgoosh-monorepo without per-project configuration.
//
// EXPORTED for use by the migration gate in `recon` and tests.

export const TYPEORM_MIGRATION_FALLBACK_DIRS = [
  "packages/postgres/src/migrations",
  "src/migrations",
  "migrations",
];

/**
 * The columns `DatabaseCreateTable` (delgoosh's helper) adds implicitly on
 * EVERY table. Knowing these prevents the migration gate from raising a
 * false-positive "missing column" verdict when the spec references e.g.
 * `created_at` and the migration uses the helper.
 *
 * Kept conservative: only columns added by the helper at delgoosh-monorepo's
 * version (id, created_at, updated_at, deleted_at). Future TypeORM helpers
 * with different defaults need their own entry — or, longer-term, slowcook
 * should infer this from the helper's source.
 */
export const TYPEORM_HELPER_IMPLICIT_COLUMNS = [
  "id",
  "created_at",
  "updated_at",
  "deleted_at",
];

export function scanMigrations(repoRoot: string, dir: string): MigrationEntry[] {
  const dirs = resolveMigrationDirs(repoRoot, dir);
  const out: MigrationEntry[] = [];
  for (const d of dirs) {
    out.push(...scanMigrationsInDir(repoRoot, d));
  }
  return out;
}

function resolveMigrationDirs(repoRoot: string, configured: string): string[] {
  if (existsSync(join(repoRoot, configured))) return [configured];
  return TYPEORM_MIGRATION_FALLBACK_DIRS.filter((d) =>
    existsSync(join(repoRoot, d))
  );
}

function scanMigrationsInDir(repoRoot: string, dir: string): MigrationEntry[] {
  const root = join(repoRoot, dir);
  if (!existsSync(root)) return [];
  const out: MigrationEntry[] = [];
  for (const name of readdirSync(root).sort()) {
    const full = join(root, name);
    if (!statSync(full).isFile()) continue;
    if (name.endsWith(".sql")) {
      const body = readFileSync(full, "utf8");
      out.push({
        file: name,
        tables_created: extractCreateTables(body),
        columns_added: extractColumnsAdded(body),
      });
    } else if (name.endsWith(".ts")) {
      out.push(parseTypeOrmMigration(name, readFileSync(full, "utf8")));
    }
  }
  return out;
}

/**
 * Parse a single TypeORM migration TS file into the same MigrationEntry shape
 * the SQL parser produces. Sees two patterns:
 *
 *   1. `await queryRunner.query(\`CREATE TABLE x ...\`)` — extract the SQL
 *      template body and run it through the existing SQL parsers.
 *   2. `await DatabaseCreateTable(queryRunner, 'tbl', [{name:'a'},{name:'b'}])`
 *      — extract `tbl` + each column's name + the implicit-columns helpers
 *      add (id, created_at, updated_at, deleted_at).
 *
 * Pattern 2 is delgoosh-monorepo-specific; pattern 1 covers raw SQL writers.
 * EXPORTED for unit testing.
 */
export function parseTypeOrmMigration(name: string, body: string): MigrationEntry {
  const sqlParts = extractTypeOrmSqlTemplates(body);
  const helperTables = extractDatabaseCreateTableCalls(body);

  const tablesFromSql = sqlParts.flatMap(extractCreateTables);
  const tablesFromHelper = helperTables.map((t) => t.name);
  const tables_created = [...new Set([...tablesFromSql, ...tablesFromHelper])];

  const sqlColumnMaps = sqlParts.map(extractColumnsAdded);
  const helperColumnMap: Record<string, string[]> = {};
  for (const t of helperTables) {
    helperColumnMap[t.name] = [...t.columns, ...TYPEORM_HELPER_IMPLICIT_COLUMNS];
  }
  const columns_added = mergeColumnMaps([helperColumnMap, ...sqlColumnMaps]);

  return { file: name, tables_created, columns_added };
}

function extractTypeOrmSqlTemplates(body: string): string[] {
  // queryRunner.query(`...SQL...`) — backtick template-string body, possibly
  // multiline. Caller passes everything between the backticks downstream to
  // the SQL extractors (which already handle CREATE TABLE, ALTER TABLE ADD COLUMN).
  const re = /queryRunner\.query\(\s*`([\s\S]*?)`/g;
  const parts: string[] = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    if (m[1]) parts.push(m[1]);
  }
  return parts;
}

function extractDatabaseCreateTableCalls(
  body: string
): Array<{ name: string; columns: string[] }> {
  // DatabaseCreateTable(queryRunner, 'tbl', [ { name: 'col', ... }, ... ])
  // The columns array is matched with a non-greedy [ ... ] body; balanced-bracket
  // parsing isn't required because each call's array is the innermost literal.
  const re =
    /DatabaseCreateTable\(\s*queryRunner\s*,\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]\s*,\s*\[([\s\S]*?)\]\s*\)/g;
  const out: Array<{ name: string; columns: string[] }> = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    if (!m[1] || m[2] === undefined) continue;
    const colRe = /name:\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g;
    const columns: string[] = [];
    let cm;
    while ((cm = colRe.exec(m[2])) !== null) {
      if (cm[1]) columns.push(cm[1]);
    }
    out.push({ name: m[1].toLowerCase(), columns });
  }
  return out;
}

function mergeColumnMaps(
  maps: Record<string, string[]>[]
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const map of maps) {
    for (const [t, cols] of Object.entries(map)) {
      out[t] = [...new Set([...(out[t] ?? []), ...cols])];
    }
  }
  return out;
}

export function extractCreateTables(sql: string): string[] {
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  const tables: string[] = [];
  let m;
  while ((m = re.exec(sql)) !== null) {
    if (m[1]) tables.push(m[1].toLowerCase());
  }
  return [...new Set(tables)];
}

export function extractColumnsAdded(sql: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  // create table X ( col1 type, col2 type, ... )
  const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(([^;]+?)\)/gis;
  let m;
  while ((m = createRe.exec(sql)) !== null) {
    if (!m[1] || !m[2]) continue;
    const table = m[1].toLowerCase();
    const cols = parseColumnList(m[2]);
    out[table] = (out[table] ?? []).concat(cols);
  }
  // alter table X add column Y type
  const alterRe = /alter\s+table\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+add\s+column\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  while ((m = alterRe.exec(sql)) !== null) {
    if (!m[1] || !m[2]) continue;
    const table = m[1].toLowerCase();
    const col = m[2];
    out[table] = (out[table] ?? []).concat([col]);
  }
  // dedup
  for (const t of Object.keys(out)) {
    const arr = out[t];
    if (arr) out[t] = [...new Set(arr)];
  }
  return out;
}

function parseColumnList(inside: string): string[] {
  const cols: string[] = [];
  for (const line of inside.split(",")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(primary\s+key|constraint|unique|check|foreign\s+key)/i.test(trimmed)) continue;
    const m = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
    if (m && m[1]) cols.push(m[1]);
  }
  return cols;
}

// ----- Test helpers scanner -----

function scanTestHelpers(repoRoot: string, dir: string): TestHelperEntry[] {
  const root = join(repoRoot, dir);
  if (!existsSync(root)) return [];
  const out: TestHelperEntry[] = [];
  for (const file of walkFiles(root, /\.(ts|tsx)$/)) {
    if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
    const rel = relative(repoRoot, file).replace(/\\/g, "/");
    const body = readFileSync(file, "utf8");
    for (const m of body.matchAll(/export\s+(?:async\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
      if (m[1]) out.push({ name: m[1], file: rel, purpose: extractDocLine(body, m.index ?? 0) });
    }
    for (const m of body.matchAll(/export\s+const\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*[:=]/g)) {
      if (m[1]) out.push({ name: m[1], file: rel, purpose: extractDocLine(body, m.index ?? 0) });
    }
  }
  return out;
}

function extractDocLine(body: string, exportIdx: number): string {
  // Look back ~200 chars for a JSDoc or // comment immediately before the export.
  const before = body.slice(Math.max(0, exportIdx - 300), exportIdx);
  const jsdoc = before.match(/\/\*\*([\s\S]*?)\*\/\s*$/);
  if (jsdoc && jsdoc[1]) {
    const cleaned = jsdoc[1].replace(/^\s*\*\s?/gm, "").trim();
    const firstLine = cleaned.split("\n")[0];
    if (firstLine) return firstLine.slice(0, 120);
  }
  const lineComment = before.match(/\/\/\s*([^\n]+)\s*$/);
  if (lineComment && lineComment[1]) return lineComment[1].trim().slice(0, 120);
  return "";
}

// ----- Test files scanner -----

function scanTestFiles(repoRoot: string, dir: string): TestFileEntry[] {
  const root = join(repoRoot, dir);
  if (!existsSync(root)) return [];
  const out: TestFileEntry[] = [];
  for (const file of walkFiles(root, /\.test\.(ts|tsx)$/)) {
    const rel = relative(repoRoot, file).replace(/\\/g, "/");
    const body = readFileSync(file, "utf8");
    const imports: string[] = [];
    for (const m of body.matchAll(/import[^"']*from\s+["']([^"']+)["']/g)) {
      const spec = m[1];
      if (spec && (spec.startsWith("@/") || spec.startsWith("."))) imports.push(spec);
    }
    const test_names: string[] = [];
    for (const m of body.matchAll(/(?:describe|it|test)\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
      if (m[1]) test_names.push(m[1]);
    }
    out.push({ file: rel, imports, test_names });
  }
  return out;
}

// ----- Mock surface scanner (0.19.0-α.23) -----
//
// The mock dir is the consumer's hand-authored design source-of-truth.
// Refine reads each file's route (inferred from app-router shape) +
// a bounded excerpt, so a PM issue saying "match the mock" produces
// a spec mirroring the mock without the PM citing paths.

// Bumped 1500 → 8000 in α.26 — the 1500 ceiling cut off real-world
// mocks at ~50 lines. delgoosh's mock/src/app/login/page.tsx is
// 6411 chars (171 lines) — 6000 still truncated; 8000 fits comfortably
// and covers up to ~260-line mocks. Larger consumers may need a
// per-file override; cross that bridge when a real mock exceeds 8KB.
const MOCK_EXCERPT_LIMIT = 8000;

export function scanMockSurface(repoRoot: string, mockRoot: string): MockEntry[] {
  const root = join(repoRoot, mockRoot);
  if (!existsSync(root)) return [];
  const out: MockEntry[] = [];
  for (const file of walkFiles(root, /\.(tsx|ts)$/)) {
    const rel = relative(repoRoot, file).replace(/\\/g, "/");
    // Skip non-page TS files (utilities, types) — focus on UI surface.
    if (!rel.endsWith(".tsx") && !rel.endsWith("page.ts")) continue;
    const body = readFileSync(file, "utf8");
    const route = inferMockRoute(rel, mockRoot);
    const name = extractComponentName(body, rel) ?? routeOrFileFallback(rel, route);
    const excerpt = trimExcerpt(body, MOCK_EXCERPT_LIMIT);
    out.push({ file: rel, route, name, excerpt });
  }
  return out;
}

function inferMockRoute(rel: string, mockRoot: string): string | null {
  // Next.js app-router shape: <mockRoot>/app/<...segments>/page.tsx → /<segments>
  // Parenthesised segments are layout groups, stripped from the URL.
  const appPrefix = `${mockRoot}/app/`;
  if (!rel.startsWith(appPrefix)) return null;
  if (!rel.endsWith("/page.tsx") && !rel.endsWith("/page.ts")) return null;
  // `/?` makes the leading slash optional so the root page
  // (`mock/src/app/page.tsx`) collapses to "" → final route "/" instead
  // of the buggy "/page.tsx".
  const segments = rel
    .slice(appPrefix.length)
    .replace(/\/?page\.(tsx|ts)$/, "")
    .split("/")
    .filter((s) => s.length > 0 && !(s.startsWith("(") && s.endsWith(")")));
  return "/" + segments.join("/");
}

function routeOrFileFallback(rel: string, route: string | null): string {
  if (route) return route;
  const base = rel.split("/").pop() ?? rel;
  return base.replace(/\.(tsx|ts)$/, "");
}

function trimExcerpt(body: string, limit: number): string {
  const trimmed = body.trim();
  if (trimmed.length <= limit) return trimmed;
  return trimmed.slice(0, limit) + "\n/* ...truncated... */";
}

// ----- Code-routed API scanner (Hono/Express-style) -----

/**
 * Route-FILE conventions (src/app/api/**​/route.ts) miss code-routed
 * frameworks entirely — dash mounts everything via Hono `app.post("/api/...")`
 * in one file, which indexed as "0 api routes" and led testgen to FORK an
 * existing webhook handler it couldn't see (aminazar/slowcook#240). This pass
 * greps literal `app.<method>("...")` registrations out of every package's
 * src/ tree. Regex-level fidelity is deliberate: no AST dependency, and a
 * route the regex misses degrades to the old behavior, never worse.
 */
export function scanCodeRoutes(repoRoot: string, pkgDirs: string[]): ApiRouteEntry[] {
  const out: ApiRouteEntry[] = [];
  const re = /\bapp\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
  for (const pkg of pkgDirs) {
    const srcRoot = join(repoRoot, pkg === "" ? "src" : `${pkg}/src`);
    for (const file of walkFiles(srcRoot, /\.(ts|tsx)$/)) {
      if (/\.test\.|\.spec\./.test(file)) continue;
      const text = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        out.push({
          method: m[1]!.toUpperCase(),
          path: m[2]!,
          file: file.slice(repoRoot.length + 1),
        });
      }
    }
  }
  return out;
}

// ----- Package-root discovery (workspace-blindness fix) -----

/**
 * Every place code can live by convention: the repo root ("") plus any
 * first-level directory containing a package.json (covers dash's server/ +
 * mock/, simple monorepos) plus pnpm-workspace.yaml globs one level deep
 * (covers packages/star layouts). Deduped, deterministic order.
 */
export function discoverPackageDirs(repoRoot: string): string[] {
  const dirs = new Set<string>([""]);
  try {
    for (const name of readdirSync(repoRoot).sort()) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(repoRoot, name);
      if (statSync(full).isDirectory() && existsSync(join(full, "package.json"))) dirs.add(name);
    }
  } catch { /* unreadable root — index stays root-only */ }
  const wsFile = join(repoRoot, "pnpm-workspace.yaml");
  if (existsSync(wsFile)) {
    const globs = [...readFileSync(wsFile, "utf8").matchAll(/^\s*-\s*["']?([^"'\n#]+?)["']?\s*$/gm)]
      .map((m) => m[1]!.trim());
    for (const g of globs) {
      if (!g.endsWith("/*")) { dirs.add(g); continue; }
      const parent = join(repoRoot, g.slice(0, -2));
      try {
        for (const name of readdirSync(parent).sort()) {
          const full = join(parent, name);
          if (statSync(full).isDirectory() && existsSync(join(full, "package.json"))) {
            dirs.add(`${g.slice(0, -2)}/${name}`);
          }
        }
      } catch { /* glob parent absent */ }
    }
  }
  return [...dirs];
}

// ----- File walker -----

function walkFiles(dir: string, match: RegExp, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, match, acc);
    else if (match.test(name)) acc.push(full);
  }
  return acc;
}
