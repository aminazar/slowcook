/**
 * ts-morph scanner. Walks a consumer's `src/` tree and produces a structured
 * CodeMap. Covers five entity kinds the brewing agent benefits from seeing
 * without having to open every file:
 *
 *   1. API routes    — Next.js App Router (`src/app/**\/route.ts(x)`)
 *   2. Pages         — Next.js App Router (`src/app/**\/page.tsx`)
 *   3. Components    — `src/components/**\/*.tsx` (exported React components)
 *   4. Helpers       — `src/lib/**\/*.ts`, `src/utils/**\/*.ts` (exported fns/consts/classes)
 *   5. Types         — `src/types/**\/*.ts` (exported types/interfaces/enums)
 *
 * Scope is deliberately Next.js + TypeScript-centric for v1 — the engine is
 * general enough to extend (different frameworks would register their own
 * route-URL derivation), but today we only ship Next.js App Router detection.
 *
 * Output is a plain object — the CLI entry serialises to JSON + renders
 * Markdown. No I/O here beyond reading source files via ts-morph.
 */

import { existsSync } from "node:fs";
import { relative as pathRelative, join, sep } from "node:path";
import { Project, Node, SyntaxKind } from "ts-morph";
import type {
  JSDoc,
  SourceFile,
  FunctionDeclaration,
  VariableStatement,
  ClassDeclaration,
  InterfaceDeclaration,
  TypeAliasDeclaration,
  EnumDeclaration,
  ExportAssignment,
} from "ts-morph";

/**
 * 0.12.7+ (Phase 2A of brownfield-retrieval) — every exported symbol
 * carries a 1-based `line` (declaration site) and `callers` (count of
 * non-declaration references across src/) so brew can answer
 * "how widely is this used?" without reading every file.
 *
 * `callers` is approximate: based on a name-only AST scan that doesn't
 * perform type resolution. Two unrelated symbols sharing a name will
 * pool their callers. Trade-off: cheap (single pass) and useful for
 * "should I extend or duplicate?" judgement calls; not authoritative
 * for refactor planning.
 */
export interface ApiRouteEntry {
  method: string;
  path: string;
  file: string;
  function: string;
  /** 1-based line where the handler function is declared. */
  line?: number;
  /** Reference count across src/ (excluding the declaration itself). */
  callers?: number;
  jsdoc?: string;
  imports: string[];
}

export interface PageEntry {
  path: string;
  file: string;
  component?: string;
  /** 1-based line where the page's default-export component is declared. */
  line?: number;
  jsdoc?: string;
}

export interface ComponentEntry {
  name: string;
  file: string;
  exportKind: "default" | "named";
  props_type?: string;
  /** 1-based line of the component declaration. */
  line?: number;
  callers?: number;
  jsdoc?: string;
}

export interface HelperEntry {
  name: string;
  kind: "function" | "const" | "class";
  file: string;
  signature: string;
  /** 1-based line of the helper declaration. */
  line?: number;
  callers?: number;
  jsdoc?: string;
}

export interface TypeEntry {
  name: string;
  kind: "interface" | "type" | "enum";
  file: string;
  declaration: string;
  /** 1-based line of the type declaration. */
  line?: number;
  callers?: number;
  jsdoc?: string;
}

export interface CodeMap {
  schema_version: 1;
  slowcook_version: string;
  generated_at: string;
  repo_root: string;
  api_routes: ApiRouteEntry[];
  pages: PageEntry[];
  components: ComponentEntry[];
  helpers: HelperEntry[];
  types: TypeEntry[];
}

export interface GenerateMapOptions {
  repoRoot: string;
  slowcookVersion: string;
  now?: Date;
}

