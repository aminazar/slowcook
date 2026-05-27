/**
 * `slowcook refresh-knowledge` — α.62
 *
 * Rebuilds `.brewing/repo-knowledge/auto/*.md` digests so refine (and any
 * other agent) reads the consumer repo's actual shape instead of
 * re-deriving it via LLM every run.
 *
 * Caching policy (three classes):
 *   1. Cheap deterministic extractions (all of α.62: pure regex/AST,
 *      <2s per file). Just rebuild every time. No hash machinery.
 *
 *   2. Expensive deterministic extractions (e.g., git-history mining
 *      in α.63 — walking 500 commits to extract conventions). Stamp
 *      output with `<!-- last-built: ISO; input-tip-sha: <sha> -->`
 *      and resume from the stamped SHA on the next run (delta mining).
 *
 *   3. Expensive INSIGHTS (LLM-derived chef known-fixes, lesson
 *      extractions, PR summaries). These do NOT auto-invalidate on
 *      commit change — the insight is about a CLASS of problem, not
 *      a snapshot of code. An insight like "vitest/config not found
 *      means deps missing" stays true even if vitest.config.ts moves.
 *      Staleness is a SOFT signal:
 *        - Each insight carries `evidence-pr: N` + `last-verified: ISO`
 *        - `slowcook knowledge verify` may flag [PRECARIOUS] when the
 *          evidence file is substantially rewritten, but does NOT
 *          delete. Agents reading insights see staleness as weight,
 *          not as a gate.
 *      α.62 has no insight extractions yet; this comment locks the
 *      design for α.63+ to follow.
 *
 * Output layout (gitignored by convention):
 *   .brewing/repo-knowledge/auto/
 *     ├── backend-entities.md   (TypeORM @Entity classes + columns)
 *     ├── backend-routes.md     (HTTP controllers + handler names)
 *     ├── backend-enums.md      (packages/enums/src/*.enum.ts values)
 *     ├── frontend-types.md     (mock/src/types/*.ts interfaces)
 *     ├── frontend-components.md  (mock/src/{app,components}/**.tsx)
 *     ├── frontend-contexts.md  (mock/src/contexts/*-context.tsx hooks)
 *     ├── tokens.md             (Tailwind brand-token vocabulary)
 *     ├── config.md             (tsconfig paths + workspace + scripts)
 *     ├── migrations.md         (migration file timestamps + table names)
 *     └── routes-inventory.md   (filesystem-derived route URLs)
 *
 * Refine (`refine/context.ts`) reads these from disk and concatenates
 * them. If the dir doesn't exist (first run), refine falls back to the
 * legacy in-memory scan (α.61 readNestJsBackendDigest).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const AUTO_DIR_REL = ".brewing/repo-knowledge/auto";

// --- input discovery helpers ---

function findFilesByGlob(repoRoot: string, pattern: RegExp, opts: { maxDepth?: number } = {}): string[] {
  const out: string[] = [];
  const skipDirs = new Set(["node_modules", ".git", ".next", "dist", "build", ".turbo", "coverage", ".brewing"]);
  const maxDepth = opts.maxDepth ?? 8;
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (skipDirs.has(name)) continue;
      const abs = join(dir, name);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) walk(abs, depth + 1);
      else {
        const rel = abs.slice(repoRoot.length + 1);
        if (pattern.test(rel)) out.push(rel);
      }
    }
  };
  walk(repoRoot, 0);
  return out.sort();
}

function safeRead(repoRoot: string, rel: string): string | null {
  try { return readFileSync(join(repoRoot, rel), "utf8"); } catch { return null; }
}

// --- digest writer (cheap extractions = always rebuild) ---

function writeDigest(repoRoot: string, name: string, body: string): void {
  const abs = join(repoRoot, AUTO_DIR_REL, `${name}.md`);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `<!-- regenerated: ${new Date().toISOString()} -->\n${body}\n`, "utf8");
}

/**
 * Build one digest. Cheap extractions class — always rebuilds.
 */
export function buildDigest(args: {
  repoRoot: string;
  name: string;
  inputFiles: string[];
  build: (inputs: string[]) => string;
}): { body: string; built: boolean } {
  const { repoRoot, name, inputFiles, build } = args;
  if (inputFiles.length === 0) return { body: "", built: false };
  const body = build(inputFiles);
  writeDigest(repoRoot, name, body);
  return { body, built: true };
}

// --- extraction primitives (shared) ---

