/**
 * `slowcook check prod-bundle` — no mock-data ENGINE in the prod bundle.
 *
 * `prod-honesty` (its sibling) checks whether fixture data *renders* in prod;
 * this checks something deeper the directive demands: that the mock's data
 * ENGINE is not even *present* in the shipped bundle. A design-first app runs
 * an in-browser data engine (sql.js / SQLite WASM, or slowcook's own
 * mock-runtime fixture provider) so the mock is reviewable. Prod must be
 * ABRUPTLY DISCONNECTED from it — wired only to the real backend — so that a
 * misconfigured flag can never resurrect mock data. A runtime flag that merely
 * *bypasses* the engine is not enough: if the engine is in the bundle, it is a
 * flag flip away from serving fake data.
 *
 * This scans a BUILT dist directory (post-`vite build`/`next build`) and fails
 * when a forbidden engine marker appears in any emitted `.js`/`.wasm`. The
 * clean fix is a build-time sever (conditional/dynamic import gated by the
 * prod env literal) so the bundler tree-shakes the engine out entirely — then
 * this check passes because the engine is genuinely gone, not hidden.
 *
 * Pure-disk, no LLM. Runs in the consumer's deploy (after build, before
 * publish) and in CI.
 */

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, relative, basename } from "node:path";

export interface BundleViolation {
  file: string;
  marker: string;
  reason: string;
}

export interface ProdBundleResult {
  violations: BundleViolation[];
  filesScanned: number;
}

/**
 * Default forbidden engine markers. Each is a string that only appears when a
 * client-side data engine is bundled. `.wasm` filename patterns are matched
 * against basenames; text markers are matched against `.js` contents.
 */
export const DEFAULT_FORBIDDEN: { marker: string; where: "wasm-name" | "js-text"; label: string }[] = [
  { marker: "sql-wasm", where: "wasm-name", label: "sql.js SQLite WASM" },
  { marker: "sql-wasm", where: "js-text", label: "sql.js loader" },
  { marker: "initSqlJs", where: "js-text", label: "sql.js runtime" },
  { marker: "SQLite format 3", where: "js-text", label: "embedded SQLite db" },
  { marker: "better-sqlite3", where: "js-text", label: "better-sqlite3 engine" },
  { marker: "@slowcook-ai/mock-runtime", where: "js-text", label: "slowcook mock-runtime fixture engine" },
  { marker: "useScenarioFixture", where: "js-text", label: "mock fixture provider" },
];

function walkAssets(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const name of entries) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walkAssets(full, acc);
    else if (/\.(js|mjs|cjs|wasm)$/.test(name)) acc.push(full);
  }
  return acc;
}

export function runProdBundleCheck(
  repoRoot: string,
  distRel: string,
  forbidden = DEFAULT_FORBIDDEN,
): ProdBundleResult {
  const distDir = join(repoRoot, distRel);
  if (!existsSync(distDir)) return { violations: [], filesScanned: 0 };
  const files = walkAssets(distDir);
  const violations: BundleViolation[] = [];
  const seen = new Set<string>(); // dedupe (file, label)

  for (const abs of files) {
    const rel = relative(repoRoot, abs).replace(/\\/g, "/");
    const isWasm = abs.endsWith(".wasm");
    const name = basename(abs);
    if (isWasm) {
      for (const f of forbidden) {
        if (f.where === "wasm-name" && name.includes(f.marker)) {
          const key = rel + f.label;
          if (!seen.has(key)) { seen.add(key); violations.push({ file: rel, marker: f.marker, reason: f.label }); }
        }
      }
      continue;
    }
    // text scan for .js
    let body: string;
    try { body = readFileSync(abs, "utf8"); } catch { continue; }
    for (const f of forbidden) {
      if (f.where === "js-text" && body.includes(f.marker)) {
        const key = rel + f.label;
        if (!seen.has(key)) { seen.add(key); violations.push({ file: rel, marker: f.marker, reason: f.label }); }
      }
    }
  }
  return { violations, filesScanned: files.length };
}

export function runProdBundleCli(argv: string[]): void {
  const cwdIdx = argv.indexOf("--cwd");
  const repoRoot = cwdIdx >= 0 ? argv[cwdIdx + 1]! : process.cwd();
  const distIdx = argv.indexOf("--dist");
  const dist = distIdx >= 0 ? argv[distIdx + 1]! : "dist";
  const { violations, filesScanned } = runProdBundleCheck(repoRoot, dist);

  if (filesScanned === 0) {
    console.error(`✗ prod-bundle: no built assets found under ${dist}/ — build first, then check the dist.`);
    process.exit(2);
  }
  if (violations.length === 0) {
    console.log(`✓ prod-bundle: ${filesScanned} assets clean — no mock-data engine in ${dist}/`);
    return;
  }
  console.error(`✗ prod-bundle: a mock-data engine is present in ${dist}/ (${violations.length} marker(s))\n`);
  for (const v of violations) {
    console.error(`  ${v.file}`);
    console.error(`    contains ${v.reason} (\`${v.marker}\`) — prod must be SEVERED from the mock engine, not just flag-bypassed.`);
    console.error(`    Fix: gate the engine's import behind a build-time env literal so the bundler tree-shakes it out of prod.\n`);
  }
  process.exit(1);
}