export function generateMap(opts: GenerateMapOptions): CodeMap {
  const { repoRoot, slowcookVersion, now } = opts;
  const map: CodeMap = {
    schema_version: 1,
    slowcook_version: slowcookVersion,
    generated_at: (now ?? new Date()).toISOString(),
    repo_root: ".",
    api_routes: [],
    pages: [],
    components: [],
    helpers: [],
    types: [],
  };

  // Bail out cleanly if the consumer has no src/ at all.
  if (!existsSync(join(repoRoot, "src"))) return map;

  const project = new Project({
    useInMemoryFileSystem: false,
    // No type-checking needed — we only read syntactic structure.
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
  });

  const globPatterns = [
    "src/app/**/route.ts",
    "src/app/**/route.tsx",
    "src/app/**/page.tsx",
    "src/app/**/page.ts",
    "src/components/**/*.tsx",
    "src/lib/**/*.ts",
    "src/utils/**/*.ts",
    "src/types/**/*.ts",
  ].map((g) => join(repoRoot, g));

  project.addSourceFilesAtPaths(globPatterns);

  for (const sf of project.getSourceFiles()) {
    const rel = pathRelative(repoRoot, sf.getFilePath()).split(sep).join("/");

    if (/^src\/app\/.*\/route\.tsx?$/.test(rel)) {
      scanApiRouteFile(sf, rel, map);
      continue;
    }
    if (/^src\/app\/.*\/page\.tsx?$/.test(rel)) {
      scanPageFile(sf, rel, map);
      continue;
    }
    if (/^src\/components\//.test(rel)) {
      scanComponentFile(sf, rel, map);
      continue;
    }
    if (/^src\/(lib|utils)\//.test(rel)) {
      scanHelperFile(sf, rel, map);
      continue;
    }
    if (/^src\/types\//.test(rel)) {
      scanTypesFile(sf, rel, map);
      continue;
    }
  }

  // 0.12.7+ (Phase 2A) — annotate every entry with `callers`. Single
  // pass: count identifier references across the entire src/ tree once,
  // then attach the count to each exported symbol entry. Excludes the
  // declaration itself + import specifiers; counts everything else.
  enrichWithCallerCounts(project, map);

  // Stable ordering so the JSON diffs cleanly across regenerations.
  sortMap(map);
  return map;
}

/**
 * Phase 2A — count name-only AST references for every exported symbol
 * in the map. Approximate (no type resolution): symbols sharing a
 * name pool their counts. Trade-off: cheap, useful for "should I
 * extend or duplicate?" judgement; not authoritative for refactor
 * planning.
 */
function enrichWithCallerCounts(project: Project, map: CodeMap): void {
  // Collect all names we care about. Include component names, helper
  // names, type names. (api_routes use HTTP-method names like POST/GET
  // which would balloon the count meaninglessly — skip them.)
  const names = new Set<string>();
  for (const c of map.components) names.add(c.name);
  for (const h of map.helpers) names.add(h.name);
  for (const t of map.types) names.add(t.name);
  if (names.size === 0) return;

  const counts = new Map<string, number>();
  for (const sf of project.getSourceFiles()) {
    sf.forEachDescendant((node) => {
      if (!Node.isIdentifier(node)) return;
      const text = node.getText();
      if (!names.has(text)) return;
      const parent = node.getParent();
      if (!parent) return;
      // Skip declaration sites — counted via `line`, not here.
      if (
        (Node.isFunctionDeclaration(parent) ||
          Node.isClassDeclaration(parent) ||
          Node.isInterfaceDeclaration(parent) ||
          Node.isTypeAliasDeclaration(parent) ||
          Node.isEnumDeclaration(parent) ||
          Node.isVariableDeclaration(parent)) &&
        parent.getNameNode?.() === node
      ) {
        return;
      }
      // Skip import bindings — bringing a symbol in is not a use site.
      // Also skip the property-name half of `import { x as y }` where
      // `x` is the imported identifier (parent: ImportSpecifier).
      if (
        Node.isImportSpecifier(parent) ||
        Node.isImportClause(parent) ||
        Node.isNamespaceImport(parent)
      ) {
        return;
      }
      counts.set(text, (counts.get(text) ?? 0) + 1);
    });
  }

  for (const c of map.components) c.callers = counts.get(c.name) ?? 0;
  for (const h of map.helpers) h.callers = counts.get(h.name) ?? 0;
  for (const t of map.types) t.callers = counts.get(t.name) ?? 0;
}

function sortMap(map: CodeMap): void {
  map.api_routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  map.pages.sort((a, b) => a.path.localeCompare(b.path));
  map.components.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  map.helpers.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  map.types.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}

// -------------------------------------------------------------------------
// Per-kind scanners
// -------------------------------------------------------------------------

function scanApiRouteFile(sf: SourceFile, rel: string, map: CodeMap): void {
  const urlPath = appRouterUrlPath(rel);
  const imports = collectImports(sf);
  const httpMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

  for (const fn of sf.getFunctions()) {
    if (!fn.isExported()) continue;
    const name = fn.getName();
    if (!name || !httpMethods.has(name.toUpperCase())) continue;
    map.api_routes.push({
      method: name.toUpperCase(),
      path: urlPath,
      file: rel,
      function: name,
      line: fn.getStartLineNumber(),
      jsdoc: getJsDoc(fn),
      imports,
    });
  }

  // Also accept `export const POST = async (req) => {...}` style.
  for (const vs of sf.getVariableStatements()) {
    if (!vs.isExported()) continue;
    for (const decl of vs.getDeclarations()) {
      const name = decl.getName();
      if (!httpMethods.has(name.toUpperCase())) continue;
      map.api_routes.push({
        method: name.toUpperCase(),
        path: urlPath,
        file: rel,
        function: name,
        line: decl.getStartLineNumber(),
        jsdoc: getJsDoc(vs),
        imports,
      });
    }
  }
}