function extractTypeOrmColumns(body: string): string[] {
  const lines = body.split("\n");
  const out: string[] = [];
  const fieldRe = /^\s*(?:public|private|readonly|protected)\s+(\w+)(\?)?\s*:\s*([^;]+);/;
  for (const l of lines) {
    const m = l.match(fieldRe);
    if (!m) continue;
    const name = m[1]!;
    const optional = m[2] ? "?" : "";
    const type = (m[3] ?? "").trim().replace(/\s+/g, " ");
    out.push(`${name}${optional}: ${type}`);
  }
  return [...new Set(out)];
}

function extractNestRoutes(body: string): Array<{ method: string; path: string; handler: string }> {
  const lines = body.split("\n");
  const out: Array<{ method: string; path: string; handler: string }> = [];
  const httpVerbRe = /^\s*@(Get|Post|Put|Delete|Patch)\(([^)]*)\)/;
  const nextHttpVerbRe = /^\s*@(Get|Post|Put|Delete|Patch)\(/;
  const handlerRe = /^\s*(?:public|private|protected)?\s*(?:async\s+)?(\w+)\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? "").match(httpVerbRe);
    if (!m) continue;
    const method = m[1]!.toUpperCase();
    const rawPath = (m[2] ?? "").trim().replace(/^['"`]|['"`]$/g, "");
    let parenDepth = 0;
    let handler = "?";
    for (let j = i + 1; j < Math.min(i + 60, lines.length); j++) {
      const ln = lines[j] ?? "";
      if (parenDepth === 0 && nextHttpVerbRe.test(ln)) break;
      for (const ch of ln) {
        if (ch === "(") parenDepth++;
        else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
      }
      if (/^\s*@\w+/.test(ln)) continue;
      if (/^\s*$/.test(ln)) continue;
      const hm = ln.match(handlerRe);
      if (hm) {
        const word = hm[1]!;
        if (word === "if" || word === "switch" || word === "while" || word === "for" || /^[A-Z]/.test(word)) continue;
        handler = word;
        break;
      }
    }
    out.push({ method, path: rawPath, handler });
  }
  return out;
}

function joinPath(base: string, sub: string): string {
  const b = base.replace(/^\/|\/$/g, "");
  const s = sub.replace(/^\/|\/$/g, "");
  if (!b) return s;
  if (!s) return b;
  return `${b}/${s}`;
}

function extractTsInterfaces(body: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const startRe = /export\s+interface\s+(\w+)(?:\s+extends\s+[\w\s,&<>]+?)?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(body)) !== null) {
    const name = m[1]!;
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < body.length && depth > 0) {
      const ch = body[i]!;
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    if (depth === 0) {
      const ifaceBody = body.slice(m.index + m[0].length, i - 1).trim();
      out.push({ name, body: ifaceBody });
    }
  }
  return out;
}

function extractComponentExports(body: string): Array<{ name: string; propsName: string | null }> {
  const out: Array<{ name: string; propsName: string | null }> = [];
  const compRe = /export\s+(?:default\s+)?function\s+(\w+)\s*\(/g;
  const constRe = /export\s+(?:default\s+)?const\s+(\w+)\s*[:=]/g;
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = compRe.exec(body)) !== null) names.add(m[1]!);
  while ((m = constRe.exec(body)) !== null) names.add(m[1]!);
  for (const name of names) {
    if (!/^[A-Z]/.test(name)) continue;
    const propsName = body.includes(`interface ${name}Props`) ? `${name}Props` : null;
    out.push({ name, propsName });
  }
  return out;
}

function extractHookSignatures(body: string): string[] {
  const out: string[] = [];
  const fnRe = /export\s+function\s+(use\w+)\s*\(([^)]*)\)(?::\s*([^{]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(body)) !== null) {
    const name = m[1]!;
    const params = (m[2] ?? "").trim();
    const ret = (m[3] ?? "").trim().replace(/=>.*$/, "").trim() || "?";
    out.push(`${name}(${params}): ${ret}`);
  }
  return out;
}

