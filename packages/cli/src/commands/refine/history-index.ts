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

export interface HistoryIndex {
  generated_at: string;
  generator: "slowcook-refine-history-index@0.17.0";
  components: ComponentEntry[];
  api_routes: ApiRouteEntry[];
  migrations: MigrationEntry[];
  test_helpers: TestHelperEntry[];
  test_files: TestFileEntry[];
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
  };
}

export function buildHistoryIndex(opts: BuildOptions): HistoryIndex {
  const { repoRoot } = opts;
  const paths = {
    components: opts.scanPaths?.components ?? "src/components",
    api: opts.scanPaths?.api ?? "src/app/api",
    migrations: opts.scanPaths?.migrations ?? "supabase/migrations",
    tests: opts.scanPaths?.tests ?? "tests",
    helpers: opts.scanPaths?.helpers ?? "tests/helpers",
  };

  const components = scanComponents(repoRoot, paths.components);
  const api_routes = scanApiRoutes(repoRoot, paths.api);
  const migrations = scanMigrations(repoRoot, paths.migrations);
  const test_helpers = scanTestHelpers(repoRoot, paths.helpers);
  const test_files = scanTestFiles(repoRoot, paths.tests);

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

function scanMigrations(repoRoot: string, dir: string): MigrationEntry[] {
  const root = join(repoRoot, dir);
  if (!existsSync(root)) return [];
  const out: MigrationEntry[] = [];
  for (const name of readdirSync(root).sort()) {
    if (!name.endsWith(".sql")) continue;
    const body = readFileSync(join(root, name), "utf8");
    const tables_created = extractCreateTables(body);
    const columns_added = extractColumnsAdded(body);
    out.push({ file: name, tables_created, columns_added });
  }
  return out;
}

function extractCreateTables(sql: string): string[] {
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-zA-Z_][a-zA-Z0-9_]*)/gi;
  const tables: string[] = [];
  let m;
  while ((m = re.exec(sql)) !== null) {
    if (m[1]) tables.push(m[1].toLowerCase());
  }
  return [...new Set(tables)];
}

function extractColumnsAdded(sql: string): Record<string, string[]> {
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