function scanPageFile(sf: SourceFile, rel: string, map: CodeMap): void {
  const urlPath = appRouterUrlPath(rel);
  const componentName = findDefaultExportName(sf);
  const jsdoc =
    getJsDocOnDefaultExport(sf) ??
    getJsDocOnFirstExportedFunction(sf);
  const line = findDefaultExportLine(sf);
  map.pages.push({ path: urlPath, file: rel, component: componentName, line, jsdoc });
}

function scanComponentFile(sf: SourceFile, rel: string, map: CodeMap): void {
  // Default export component
  const def = findDefaultExportName(sf);
  if (def && /^[A-Z]/.test(def)) {
    map.components.push({
      name: def,
      file: rel,
      exportKind: "default",
      props_type: extractPropsType(sf, def),
      line: findDefaultExportLine(sf),
      jsdoc: getJsDocOnDefaultExport(sf),
    });
  }
  // Named exports that look like components (PascalCase function/const)
  for (const fn of sf.getFunctions()) {
    if (!fn.isExported() || fn.isDefaultExport()) continue;
    const name = fn.getName();
    if (!name || !/^[A-Z]/.test(name)) continue;
    map.components.push({
      name,
      file: rel,
      exportKind: "named",
      props_type: extractPropsType(sf, name),
      line: fn.getStartLineNumber(),
      jsdoc: getJsDoc(fn),
    });
  }
  for (const vs of sf.getVariableStatements()) {
    if (!vs.isExported()) continue;
    for (const decl of vs.getDeclarations()) {
      const name = decl.getName();
      if (!/^[A-Z]/.test(name)) continue;
      map.components.push({
        name,
        file: rel,
        exportKind: "named",
        props_type: extractPropsType(sf, name),
        line: decl.getStartLineNumber(),
        jsdoc: getJsDoc(vs),
      });
    }
  }
}

function scanHelperFile(sf: SourceFile, rel: string, map: CodeMap): void {
  for (const fn of sf.getFunctions()) {
    if (!fn.isExported()) continue;
    const name = fn.getName();
    if (!name) continue;
    map.helpers.push({
      name,
      kind: "function",
      file: rel,
      signature: functionSignature(fn),
      line: fn.getStartLineNumber(),
      jsdoc: getJsDoc(fn),
    });
  }
  for (const cls of sf.getClasses()) {
    if (!cls.isExported()) continue;
    const name = cls.getName();
    if (!name) continue;
    map.helpers.push({
      name,
      kind: "class",
      file: rel,
      signature: `class ${name}`,
      line: cls.getStartLineNumber(),
      jsdoc: getJsDoc(cls),
    });
  }
  for (const vs of sf.getVariableStatements()) {
    if (!vs.isExported()) continue;
    for (const decl of vs.getDeclarations()) {
      const name = decl.getName();
      // Skip obvious non-helpers (PascalCase is probably a component or type)
      // but keep PascalCase constants (ALL_CAPS) and regular camelCase consts.
      if (/^[A-Z][a-z]/.test(name)) continue;
      map.helpers.push({
        name,
        kind: "const",
        file: rel,
        signature: constSignature(decl.getName(), decl.getTypeNode()?.getText()),
        line: decl.getStartLineNumber(),
        jsdoc: getJsDoc(vs),
      });
    }
  }
}

function scanTypesFile(sf: SourceFile, rel: string, map: CodeMap): void {
  for (const iface of sf.getInterfaces()) {
    if (!iface.isExported()) continue;
    map.types.push({
      name: iface.getName(),
      kind: "interface",
      file: rel,
      declaration: iface.getText().split("\n").slice(0, 6).join("\n"),
      line: iface.getStartLineNumber(),
      jsdoc: getJsDoc(iface),
    });
  }
  for (const alias of sf.getTypeAliases()) {
    if (!alias.isExported()) continue;
    map.types.push({
      name: alias.getName(),
      kind: "type",
      file: rel,
      declaration: alias.getText(),
      line: alias.getStartLineNumber(),
      jsdoc: getJsDoc(alias),
    });
  }
  for (const en of sf.getEnums()) {
    if (!en.isExported()) continue;
    map.types.push({
      name: en.getName(),
      kind: "enum",
      file: rel,
      declaration: en.getText().split("\n").slice(0, 12).join("\n"),
      line: en.getStartLineNumber(),
      jsdoc: getJsDoc(en),
    });
  }
}

