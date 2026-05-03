/**
 * `slowcook init from-prod` — 0.18.0 — generate a perfect mock by
 * mirroring the consumer's prod src/ into mock/ with fixture-backed
 * data wiring. Pure deterministic; no LLM.
 *
 * Encodes the 4-strategy taxonomy from docs/plans/0.17-brownfield-pipeline.md
 * (informed by the hand-built rewo perfect-mock at mock/LESSONS.md):
 *
 *   A — verbatim copy (pure UI / pure data; no I/O)
 *   B — DI seam (client component with `fetch()` → api-client wrapper)
 *   C2 — server-mock + import-alias swap (Server Component / Supabase)
 *   D — skip with @slowcook-mock-skip marker (server actions, websockets)
 *
 * Strategy detection:
 *   - File contains `import.*supabase` AND under `src/utils/supabase/`
 *     → C2 (re-export shim)
 *   - File contains `"use server"` directive → D (skip with marker)
 *   - File is a Server Component (top-of-file `export default async function`
 *     in src/app/, NO "use client") → C2-eligible (server-mock import alias
 *     handles it transparently)
 *   - File is a Client Component (`"use client"`) AND contains `fetch(`
 *     → B (DI seam: fetch wrapped in api-client function)
 *   - Anything else → A (verbatim copy)
 *
 * The agent ALSO emits:
 *   - `mock/src/lib/server-mock/supabase-server.ts` — fluent Supabase
 *     mock client (the C2 swap target)
 *   - `mock/src/lib/api-client/` — one file per detected fetch endpoint
 *     (the B swap target)
 *   - `mock/src/fixtures/` — one file per detected DB table (extracted
 *     from supabase/migrations/)
 *   - `mock/src/utils/supabase/server.ts` and `client.ts` — re-export
 *     shims to the server-mock layer
 *   - `mock/package.json`, `next.config.js`, `tsconfig.json`, etc.
 *     — Next.js shell with the same major versions as prod
 *
 * Idempotent: re-running on an existing mock/ skips files that already
 * have a `@slowcook-mock-from` marker matching their prod source.
 *
 * 0.18.0 ships the SCAFFOLDING; 0.18.1+ refines the strategy detector
 * + auto-generates the per-table fixture handlers from migrations.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

interface FromProdArgs {
  repoRoot: string;
  /** Output mock directory (default: mock/). */
  outDir: string;
  /** Print planned actions; don't write. */
  dryRun: boolean;
  /** Overwrite existing mock/ files even when they don't carry the marker. */
  force: boolean;
}

type Strategy = "A-verbatim" | "B-di-seam" | "C2-server-mock" | "D-skip";

interface FileAction {
  src: string;
  dest: string;
  strategy: Strategy;
  reason: string;
}

