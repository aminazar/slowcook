/**
 * `slowcook check prod-honesty` — the mock→prod honesty backbone.
 *
 * The mock is design scaffolding: it is *populated* (fixtures), *open* (every
 * route reachable, no auth walls), and *theatrical* (buttons do local-state
 * transitions) — all so a human can review it. Those three affordances must
 * NOT survive into production. The port→brew pipeline strips them when the
 * mock declares them through the seams; this check is the teeth that fail the
 * build when scaffolding leaks anyway.
 *
 * Why a check and not a test: fixtures, open routes, and dead CTAs are
 * *absence* obligations ("this fake thing is gone"), and a green test suite
 * proves presence, not absence. The defect is precisely the code no test
 * covers — so the enforcement cannot itself be a test.
 *
 * Pure-disk, no LLM, no tsc. Regex + readFileSync, mirroring mock-isolation.
 *
 * Scans the PRODUCTION tree (default `src/`, override `--dir`). Flags three
 * classes, each mapping to a field-reported defect:
 *
 *   A (fixtures)  — an inline literal array of ≥2 object literals that is
 *                   rendered (`.map(`) in the same file, and the file has no
 *                   data seam (`useDataDomain` / a `*BackendOn()` live-mode
 *                   gate). The canonical leak: `const ITEMS = [{…},{…}]` +
 *                   `{ITEMS.map(…)}` shipped verbatim from the mock.
 *   B (gating)    — a file under a routes/pages/app tree that renders route
 *                   definitions but contains no auth-guard reference
 *                   (`requireAuth` / `RequireAuth` / `getSession` / redirect
 *                   to a sign-in path). Heuristic; tuned to catch a router
 *                   that gates nothing.
 *   C (dead CTA)  — an `onClick`/`onSubmit` handler whose body only calls a
 *                   `setState`-shaped setter with no `fetch`/`navigate`/router
 *                   push and no explicit `deferred`/disabled acknowledgement.
 *
 * Escape hatch: a line or file carrying `// @slowcook-honest` (optionally
 * `// @slowcook-honest: reason`) is exempt — for the deliberate exceptions
 * (a genuinely public route, a label-map constant, a demo-only file). Every
 * exemption is greppable, so the reviewer sees exactly what was waived.
 */

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export type HonestyClass = "fixture" | "gating" | "dead_cta";

export interface HonestyViolation {
  file: string;
  line: number;
  cls: HonestyClass;
  reason: string;
}

export interface ProdHonestyResult {
  violations: HonestyViolation[];
  filesChecked: number;
}

const EXEMPT = /@slowcook-honest\b/;

function walkTsxFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (name === "node_modules" || name === ".next" || name === "dist" || name === "build") continue;
    // never scan test files — they legitimately hold fixtures + theater
    if (/\.(test|spec)\.(tsx?|jsx?)$/.test(name)) continue;
    if (/(^|\/)(test|tests|__tests__|__mocks__|fixtures)$/.test(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (name === "test" || name === "tests" || name === "__tests__" || name === "__mocks__" || name === "fixtures") continue;
      walkTsxFiles(full, acc);
    } else if (/\.(tsx|jsx)$/.test(name)) {
      acc.push(full);
    }
  }
  return acc;
}