// -------------------------------------------------------------------------
// Small helpers
// -------------------------------------------------------------------------

/**
 * Derive the Next.js App Router URL path from a file path under src/app.
 * Strips the leading `src/app`, drops the trailing `/route.ts(x)` or
 * `/page.tsx`, converts `[param]` → `:param` for readability, collapses
 * route groups `(auth)` which are path-invisible.
 */
function appRouterUrlPath(rel: string): string {
  let p = rel.replace(/^src\/app/, "").replace(/\/(route|page)\.tsx?$/, "");
  if (p === "") p = "/";
  // Drop route groups like /(auth)/
  p = p.replace(/\/\([^)]+\)/g, "");
  // Params: [id] → :id, [[...slug]] → :slug? (we simplify)
  p = p.replace(/\[\[\.\.\.(\w+)\]\]/g, ":$1*");
  p = p.replace(/\[\.\.\.(\w+)\]/g, ":$1*");
  p = p.replace(/\[(\w+)\]/g, ":$1");
  return p || "/";
}

function collectImports(sf: SourceFile): string[] {
  return sf
    .getImportDeclarations()
    .map((d) => d.getModuleSpecifierValue())
    .filter((s): s is string => typeof s === "string");
}

function getJsDoc(
  node:
    | FunctionDeclaration
    | VariableStatement
    | ClassDeclaration
    | InterfaceDeclaration
    | TypeAliasDeclaration
    | EnumDeclaration
    | ExportAssignment
): string | undefined {
  const docs = (node as unknown as { getJsDocs?: () => JSDoc[] }).getJsDocs?.();
  if (!docs || docs.length === 0) return undefined;
  const raw = docs[docs.length - 1]?.getDescription() ?? "";
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function findDefaultExportName(sf: SourceFile): string | undefined {
  // Case 1: `export default function Name() {}` or `export default async function Name()`
  for (const fn of sf.getFunctions()) {
    if (fn.isDefaultExport()) return fn.getName() ?? "(anonymous)";
  }
  // Case 2: `export default Name` where Name is a local declaration
  const exportAssign = sf
    .getExportAssignments()
    .find((e) => !e.isExportEquals());
  if (exportAssign) {
    const expr = exportAssign.getExpression();
    if (Node.isIdentifier(expr)) return expr.getText();
  }
  return undefined;
}

function findDefaultExportLine(sf: SourceFile): number | undefined {
  for (const fn of sf.getFunctions()) {
    if (fn.isDefaultExport()) return fn.getStartLineNumber();
  }
  const exportAssign = sf
    .getExportAssignments()
    .find((e) => !e.isExportEquals());
  if (exportAssign) return exportAssign.getStartLineNumber();
  return undefined;
}

function getJsDocOnDefaultExport(sf: SourceFile): string | undefined {
  for (const fn of sf.getFunctions()) {
    if (fn.isDefaultExport()) return getJsDoc(fn);
  }
  const exportAssign = sf
    .getExportAssignments()
    .find((e) => !e.isExportEquals());
  if (exportAssign) return getJsDoc(exportAssign);
  return undefined;
}

function getJsDocOnFirstExportedFunction(sf: SourceFile): string | undefined {
  for (const fn of sf.getFunctions()) {
    if (fn.isExported()) return getJsDoc(fn);
  }
  return undefined;
}

function extractPropsType(sf: SourceFile, componentName: string): string | undefined {
  // Heuristic: if there's a local `interface <Component>Props` or
  // `type <Component>Props`, surface it.
  const wanted = `${componentName}Props`;
  const iface = sf.getInterface(wanted);
  if (iface) return wanted;
  const alias = sf.getTypeAlias(wanted);
  if (alias) return wanted;
  return undefined;
}

function functionSignature(fn: FunctionDeclaration): string {
  const asyncKw = fn.isAsync() ? "async " : "";
  const name = fn.getName() ?? "(anonymous)";
  const params = fn
    .getParameters()
    .map((p) => {
      const n = p.getName();
      const t = p.getTypeNode()?.getText();
      const opt = p.isOptional() ? "?" : "";
      return t ? `${n}${opt}: ${t}` : `${n}${opt}`;
    })
    .join(", ");
  const ret = fn.getReturnTypeNode()?.getText();
  return `${asyncKw}function ${name}(${params})${ret ? `: ${ret}` : ""}`;
}

function constSignature(name: string, typeText: string | undefined): string {
  return typeText ? `const ${name}: ${typeText}` : `const ${name}`;
}

// SyntaxKind is imported but only to satisfy a future check; reference here
// keeps ts-check happy if tree-shaking removes the direct usage.
void SyntaxKind;