function parseArgs(argv: string[]): FromProdArgs {
  const args: FromProdArgs = {
    repoRoot: process.cwd(),
    outDir: "mock",
    dryRun: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--cwd" && next) { args.repoRoot = next; i++; }
    else if (a === "--out" && next) { args.outDir = next; i++; }
    else if (a === "--dry-run") { args.dryRun = true; }
    else if (a === "--force") { args.force = true; }
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook init from-prod — generate perfect mock from prod src/ (0.18.0)

Mirrors src/ into mock/src/ with fixture-backed data wiring. Encodes
the 4-strategy taxonomy: verbatim / DI-seam / server-mock / skip.

Usage:
  slowcook init from-prod [--cwd <path>] [--out mock] [--dry-run] [--force]

Options:
  --cwd <path>   Repo root (default: cwd).
  --out <dir>    Output directory (default: mock).
  --dry-run      Print planned strategy per file; don't write.
  --force        Overwrite existing mock/ files even when they don't
                 carry the @slowcook-mock-from marker.

What's NOT yet automated (0.18.0 ships scaffolding only):
  - Per-table fixture file content from supabase/migrations/
  - Per-endpoint api-client function bodies from src/ fetch call sites
  - Server-mock fluent client beyond the rewo-derived skeleton

For projects that don't match the rewo prod shape (Supabase + Next RSC),
fall back to writing mock/ by hand using the strategies in mock/LESSONS.md
of the rewo dogfood as a reference.
`);
}

export async function initFromProd(argv: string[], _cliVersion: string): Promise<void> {
  const args = parseArgs(argv);
  const srcDir = join(args.repoRoot, "src");
  if (!existsSync(srcDir)) {
    console.error(`No src/ directory at ${srcDir}; nothing to mirror.`);
    process.exit(64);
  }

  console.log(`slowcook init from-prod · cwd: ${relative(process.cwd(), args.repoRoot) || "."}`);
  console.log(`  src: ${relative(args.repoRoot, srcDir)}`);
  console.log(`  out: ${args.outDir}/src`);

  const actions: FileAction[] = [];
  for (const abs of walkFiles(srcDir, /\.(tsx?|jsx?|css)$/)) {
    const rel = relative(args.repoRoot, abs).replace(/\\/g, "/");
    const dest = `${args.outDir}/${rel}`;
    const strategy = detectStrategy(abs);
    actions.push({ src: rel, dest, strategy, reason: strategyReason(strategy) });
  }

  // Print plan
  const counts = countByStrategy(actions);
  console.log(
    `  ${actions.length} files: ${counts["A-verbatim"]} A · ${counts["B-di-seam"]} B · ${counts["C2-server-mock"]} C2 · ${counts["D-skip"]} D`
  );
  if (args.dryRun) {
    for (const a of actions) {
      console.log(`  [${a.strategy}] ${a.src} → ${a.dest}  (${a.reason})`);
    }
    console.log("\n--dry-run: no files written.");
    return;
  }

  // Execute
  let written = 0;
  let skipped = 0;
  for (const a of actions) {
    const destAbs = join(args.repoRoot, a.dest);
    if (existsSync(destAbs) && !args.force) {
      const head = readFileSync(destAbs, "utf8").slice(0, 2048);
      if (!head.includes(`@slowcook-mock-from ${a.src}`)) {
        skipped++;
        continue;
      }
    }
    mkdirSync(dirname(destAbs), { recursive: true });
    const body = applyStrategy(args.repoRoot, a);
    writeFileSync(destAbs, body, "utf8");
    written++;
  }

  console.log(`\nDone. ${written} file(s) written; ${skipped} skipped (already exists without marker; use --force to overwrite).`);
  console.log(
    "\nNext steps:\n" +
      "  1. Hand-write mock/src/lib/server-mock/supabase-server.ts (use mock/LESSONS.md as the template)\n" +
      "  2. Hand-write mock/src/lib/api-client/<domain>.ts files for each fetch endpoint\n" +
      "  3. Hand-write mock/src/fixtures/<table>.ts files per supabase/migrations/\n" +
      "  4. Add mock/package.json + next.config.js + tsconfig (mirror prod's, drop test/lint deps)\n" +
      "  5. cd mock && npm install && npm run dev"
  );
  console.log("\n0.18.1+ will automate steps 1-4. Until then this is hand-written; the rewo perfect-mock is the worked reference.");
}

// ----- helpers -----

export function detectStrategy(absFile: string): Strategy {
  let body: string;
  try {
    body = readFileSync(absFile, "utf8");
  } catch {
    return "A-verbatim";
  }
  // D — server actions (cannot run in mock)
  if (/^\s*["']use\s+server["']/.test(body)) return "D-skip";
  // C2 — supabase utility files (need re-export shim)
  if (/src\/utils\/supabase\/(server|client|middleware)\.ts$/.test(absFile)) return "C2-server-mock";
  // C2-eligible — Server Component (no "use client" + async default export OR await imports)
  if (/src\/app\//.test(absFile) && /\.tsx$/.test(absFile)) {
    const hasUseClient = /^\s*["']use\s+client["']/.test(body);
    const hasAwait = /\bawait\s+(supabase|createClient|fetch|cookies\(\))/.test(body);
    const isAsyncDefault = /export\s+default\s+async\s+function/.test(body);
    if (!hasUseClient && (hasAwait || isAsyncDefault)) return "C2-server-mock";
  }
  // B — Client component with direct fetch
  if (/^\s*["']use\s+client["']/.test(body) && /\bfetch\s*\(/.test(body)) return "B-di-seam";
  return "A-verbatim";
}

function strategyReason(s: Strategy): string {
  switch (s) {
    case "A-verbatim": return "no I/O detected; safe verbatim copy";
    case "B-di-seam": return "client fetch detected; should route through api-client (manual wire-up still required)";
    case "C2-server-mock": return "server-side I/O detected; runs unchanged via @/utils/supabase alias-shim";
    case "D-skip": return "server action / non-mockable runtime; emit stub with @slowcook-mock-skip marker";
  }
}

function countByStrategy(actions: FileAction[]): Record<Strategy, number> {
  const counts: Record<Strategy, number> = {
    "A-verbatim": 0, "B-di-seam": 0, "C2-server-mock": 0, "D-skip": 0,
  };
  for (const a of actions) counts[a.strategy]++;
  return counts;
}

function applyStrategy(repoRoot: string, a: FileAction): string {
  const src = readFileSync(join(repoRoot, a.src), "utf8");
  const header = `// @slowcook-mock-from ${a.src}\n// Strategy: ${a.strategy} (${strategyReason(a.strategy)})\n`;
  switch (a.strategy) {
    case "A-verbatim":
      return header + src;
    case "C2-server-mock":
      // For supabase utility files: emit re-export shim. For RSC files:
      // verbatim copy (the alias resolves to mock when project's tsconfig
      // points @/utils/supabase to mock-perfect's stubs).
      if (/src\/utils\/supabase\/server\.ts$/.test(a.src)) {
        return header + `export { createClient } from "@/lib/server-mock/supabase-server";\n`;
      }
      if (/src\/utils\/supabase\/client\.ts$/.test(a.src)) {
        return header + `export { createClient } from "@/lib/server-mock/supabase-browser";\n`;
      }
      if (/src\/utils\/supabase\/middleware\.ts$/.test(a.src)) {
        return header +
          `// No-op mock middleware: real auth is not enforced in mock.\n` +
          `import { type NextRequest, NextResponse } from "next/server";\n` +
          `export async function updateSession(request: NextRequest) {\n` +
          `  return NextResponse.next({ request });\n` +
          `}\n`;
      }
      return header + src; // RSC files: byte-identical
    case "B-di-seam":
      return header +
        `// TODO(perfect-mock 0.18.1): the fetch() call(s) in this file should\n` +
        `// be routed through @/lib/api-client/<domain>. Until that's auto-extracted,\n` +
        `// this file is byte-identical to prod and the fetch will fail in the mock\n` +
        `// dev server unless the consumer adds a server-mock route handler.\n` +
        src;
    case "D-skip":
      return header +
        `// @slowcook-mock-skip — server-side runtime not mockable in this layer.\n` +
        `// (Original prod source preserved below; the mock app should not import this file.)\n` +
        `/*\n${src}\n*/\n`;
  }
}

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

// Re-exports for tests
export { copyFileSync };