/** true if the file routes data through a live backend seam. */
function hasDataSeam(body: string): boolean {
  return /useDataDomain\s*[<(]/.test(body)
    || /\b\w*[Bb]ackendOn\s*\(\)/.test(body)   // dataBackendOn(), authBackendOn(), etc.
    || /import\.meta\.env\.\w*_BACKEND/.test(body)
    || /process\.env\.\w*_BACKEND/.test(body);
}

/** A (fixtures): an inline ≥2-entry object-literal array that is .map-rendered. */
function findFixtureLeaks(lines: string[], body: string): { line: number; reason: string }[] {
  if (hasDataSeam(body)) return []; // behind the seam → the port/flag handles it
  const out: { line: number; reason: string }[] = [];
  // const NAME ... = [ ... ] spanning up to the closing bracket; detect ≥2 `{`
  const declRe = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*\[/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(declRe);
    if (!m) continue;
    const name = m[1]!;
    // gather until the array closes (bounded scan)
    let depth = 0, started = false, objectCount = 0, endLine = i;
    for (let j = i; j < Math.min(lines.length, i + 60); j++) {
      for (const ch of lines[j]!) {
        if (ch === "[") { depth++; started = true; }
        else if (ch === "]") { depth--; }
        else if (ch === "{" && depth >= 1) objectCount++;
      }
      if (started && depth <= 0) { endLine = j; break; }
    }
    if (objectCount < 2) continue; // not a fixture-shaped list
    // is it rendered? `{NAME.map(` or `NAME.map(` anywhere in the file
    if (new RegExp(`\\b${name}\\.map\\s*\\(`).test(body)) {
      if (EXEMPT.test(lines[i]!)) continue;
      out.push({
        line: i + 1,
        reason: `\`${name}\` is an inline fixture (${objectCount} entries) rendered in this file with no data seam. In prod this ships sample data. Route it through useDataDomain / a live-mode gate, or mark \`// @slowcook-honest\` if it's a config map.`,
      });
    }
    i = endLine;
  }
  return out;
}

/** B (gating): a route/page file that defines routes but references no guard. */
function findGatingGaps(relFile: string, body: string): { line: number; reason: string }[] {
  const isRouteFile = /(^|\/)(App|routes?|router|pages?|app)\.(tsx|jsx)$/i.test(relFile)
    || /(^|\/)(routes?|router)\//i.test(relFile);
  if (!isRouteFile) return [];
  const routeCount = (body.match(/<Route\b/g) ?? []).length;
  if (routeCount < 3) return []; // a leaf page, not a router
  const hasGuard = /requireAuth|RequireAuth|getSession|getSessionMember|useSession|redirect\(["'`]\/(sign-?in|login)/i.test(body);
  if (hasGuard || EXEMPT.test(body)) return [];
  return [{
    line: 1,
    reason: `This router defines ${routeCount} routes but references no auth guard (RequireAuth/getSession/redirect-to-signin). In prod, guests reach internal pages. Gate non-public routes, or mark \`// @slowcook-honest\` if every route here is genuinely public.`,
  }];
}

/**
 * C (dead CTA): an onClick/onSubmit that flips a state CLAIMING AN OUTCOME
 * (submitted / sent / done / success / provisioning / created / saved …)
 * without a real effect. This is the precise "fakes success" tell — it does
 * NOT flag legitimate local view-state (open a modal, switch a tab, toggle a
 * filter), which keeps the check high-signal enough to gate CI.
 */
const OUTCOME_SETTER = /\bset(?:Submitted|Sent|Done|Success|Complete|Completed|Provisioning|Provisioned|Confirmed|Saved|Created|Saved|Redeemed|Approved|Accepted|Booked|Paid|Requested|Connected|Finished)\b/;
function findDeadCtas(lines: string[]): { line: number; reason: string }[] {
  const out: { line: number; reason: string }[] = [];
  const handlerRe = /\bon(?:Click|Submit)\s*=\s*\{[^}]*=>\s*([^}]*)\}/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(handlerRe);
    if (!m) continue;
    const inline = m[1]!.trim();
    if (!inline) continue; // named handler ref — inline judge out of scope for v1
    // a FAKE success sets the outcome truthy; a reset (setSent(false)) is
    // legitimate local view-state, not a dead CTA.
    const outcomeM = inline.match(new RegExp(OUTCOME_SETTER.source + "\\s*\\(\\s*([^,)]*)"));
    const claimsOutcome = !!outcomeM && !/^(false|null|undefined|""|''|``|0)$/.test((outcomeM[1] ?? "").trim());
    const hasRealEffect = /\bfetch\s*\(|\bnavigate\s*\(|\.push\s*\(|\brouter\.|\baxios|href\s*=|window\.location|\bmutate\w*\s*\(|void\s+\w+\(|await\s/.test(inline);
    const acknowledged = /deferred|disabled|coming.?soon/i.test(line) || EXEMPT.test(line);
    if (claimsOutcome && !hasRealEffect && !acknowledged) {
      out.push({
        line: i + 1,
        reason: `This onClick flips a success/outcome state with no fetch/navigation — a button that FAKES success. Wire the real effect, render an honest disabled/deferred state, or mark \`// @slowcook-honest\`.`,
      });
    }
  }
  return out;
}

export function checkFileHonesty(absFile: string, body: string, repoRoot: string): HonestyViolation[] {
  const relFile = relative(repoRoot, absFile).replace(/\\/g, "/");
  if (EXEMPT.test(body.split(/\r?\n/)[0] ?? "")) return []; // whole-file exemption on line 1
  const lines = body.split(/\r?\n/);
  const v: HonestyViolation[] = [];
  for (const f of findFixtureLeaks(lines, body)) v.push({ file: relFile, line: f.line, cls: "fixture", reason: f.reason });
  for (const f of findGatingGaps(relFile, body)) v.push({ file: relFile, line: f.line, cls: "gating", reason: f.reason });
  for (const f of findDeadCtas(lines)) v.push({ file: relFile, line: f.line, cls: "dead_cta", reason: f.reason });
  return v;
}

export function runProdHonestyCheck(repoRoot: string, dir = "src"): ProdHonestyResult {
  const target = join(repoRoot, dir);
  if (!existsSync(target)) return { violations: [], filesChecked: 0 };
  const files = walkTsxFiles(target);
  const violations: HonestyViolation[] = [];
  for (const absFile of files) {
    violations.push(...checkFileHonesty(absFile, readFileSync(absFile, "utf8"), repoRoot));
  }
  return { violations, filesChecked: files.length };
}

export function runProdHonestyCli(argv: string[]): void {
  const cwdIdx = argv.indexOf("--cwd");
  const repoRoot = cwdIdx >= 0 ? argv[cwdIdx + 1]! : process.cwd();
  const dirIdx = argv.indexOf("--dir");
  const dir = dirIdx >= 0 ? argv[dirIdx + 1]! : "src";
  const { violations, filesChecked } = runProdHonestyCheck(repoRoot, dir);

  const LABEL: Record<HonestyClass, string> = {
    fixture: "A · fixture data in prod",
    gating: "B · route not gated",
    dead_cta: "C · CTA with no real effect",
  };
  if (violations.length === 0) {
    console.log(`✓ prod-honesty: ${filesChecked} files clean (no fixture/gating/dead-CTA leaks in ${dir}/)`);
    return;
  }
  console.error(`✗ prod-honesty: ${violations.length} issue(s) across ${filesChecked} files in ${dir}/\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${LABEL[v.cls]}]`);
    console.error(`    ${v.reason}\n`);
  }
  process.exit(1);
}