function extractTailwindTokens(body: string): Set<string> {
  const out = new Set<string>();
  const classRe = /className\s*=\s*(?:["'`]([^"'`]+)["'`]|\{["'`]([^"'`]+)["'`]\})/g;
  let m: RegExpExecArray | null;
  while ((m = classRe.exec(body)) !== null) {
    const classes = (m[1] ?? m[2] ?? "").split(/\s+/);
    for (const c of classes) {
      if (/^(bg|text|border|ring|fill|stroke)-(brand|primary|secondary|accent|surface)-/.test(c)) out.add(c);
      if (/^bg-(brand|primary|secondary)-?\w*$/.test(c)) out.add(c);
    }
  }
  return out;
}

// --- digest builders ---

export function buildBackendEntitiesDigest(repoRoot: string) {
  const files = findFilesByGlob(repoRoot, /\/entities\/[^/]+\.entity\.ts$/);
  return buildDigest({
    repoRoot, name: "backend-entities", inputFiles: files,
    build: (inputs) => {
      const lines: string[] = [];
      lines.push("# Backend entities (TypeORM)\n");
      lines.push("Auto-extracted from `packages/**/entities/*.entity.ts`. Spec / code MUST reference these field names verbatim — do not invent aliases.\n");
      for (const rel of inputs) {
        const body = safeRead(repoRoot, rel);
        if (!body) continue;
        const classMatch = body.match(/export class (\w+) extends BaseEntity/) ?? body.match(/export class (\w+)/);
        if (!classMatch) continue;
        const className = classMatch[1]!;
        const cols = extractTypeOrmColumns(body).slice(0, 30);
        lines.push(`## ${className} \`${rel}\``);
        for (const col of cols) lines.push(`- ${col}`);
        lines.push("");
      }
      return lines.join("\n");
    },
  });
}

export function buildBackendRoutesDigest(repoRoot: string) {
  const files = findFilesByGlob(repoRoot, /\/(modules|controllers)\/[^/]+\/[^/]+\.controller\.ts$/);
  return buildDigest({
    repoRoot, name: "backend-routes", inputFiles: files,
    build: (inputs) => {
      const lines: string[] = [];
      lines.push("# Backend HTTP routes (NestJS controllers)\n");
      lines.push("Auto-extracted from `apps/**/modules/**/*.controller.ts`. Spec / code MUST reference these paths + handler names verbatim — do not invent `/api/v1/...`-style paths if they aren't here.\n");
      for (const rel of inputs) {
        const body = safeRead(repoRoot, rel);
        if (!body) continue;
        const controllerMatch = body.match(/@Controller\(['"]([^'"]*)['"]\)/);
        const base = controllerMatch ? controllerMatch[1]! : "";
        const routes = extractNestRoutes(body);
        if (routes.length === 0) continue;
        lines.push(`## \`${rel}\` (base: \`/${base}\`)`);
        for (const r of routes.slice(0, 50)) lines.push(`- \`${r.method} /${joinPath(base, r.path)}\` → \`${r.handler}\``);
        if (routes.length > 50) lines.push(`- … ${routes.length - 50} more`);
        lines.push("");
      }
      return lines.join("\n");
    },
  });
}

export function buildBackendEnumsDigest(repoRoot: string) {
  const enumsDir = join(repoRoot, "packages/enums/src");
  const files = existsSync(enumsDir)
    ? readdirSync(enumsDir).filter((f) => f.endsWith(".enum.ts")).map((f) => `packages/enums/src/${f}`)
    : [];
  return buildDigest({
    repoRoot, name: "backend-enums", inputFiles: files,
    build: (inputs) => {
      const lines: string[] = [];
      lines.push("# Backend enums (`packages/enums/src/`)\n");
      lines.push("Authoritative enum values. Spec must not invent values not listed here.\n");
      for (const rel of inputs) {
        const body = safeRead(repoRoot, rel);
        if (!body) continue;
        const enumMatch = body.match(/export enum (\w+) \{([\s\S]*?)\}/);
        if (!enumMatch) continue;
        const enumName = enumMatch[1]!;
        const values = (enumMatch[2] ?? "")
          .split(",")
          .map((v) => v.trim().split("=")[0]!.trim().replace(/['"\s/*]/g, ""))
          .filter((v) => v && /^[A-Z_]+$/.test(v));
        if (values.length === 0) continue;
        lines.push(`## ${enumName}`);
        lines.push(values.map((v) => `- ${v}`).join("\n"));
        lines.push("");
      }
      return lines.join("\n");
    },
  });
}

export function buildFrontendTypesDigest(repoRoot: string) {
  const typesDir = join(repoRoot, "mock/src/types");
  const files: string[] = [];
  if (existsSync(typesDir)) {
    for (const f of readdirSync(typesDir)) {
      if (f.endsWith(".ts")) files.push(`mock/src/types/${f}`);
    }
  }
  return buildDigest({
    repoRoot, name: "frontend-types", inputFiles: files,
    build: (inputs) => {
      const lines: string[] = [];
      lines.push("# Frontend mock types (`mock/src/types/`)\n");
      lines.push("Canonical TypeScript interfaces for the mock UI. Specs targeting mock UI MUST use these field names; adapters between mock + backend should map field-by-field instead of inventing intermediate shapes.\n");
      for (const rel of inputs) {
        const body = safeRead(repoRoot, rel);
        if (!body) continue;
        const ifaces = extractTsInterfaces(body);
        if (ifaces.length === 0) continue;
        lines.push(`## ${rel}`);
        for (const iface of ifaces) {
          lines.push(`### ${iface.name}`);
          lines.push("```ts");
          lines.push(iface.body.slice(0, 800));
          lines.push("```");
        }
        lines.push("");
      }
      return lines.join("\n");
    },
  });
}

export function buildFrontendComponentsDigest(repoRoot: string) {
  const files = findFilesByGlob(repoRoot, /^mock\/src\/(app|components)\/.+\.tsx$/);
  return buildDigest({
    repoRoot, name: "frontend-components", inputFiles: files,
    build: (inputs) => {
      const lines: string[] = [];
      lines.push("# Frontend mock components (`mock/src/{app,components}/`)\n");
      lines.push("Auto-extracted component exports + their Props interface name (when present). Use these names + prop shapes verbatim when referencing mock components from specs.\n");
      const byDir: Record<string, Array<{ name: string; propsName: string | null; rel: string }>> = {};
      for (const rel of inputs) {
        const body = safeRead(repoRoot, rel);
        if (!body) continue;
        const comps = extractComponentExports(body);
        for (const c of comps) {
          const dir = rel.split("/").slice(0, 3).join("/");
          if (!byDir[dir]) byDir[dir] = [];
          byDir[dir].push({ ...c, rel });
        }
      }
      for (const dir of Object.keys(byDir).sort()) {
        lines.push(`## ${dir}/`);
        for (const c of byDir[dir]!.slice(0, 80)) {
          const props = c.propsName ? ` <${c.propsName}>` : "";
          lines.push(`- \`${c.name}\`${props} — \`${c.rel}\``);
        }
        if (byDir[dir]!.length > 80) lines.push(`- … ${byDir[dir]!.length - 80} more`);
        lines.push("");
      }
      return lines.join("\n");
    },
  });
}

export function buildFrontendContextsDigest(repoRoot: string) {
  const files = findFilesByGlob(repoRoot, /^mock\/src\/contexts\/[^/]+\.tsx?$/);
  return buildDigest({
    repoRoot, name: "frontend-contexts", inputFiles: files,
    build: (inputs) => {
      const lines: string[] = [];
      lines.push("# Frontend mock contexts (`mock/src/contexts/`)\n");
      lines.push("Hook signatures exported from mock data-context providers. Use these to consume mock data + mutators in specs.\n");
      for (const rel of inputs) {
        const body = safeRead(repoRoot, rel);
        if (!body) continue;
        const sigs = extractHookSignatures(body);
        if (sigs.length === 0) continue;
        lines.push(`## \`${rel}\``);
        for (const s of sigs) lines.push(`- \`${s}\``);
        lines.push("");
      }
      return lines.join("\n");
    },
  });
}

export function buildTailwindTokensDigest(repoRoot: string) {
  const files = findFilesByGlob(repoRoot, /^(mock|apps)\/.+\.(tsx|jsx)$/, { maxDepth: 10 });
  return buildDigest({
    repoRoot, name: "tokens", inputFiles: files,
    build: (inputs) => {
      const counts: Record<string, number> = {};
      for (const rel of inputs) {
        const body = safeRead(repoRoot, rel);
        if (!body) continue;
        const toks = extractTailwindTokens(body);
        for (const t of toks) counts[t] = (counts[t] ?? 0) + 1;
      }
      const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      const lines: string[] = [];
      lines.push("# Tailwind brand-token vocabulary\n");
      lines.push("Auto-extracted from `mock/**/*.tsx` and `apps/**/*.tsx`. Specs / components SHOULD prefer these tokens over inventing new ones — the project's design system lives in these names.\n");
      if (ranked.length === 0) {
        lines.push("_(No brand-* / primary-* / secondary-* tokens detected.)_");
      } else {
        lines.push("| Token | Usages |");
        lines.push("|---|---|");
        for (const [tok, n] of ranked.slice(0, 60)) lines.push(`| \`${tok}\` | ${n} |`);
        if (ranked.length > 60) lines.push(`| … ${ranked.length - 60} more | |`);
      }
      return lines.join("\n");
    },
  });
}

export function buildConfigDigest(repoRoot: string) {
  const interesting = [
    "tsconfig.json",
    "tsconfig.base.json",
    "tailwind.config.ts",
    "tailwind.config.js",
    "next.config.ts",
    "next.config.js",
    "next.config.mjs",
    "pnpm-workspace.yaml",
    "package.json",
  ];
  const files: string[] = [];
  for (const p of interesting) if (existsSync(join(repoRoot, p))) files.push(p);
  for (const p of ["mock/package.json", "apps/back/package.json", "apps/patient/package.json", "apps/therapist/package.json"]) {
    if (existsSync(join(repoRoot, p))) files.push(p);
  }
  return buildDigest({
    repoRoot, name: "config", inputFiles: files,
    build: (inputs) => {
      const lines: string[] = [];
      lines.push("# Build / config conventions\n");
      lines.push("Auto-extracted from the consumer's tsconfig / tailwind / next / package.json files. Agents should respect path aliases + scripts listed here.\n");

      const tscRoot = safeRead(repoRoot, "tsconfig.json");
      if (tscRoot) {
        try {
          const parsed = JSON.parse(tscRoot.replace(/\/\*[^*]*\*\/|\/\/.*$/gm, "")) as { compilerOptions?: { paths?: Record<string, string[]> } };
          const paths = parsed.compilerOptions?.paths;
          if (paths) {
            lines.push("## TypeScript path aliases (`tsconfig.json`)");
            for (const [alias, targets] of Object.entries(paths)) {
              lines.push(`- \`${alias}\` → \`${targets.join(" | ")}\``);
            }
            lines.push("");
          }
        } catch { /* ignore parse errors */ }
      }

      const pkgPaths = inputs.filter((p) => p.endsWith("package.json"));
      if (pkgPaths.length > 0) {
        lines.push("## Workspace packages + run scripts");
        for (const rel of pkgPaths) {
          const body = safeRead(repoRoot, rel);
          if (!body) continue;
          try {
            const pkg = JSON.parse(body) as { name?: string; scripts?: Record<string, string> };
            if (!pkg.name) continue;
            lines.push(`### \`${pkg.name}\` (\`${rel}\`)`);
            const scripts = pkg.scripts ?? {};
            for (const [s, cmd] of Object.entries(scripts).slice(0, 12)) {
              lines.push(`- \`${s}\`: \`${cmd}\``);
            }
            lines.push("");
          } catch { /* ignore */ }
        }
      }
      return lines.join("\n");
    },
  });
}

export function buildMigrationsDigest(repoRoot: string) {
  const files = findFilesByGlob(repoRoot, /\/migrations\/\d+[^/]*\.ts$/);
  return buildDigest({
    repoRoot, name: "migrations", inputFiles: files,
    build: (inputs) => {
      const lines: string[] = [];
      lines.push("# Database migrations index\n");
      lines.push("All migrations in chronological order with extracted table names. Specs that need NEW tables MUST emit a `database_migrations:` section following the patterns established below.\n");
      for (const rel of inputs) {
        const body = safeRead(repoRoot, rel);
        if (!body) continue;
        const fname = rel.split("/").pop()!;
        const tables = new Set<string>();
        // Variants we've observed across consumers:
        //   - TypeORM raw: createTable("foo", ...)
        //   - SQL string:  CREATE TABLE foo (
        //   - delgoosh custom helper: DatabaseCreateTable(qr, "foo", ...)
        //   - new Table({name: "foo"})
        const patterns = [
          /createTable\s*\(\s*['"`](\w+)['"`]/g,
          /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi,
          /DatabaseCreateTable\s*\(\s*\w+\s*,\s*['"`](\w+)['"`]/g,
          /new\s+Table\s*\(\s*\{[^}]*name\s*:\s*['"`](\w+)['"`]/g,
        ];
        for (const re of patterns) {
          let m: RegExpExecArray | null;
          while ((m = re.exec(body)) !== null) tables.add(m[1]!);
        }
        lines.push(`- \`${fname}\`${tables.size ? ` — tables: ${[...tables].join(", ")}` : ""}`);
      }
      return lines.join("\n");
    },
  });
}

export function buildRoutesInventoryDigest(repoRoot: string) {
  const files = findFilesByGlob(repoRoot, /^(mock|apps\/[^/]+)\/src\/app\/.+\/page\.tsx$/);
  return buildDigest({
    repoRoot, name: "routes-inventory", inputFiles: files,
    build: (inputs) => {
      const lines: string[] = [];
      lines.push("# Filesystem route inventory (Next.js App Router)\n");
      lines.push("Auto-derived URL paths from `page.tsx` file locations. Specs should reference URLs from this list rather than inventing new ones.\n");
      const byApp: Record<string, string[]> = {};
      for (const rel of inputs) {
        const m = rel.match(/^((?:mock|apps\/[^/]+))\/src\/app\/(.+)\/page\.tsx$/);
        if (!m) continue;
        const app = m[1]!;
        const route = "/" + m[2]!
          .replace(/\([^)]+\)\//g, "")
          .replace(/\[([^\]]+)\]/g, ":$1");
        if (!byApp[app]) byApp[app] = [];
        byApp[app].push(route);
      }
      for (const app of Object.keys(byApp).sort()) {
        lines.push(`## \`${app}/\``);
        for (const r of byApp[app]!.sort()) lines.push(`- \`${r}\``);
        lines.push("");
      }
      return lines.join("\n");
    },
  });
}

// --- public entry: refresh everything ---

export interface RefreshKnowledgeResult {
  built: string[];
  skippedEmpty: string[];
  outDir: string;
}

export function refreshKnowledgeAuto(repoRoot: string, opts: { only?: string } = {}): RefreshKnowledgeResult {
  const builders: Array<{ name: string; fn: () => { body: string; built: boolean } }> = [
    { name: "backend-entities", fn: () => buildBackendEntitiesDigest(repoRoot) },
    { name: "backend-routes", fn: () => buildBackendRoutesDigest(repoRoot) },
    { name: "backend-enums", fn: () => buildBackendEnumsDigest(repoRoot) },
    { name: "frontend-types", fn: () => buildFrontendTypesDigest(repoRoot) },
    { name: "frontend-components", fn: () => buildFrontendComponentsDigest(repoRoot) },
    { name: "frontend-contexts", fn: () => buildFrontendContextsDigest(repoRoot) },
    { name: "tokens", fn: () => buildTailwindTokensDigest(repoRoot) },
    { name: "config", fn: () => buildConfigDigest(repoRoot) },
    { name: "migrations", fn: () => buildMigrationsDigest(repoRoot) },
    { name: "routes-inventory", fn: () => buildRoutesInventoryDigest(repoRoot) },
  ];

  const built: string[] = [];
  const skippedEmpty: string[] = [];
  for (const b of builders) {
    if (opts.only && b.name !== opts.only) continue;
    const r = b.fn();
    if (r.built) built.push(b.name);
    else skippedEmpty.push(b.name);
  }
  return { built, skippedEmpty, outDir: join(repoRoot, AUTO_DIR_REL) };
}

/**
 * CLI entry point. Called from cli.ts.
 */
export async function refreshKnowledge(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) { printHelp(); return; }
  const result = refreshKnowledgeAuto(args.repoRoot, { only: args.only });
  console.log(`slowcook refresh-knowledge · ${args.repoRoot}`);
  console.log(`  output: ${result.outDir}`);
  console.log(`  built: ${result.built.length > 0 ? result.built.join(", ") : "(nothing built)"}`);
  if (result.skippedEmpty.length > 0) {
    console.log(`  skipped (no inputs): ${result.skippedEmpty.join(", ")}`);
  }
}

function parseArgs(argv: string[]): { repoRoot: string; only: string | undefined; help: boolean } {
  let repoRoot = process.cwd();
  let only: string | undefined;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--cwd" && next) { repoRoot = next; i++; }
    else if (a === "--only" && next) { only = next; i++; }
    else if (a === "--auto") { /* accepted for symmetry */ }
    else if (a === "--help" || a === "-h") { help = true; }
  }
  return { repoRoot, only, help };
}

function printHelp(): void {
  console.log(`
slowcook refresh-knowledge — rebuild .brewing/repo-knowledge/auto/ digests

Usage:
  slowcook refresh-knowledge [--auto] [--only <name>] [--cwd <path>]

Cheap extractions (the current α.62 set) always rebuild — running the
command is the way to refresh. --only <name> rebuilds just one.

Outputs land in .brewing/repo-knowledge/auto/*.md. Gitignore that dir;
the contents are deterministic and meant to be regenerated.
`);
}
