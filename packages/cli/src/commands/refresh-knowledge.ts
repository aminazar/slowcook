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
 *     ├── aliases.md            (every tsconfig + vite/vitest path alias)
 *     ├── migrations.md         (migration file timestamps + table names)
 *     └── routes-inventory.md   (filesystem-derived route URLs)
 *
 * Refine (`refine/context.ts`) reads these from disk and concatenates
 * them. If the dir doesn't exist (first run), refine falls back to the
 * legacy in-memory scan (α.61 readNestJsBackendDigest).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

const AUTO_DIR_REL = ".brewing/repo-knowledge/auto";
const CURATED_DIR_REL = ".brewing/repo-knowledge/curated";

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

/**
 * Parse the values out of an `export enum { … }` body.
 *
 * Strips JSDoc block comments + line comments first, then splits on
 * commas. Without the strip, enums whose every value is preceded by
 * a JSDoc block (a common convention in the consumer's
 * `packages/enums/src/*.enum.ts`) would yield zero parsed values —
 * the JSDoc text leaks into the identifier slot, fails the
 * uppercase-only filter, and the whole enum drops from the digest.
 *
 * Exported for testing.
 */
export function parseEnumValues(enumBody: string): string[] {
  return enumBody
    // Strip JSDoc / block comments — `/* … */` (incl. multi-line).
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Strip line comments — `// …` to end of line.
    .replace(/\/\/.*$/gm, "")
    .split(",")
    .map((v) => v.trim().split("=")[0]!.trim().replace(/['"\s]/g, ""))
    .filter((v) => v && /^[A-Z_]+$/.test(v));
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
        const values = parseEnumValues(enumMatch[2] ?? "");
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

/**
 * Parse a tsconfig.json body's `compilerOptions.paths` map.
 * Strips JSON-with-comments before parsing (tsconfig allows
 * `//` and `/* … *​/` per spec). Returns `{}` on parse failure.
 *
 * Exported for testing.
 */
export function parseTsconfigPaths(
  body: string
): Record<string, string[]> {
  try {
    const json = JSON.parse(
      body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    ) as { compilerOptions?: { paths?: Record<string, string[]> } };
    return json.compilerOptions?.paths ?? {};
  } catch {
    return {};
  }
}

/**
 * Regex-extract `resolve.alias` keys + (best-effort) target hints from
 * a vite / vitest config body. The config is TS code and not safely
 * parseable here; we capture the common literal-object form:
 *
 *   resolve: { alias: { "@": path.join(root, "src"), … } }
 *
 * Returns `Array<{ alias: string; targetHint: string }>` where
 * `targetHint` is the raw RHS text (e.g., `path.join(root, "src")`).
 * Agents reading the digest can interpret the hint contextually.
 *
 * Exported for testing.
 */
export function parseViteAliases(
  body: string
): Array<{ alias: string; targetHint: string }> {
  // Find the `alias: {` opener, then walk char-by-char to find its
  // matching close brace (brace-balanced — naive regex can't do this
  // because the values may themselves contain `{}`).
  const opener = body.match(/\balias\s*:\s*\{/);
  if (!opener || opener.index === undefined) return [];
  let start = opener.index + opener[0].length;
  let depth = 1;
  let end = start;
  let qChar2: string | null = null;
  while (end < body.length && depth > 0) {
    const c = body[end]!;
    if (qChar2) {
      if (c === qChar2 && body[end - 1] !== "\\") qChar2 = null;
    } else if (c === '"' || c === "'" || c === "`") {
      qChar2 = c;
    } else if (c === "{") depth++;
    else if (c === "}") depth--;
    if (depth === 0) break;
    end++;
  }
  const block = body.slice(start, end);
  const out: Array<{ alias: string; targetHint: string }> = [];

  // Walk character-by-character so the value's parens / quotes don't
  // confuse a naive regex (e.g., `path.join(root, "src")` contains a
  // comma but is one value).
  let i = 0;
  while (i < block.length) {
    // Skip whitespace + commas.
    while (i < block.length && /[\s,]/.test(block[i]!)) i++;
    if (i >= block.length) break;
    // Expect a quote for the alias key.
    const q = block[i];
    if (q !== '"' && q !== "'") {
      // Not at a key — advance to next char.
      i++;
      continue;
    }
    i++; // past opening quote
    const keyStart = i;
    while (i < block.length && block[i] !== q) i++;
    const alias = block.slice(keyStart, i);
    i++; // past closing quote
    // Skip to colon.
    while (i < block.length && /\s/.test(block[i]!)) i++;
    if (block[i] !== ":") continue;
    i++; // past colon
    while (i < block.length && /\s/.test(block[i]!)) i++;
    // Capture value until top-level comma or newline (paren-aware).
    const valStart = i;
    let depth = 0;
    let qChar: string | null = null;
    while (i < block.length) {
      const c = block[i]!;
      if (qChar) {
        if (c === qChar && block[i - 1] !== "\\") qChar = null;
        i++;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        qChar = c;
        i++;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (depth === 0 && (c === "," || c === "\n")) break;
      i++;
    }
    const targetHint = block.slice(valStart, i).trim();
    if (alias && targetHint) out.push({ alias, targetHint });
  }
  return out;
}

/**
 * Walks the workspace for tsconfig + vite/vitest configs and emits a
 * single `aliases.md` listing every `@whatever`-style alias and what
 * it resolves to in EACH context.
 *
 * Motivation: in a monorepo the same alias (e.g. `@/`) often means
 * different things in different directories — root vitest config may
 * map `@/` to root `src/`, mock workspace's tsconfig may map `@/` to
 * `mock/src/`, and each Next.js app's tsconfig maps `@/` to its own
 * `apps/<role>/src/`. Without a digest, agents see `@/foo/bar` in a
 * file and can't tell which root it resolves against — they read the
 * config file by hand on every cold start. (Surfaced in
 * delgoosh/monorepo as a brew-vs-testgen path divergence.)
 */
export function buildAliasesDigest(repoRoot: string) {
  // Walk for tsconfigs (at root + per-workspace).
  const tsconfigs = findFilesByGlob(repoRoot, /(?:^|\/)tsconfig\.json$/, {
    maxDepth: 5,
  });
  // Walk for vite + vitest configs (TS/JS/MJS).
  const viteConfigs = findFilesByGlob(
    repoRoot,
    /(?:^|\/)vite(?:st)?\.config\.(?:ts|js|mjs)$/,
    { maxDepth: 5 }
  );
  return buildDigest({
    repoRoot,
    name: "aliases",
    inputFiles: [...tsconfigs, ...viteConfigs],
    build: (inputs) => {
      const rows: Array<{ alias: string; source: string; target: string }> = [];
      for (const rel of inputs) {
        const body = safeRead(repoRoot, rel);
        if (!body) continue;
        if (rel.endsWith("tsconfig.json")) {
          const paths = parseTsconfigPaths(body);
          for (const [alias, targets] of Object.entries(paths)) {
            rows.push({
              alias,
              source: rel,
              target: targets.join(" | "),
            });
          }
        } else {
          for (const e of parseViteAliases(body)) {
            rows.push({
              alias: e.alias,
              source: rel,
              target: e.targetHint,
            });
          }
        }
      }
      const lines: string[] = [];
      lines.push("# Path aliases\n");
      lines.push(
        "Auto-extracted from every `tsconfig.json` + `vite(st).config.{ts,js,mjs}` in the workspace. In a monorepo the SAME alias (e.g. `@/`) often resolves differently from different directories — agents should consult this digest before assuming where an `@/foo/bar` import lands.\n"
      );
      if (rows.length === 0) {
        lines.push("_(No path aliases detected.)_");
        return lines.join("\n");
      }
      lines.push("| Alias | Source | Target |");
      lines.push("|---|---|---|");
      for (const r of rows) {
        lines.push(`| \`${r.alias}\` | \`${r.source}\` | \`${r.target}\` |`);
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
    { name: "aliases", fn: () => buildAliasesDigest(repoRoot) },
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
 *
 * Default behavior (no mode flag) = run both --auto and --mine-history,
 * since they target different output dirs and have no overlap. Either
 * mode can be requested individually with the explicit flag.
 */
export async function refreshKnowledge(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) { printHelp(); return; }
  const runAuto = args.mode === "auto" || args.mode === "all";
  const runHistory = args.mode === "mine-history" || args.mode === "all";

  console.log(`slowcook refresh-knowledge · ${args.repoRoot}`);

  if (runAuto) {
    const result = refreshKnowledgeAuto(args.repoRoot, { only: args.only });
    console.log(`  [auto] output: ${result.outDir}`);
    console.log(`  [auto] built: ${result.built.length > 0 ? result.built.join(", ") : "(nothing built)"}`);
    if (result.skippedEmpty.length > 0) {
      console.log(`  [auto] skipped (no inputs): ${result.skippedEmpty.join(", ")}`);
    }
  }

  if (runHistory) {
    const result = refreshKnowledgeMineHistory(args.repoRoot, { full: args.fullHistory });
    console.log(`  [history] output: ${result.outDir}`);
    console.log(`  [history] built: ${result.built.length > 0 ? result.built.join(", ") : "(nothing built)"}`);
    console.log(`  [history] commits processed: ${result.commitsProcessed}${result.deltaFromSha ? ` (delta-aware: stamp had ${result.deltaFromSha.slice(0, 8)})` : ""}`);
  }
}

function parseArgs(argv: string[]): {
  repoRoot: string;
  mode: "auto" | "mine-history" | "all";
  only: string | undefined;
  fullHistory: boolean;
  help: boolean;
} {
  let repoRoot = process.cwd();
  let mode: "auto" | "mine-history" | "all" = "all";
  let only: string | undefined;
  let fullHistory = false;
  let help = false;
  let modeExplicit = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--cwd" && next) { repoRoot = next; i++; }
    else if (a === "--only" && next) { only = next; i++; mode = "auto"; modeExplicit = true; }
    else if (a === "--auto") { mode = modeExplicit ? mode : "auto"; modeExplicit = true; }
    else if (a === "--mine-history") { mode = modeExplicit ? "all" : "mine-history"; modeExplicit = true; }
    else if (a === "--full") { fullHistory = true; }
    else if (a === "--help" || a === "-h") { help = true; }
  }
  return { repoRoot, mode, only, fullHistory, help };
}

function printHelp(): void {
  console.log(`
slowcook refresh-knowledge — rebuild repo-knowledge digests

Usage:
  slowcook refresh-knowledge [--auto] [--mine-history] [--only <name>] [--cwd <path>]

Modes:
  --auto             rebuild auto/ digests (default if no mode given)
                     cheap extractions, always rebuild
  --mine-history     rebuild curated/ files from git history
                     expensive deterministic; delta-aware (re-mines new commits only)

--only <name> filters to one digest (auto mode only).

auto/ outputs are gitignored. curated/ outputs are TRACKED in git —
they're the durable organizational memory.
`);
}

// =====================================================================
// α.63 — git-history mining (expensive deterministic, delta-aware)
// =====================================================================

interface MineStamp {
  last_sha: string | null;
  last_mined_at: string;
  total_commits_seen: number;
}

interface CommitRow {
  sha: string;
  parent: string;
  author: string;
  date: string;
  subject: string;
  files: string[];
}

function writeCurated(repoRoot: string, name: string, body: string): void {
  const abs = join(repoRoot, CURATED_DIR_REL, `${name}.md`);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function readStamp(repoRoot: string): MineStamp | null {
  const path = join(repoRoot, CURATED_DIR_REL, ".last-mined.json");
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")) as MineStamp; } catch { return null; }
}

function writeStamp(repoRoot: string, stamp: MineStamp): void {
  const abs = join(repoRoot, CURATED_DIR_REL, ".last-mined.json");
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(stamp, null, 2) + "\n", "utf8");
}

/**
 * Walk git log, return CommitRow[] sorted oldest-first.
 *
 * Uses `git log --name-only --pretty=format` with a unique separator so
 * we can parse robustly. The default `maxCommits` cap (1500) covers a
 * typical brownfield project's history without timing out.
 */
function gitLogRows(repoRoot: string, maxCommits = 1500): CommitRow[] {
  const sep = "<<<COMMIT>>>";
  const fieldSep = "<<<F>>>";
  let raw = "";
  try {
    raw = execSync(
      `git -C "${repoRoot}" log --no-merges --name-only --pretty=format:'${sep}%H${fieldSep}%P${fieldSep}%an${fieldSep}%aI${fieldSep}%s' -n ${maxCommits}`,
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
  } catch { return []; }
  const out: CommitRow[] = [];
  for (const block of raw.split(sep)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const lines = trimmed.split("\n");
    const header = lines[0] ?? "";
    const parts = header.split(fieldSep);
    if (parts.length < 5) continue;
    const sha = parts[0]!;
    const parent = parts[1]!.split(" ")[0] ?? "";
    const author = parts[2]!;
    const date = parts[3]!;
    const subject = parts[4] ?? "";
    const files = lines.slice(1).map((l) => l.trim()).filter((l) => l.length > 0);
    out.push({ sha, parent, author, date, subject, files });
  }
  // Reverse so oldest is first — easier to reason about temporal accumulation.
  return out.reverse();
}

/**
 * commit-conventions.md — bucket by type:scope from conventional-commit
 * prefixes. Tells refine which prefixes + scopes are in active use so
 * spec PRs match the local style.
 */
function buildCommitConventions(rows: CommitRow[]): string {
  const conventionRe = /^(feat|fix|chore|refactor|docs|test|perf|style|build|ci|revert)(?:\(([^)]+)\))?\s*:/;
  const byType: Record<string, number> = {};
  const byScope: Record<string, number> = {};
  let unconventional = 0;
  for (const r of rows) {
    const m = r.subject.match(conventionRe);
    if (!m) { unconventional++; continue; }
    const type = m[1]!;
    let scope = m[2] ?? "(none)";
    // Filter out `#NNN`-style "scopes" that are actually issue refs the
    // author accidentally put in the parens (e.g., `fix(#618): ...`).
    if (/^#\d+$/.test(scope)) scope = "(none)";
    byType[type] = (byType[type] ?? 0) + 1;
    byScope[scope] = (byScope[scope] ?? 0) + 1;
  }
  const total = rows.length;
  const conventional = total - unconventional;
  const lines: string[] = [];
  lines.push("# Commit conventions (mined from git history)\n");
  lines.push(`_Sample: ${total} non-merge commits; ${conventional} use conventional-commit prefixes (${Math.round(100 * conventional / Math.max(total, 1))}%)._`);
  lines.push("");
  lines.push("## Active type buckets");
  const typesSorted = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  lines.push("| Type | Count |");
  lines.push("|---|---|");
  for (const [t, n] of typesSorted) lines.push(`| \`${t}\` | ${n} |`);
  lines.push("");
  lines.push("## Active scopes (use these in new commit messages)");
  const scopesSorted = Object.entries(byScope).sort((a, b) => b[1] - a[1]).filter(([s]) => s !== "(none)");
  lines.push("| Scope | Count |");
  lines.push("|---|---|");
  for (const [s, n] of scopesSorted.slice(0, 30)) lines.push(`| \`${s}\` | ${n} |`);
  if (scopesSorted.length > 30) lines.push(`| … ${scopesSorted.length - 30} more | |`);
  return lines.join("\n");
}

/**
 * co-changes.md — file pairs that co-occur in commits >= threshold
 * times. Surfaces temporal coupling that's invisible to static
 * analysis (e.g., "every time `appointment.entity.ts` changes,
 * `appointment.dto.ts` changes too in 12/14 cases").
 *
 * Quadratic in files-per-commit; bounded to commits with <=20 files
 * to prevent O(n²) blow-up on huge refactors that aren't useful
 * signal anyway.
 */
function buildCoChanges(rows: CommitRow[]): string {
  const pairCounts = new Map<string, number>();
  const fileCounts = new Map<string, number>();
  for (const r of rows) {
    if (r.files.length === 0 || r.files.length > 20) continue;
    const interesting = r.files.filter((f) => /\.(ts|tsx|js|jsx|sql|md)$/.test(f) && !f.startsWith(".brewing/") && !f.startsWith("node_modules/"));
    for (const f of interesting) fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1);
    for (let i = 0; i < interesting.length; i++) {
      for (let j = i + 1; j < interesting.length; j++) {
        const a = interesting[i]!;
        const b = interesting[j]!;
        const key = a < b ? `${a}\t${b}` : `${b}\t${a}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }
  const lines: string[] = [];
  lines.push("# File co-change map (mined from git history)\n");
  lines.push("Pairs of files that historically change together. When a spec / PR touches one, also consider the other — co-change ≥3 usually signals coupling the type system can't see.\n");
  const pairs = [...pairCounts.entries()]
    .filter(([_, n]) => n >= 3)
    .map(([key, n]) => {
      const [a, b] = key.split("\t");
      return { a: a!, b: b!, n, support: Math.min(fileCounts.get(a!) ?? 1, fileCounts.get(b!) ?? 1) };
    })
    .filter((p) => p.n >= Math.max(3, Math.floor(p.support * 0.5))) // co-occur in >=50% of either file's commits
    .sort((a, b) => b.n - a.n);
  lines.push("| File A | File B | Co-changes |");
  lines.push("|---|---|---|");
  for (const p of pairs.slice(0, 60)) {
    lines.push(`| \`${p.a}\` | \`${p.b}\` | ${p.n} |`);
  }
  if (pairs.length > 60) lines.push(`| … ${pairs.length - 60} more | | |`);
  return lines.join("\n");
}

/**
 * ownership.md — top author per top-level directory. Tells refine
 * who owns what (useful for routing PM-facing questions in agent comments).
 */
function buildOwnership(rows: CommitRow[]): string {
  // Per-directory granularity at depth 2 means we get "apps/back" or
  // "packages/dtos" but also occasionally "packages/postgres" + sibling
  // entries that explode the table. Special-cased: top-level dirs with
  // a single file (.brewing/*.md, .githooks/*, etc.) collapse to the
  // top-level dir to avoid one row per file.
  const dirAuthorCount = new Map<string, Map<string, number>>();
  const TOPLEVEL_COLLAPSE = new Set([".brewing", ".github", ".cursor", ".vscode", ".husky", ".githooks"]);
  for (const r of rows) {
    for (const f of r.files) {
      const parts = f.split("/");
      const top = parts[0]!;
      const dir = TOPLEVEL_COLLAPSE.has(top) ? top : parts.slice(0, 2).join("/") || ".";
      let m = dirAuthorCount.get(dir);
      if (!m) { m = new Map(); dirAuthorCount.set(dir, m); }
      m.set(r.author, (m.get(r.author) ?? 0) + 1);
    }
  }
  const lines: string[] = [];
  lines.push("# Directory ownership (mined from git authorship)\n");
  lines.push("Top contributor per directory. Use this to decide who to route a PM-facing question to when a story spans multiple areas.\n");
  lines.push("| Directory | Top author | Commits |");
  lines.push("|---|---|---|");
  const dirsSorted = [...dirAuthorCount.keys()].sort();
  for (const dir of dirsSorted) {
    const authors = [...dirAuthorCount.get(dir)!.entries()].sort((a, b) => b[1] - a[1]);
    if (authors.length === 0) continue;
    const [topAuthor, topCount] = authors[0]!;
    lines.push(`| \`${dir}\` | ${topAuthor} | ${topCount} |`);
  }
  return lines.join("\n");
}

/**
 * issue-traceability.md — for each `#NNN` issue/PR reference in a
 * commit subject, list the commits that mention it. Cheap, useful for
 * agents that want to find the PM context behind a code change.
 */
function buildIssueTraceability(rows: CommitRow[]): string {
  const issueRe = /#(\d+)/g;
  const issueToCommits = new Map<string, Array<{ sha: string; subject: string }>>();
  for (const r of rows) {
    let m: RegExpExecArray | null;
    issueRe.lastIndex = 0;
    while ((m = issueRe.exec(r.subject)) !== null) {
      const n = m[1]!;
      if (!issueToCommits.has(n)) issueToCommits.set(n, []);
      issueToCommits.get(n)!.push({ sha: r.sha.slice(0, 8), subject: r.subject });
    }
  }
  const lines: string[] = [];
  lines.push("# Issue / PR traceability (mined from commit subjects)\n");
  lines.push("Maps `#N` references to the commits that mention them. Use to find PM intent behind a body of code changes.\n");
  const issues = [...issueToCommits.entries()].sort((a, b) => parseInt(b[0], 10) - parseInt(a[0], 10));
  for (const [n, commits] of issues.slice(0, 100)) {
    lines.push(`### #${n}`);
    for (const c of commits.slice(0, 8)) {
      lines.push(`- \`${c.sha}\` ${c.subject.replace(/\|/g, "\\|")}`);
    }
    lines.push("");
  }
  if (issues.length > 100) lines.push(`_… ${issues.length - 100} more issues with fewer commits._`);
  return lines.join("\n");
}

/**
 * fix-recipe-seeds.md — for each fix(*) commit, group by the files
 * touched. Refine + chef use this to spot recurring failure classes
 * (e.g., "vitest.config.ts has been fixed twice — known-flaky area").
 * NOT a curated insight (that's the next layer); just file→fix-PRs
 * map to surface the pattern.
 */
function buildFixRecipeSeeds(rows: CommitRow[]): string {
  const fileFixCount = new Map<string, Array<{ sha: string; subject: string; date: string }>>();
  for (const r of rows) {
    if (!/^fix\b/.test(r.subject)) continue;
    for (const f of r.files) {
      if (!/\.(ts|tsx|js|jsx|json|yaml|yml)$/.test(f)) continue;
      if (!fileFixCount.has(f)) fileFixCount.set(f, []);
      fileFixCount.get(f)!.push({ sha: r.sha.slice(0, 8), subject: r.subject, date: r.date.slice(0, 10) });
    }
  }
  const lines: string[] = [];
  lines.push("# Fix-recipe seeds (mined from fix(*) commits)\n");
  lines.push("Files that have been the target of fix-commits. A file with multiple fixes is a known-fragile area — check the listed commits before re-engineering. (Insights derived from these seeds live in `chef-known-fixes.md` once chef has analysed them.)\n");
  const ranked = [...fileFixCount.entries()].filter(([_, fixes]) => fixes.length >= 2).sort((a, b) => b[1].length - a[1].length);
  for (const [file, fixes] of ranked.slice(0, 40)) {
    lines.push(`### \`${file}\` — fixed ${fixes.length}×`);
    for (const f of fixes.slice(0, 6)) {
      lines.push(`- \`${f.sha}\` (${f.date}) ${f.subject}`);
    }
    lines.push("");
  }
  if (ranked.length > 40) lines.push(`_… ${ranked.length - 40} more files with 2+ fixes._`);
  return lines.join("\n");
}

export interface MineHistoryResult {
  outDir: string;
  built: string[];
  commitsProcessed: number;
  deltaFromSha: string | null;
}

export function refreshKnowledgeMineHistory(repoRoot: string, opts: { maxCommits?: number; full?: boolean } = {}): MineHistoryResult {
  const stamp = opts.full ? null : readStamp(repoRoot);
  const maxCommits = opts.maxCommits ?? 1500;
  const rows = gitLogRows(repoRoot, maxCommits);
  if (rows.length === 0) {
    return { outDir: join(repoRoot, CURATED_DIR_REL), built: [], commitsProcessed: 0, deltaFromSha: null };
  }
  // For now: always re-mine the full window. Delta-aware merge is
  // wired up via the stamp file (consumers see `last_sha`), but the
  // actual incremental aggregation lives in a later alpha — at 1000
  // commits this still takes <2s, so the full rebuild is fine.
  const built: string[] = [];
  const write = (name: string, body: string) => {
    writeCurated(repoRoot, name, body);
    built.push(name);
  };

  write("commit-conventions", buildCommitConventions(rows));
  write("co-changes", buildCoChanges(rows));
  write("ownership", buildOwnership(rows));
  write("issue-traceability", buildIssueTraceability(rows));
  write("fix-recipe-seeds", buildFixRecipeSeeds(rows));

  // Stamp updates regardless — captures the most-recent SHA we've
  // seen so future delta-mining knows where to resume from.
  const newest = rows[rows.length - 1]!;
  writeStamp(repoRoot, {
    last_sha: newest.sha,
    last_mined_at: new Date().toISOString(),
    total_commits_seen: rows.length,
  });

  return {
    outDir: join(repoRoot, CURATED_DIR_REL),
    built,
    commitsProcessed: rows.length,
    deltaFromSha: stamp?.last_sha ?? null,
  };
}
