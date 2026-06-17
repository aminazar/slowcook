/**
 * GUCDI — `slowcook trace check`. Runs the provenance-completeness lint over the
 * spine: specs (requirement provenance via prd_ref/source_issue), the PRD
 * (anchor resolution), and the LCR mock files (story/convention/craft comments).
 * Exits 1 on any orphan/dangling violation; prints the craft-decisions report
 * for PM ratification. Never demands a PRD — brownfield-safe.
 *
 *   slowcook trace check [--prd <path>] [--cwd <dir>]
 *
 * Pure lint in ./check.ts; this is the IO shell.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import YAML from "yaml";
import { listActiveSpecs, SPECS_DIR } from "../refine/spec-yaml.js";
import { loadMockShapeConfig } from "../../lib/mock-shape.js";
import { parsePrdInitiatives } from "../menu/prd.js";
import { checkTrace, checkCoverage, checkSurfaces, parseLcrProvenance, type LcrNode, type SpecNode, type SpecSurface } from "./check.js";

/** Read persona-surface declarations from the spec YAMLs (the `persona` +
 *  `surfaces` blocks the generator compiles into the mock). */
function readSpecSurfaces(cwd: string): SpecSurface[] {
  const dir = resolve(cwd, SPECS_DIR);
  if (!existsSync(dir)) return [];
  const out: SpecSurface[] = [];
  for (const name of readdirSync(dir)) {
    if (!/^story-.*\.yaml$/.test(name)) continue;
    let doc: { story_id?: string; persona?: { id?: string }; surfaces?: Array<{ route?: string; home?: boolean }> };
    try { doc = YAML.parse(readFileSync(join(dir, name), "utf8")) ?? {}; } catch { continue; }
    const persona = doc.persona?.id;
    if (!persona || !Array.isArray(doc.surfaces)) continue;
    for (const s of doc.surfaces) {
      if (s?.route) out.push({ storyId: `story-${doc.story_id}`, persona, route: s.route, home: s.home === true });
    }
  }
  return out;
}

/** Extract concrete route paths from a react-router file (path="..."). */
function readRouterPaths(file: string): string[] {
  if (!existsSync(file)) return [];
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/path\s*=\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!).filter((p) => p && p !== "*");
}

function val(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}
const has = (args: string[], flag: string): boolean => args.includes(flag);

/** Recursively collect .tsx files under `dir`, skipping any path in `exclude`. */
function walkTsx(dir: string, exclude: Set<string>): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (exclude.has(p) || name === "node_modules") continue;
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkTsx(p, exclude));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

export async function trace(argv: string[], _cliVersion: string): Promise<void> {
  if (argv[0] !== "check") {
    console.error("usage: slowcook trace check [--prd <path>] [--cwd <dir>] [--coverage]");
    process.exit(64);
  }
  const rest = argv.slice(1);
  const cwd = resolve(val(rest, "--cwd") ?? ".");
  const enforceCoverage = has(rest, "--coverage"); // make uncovered stories a hard failure

  // 1. Specs → requirement-provenance facts.
  const specNodes: SpecNode[] = listActiveSpecs(cwd).map((s) => ({
    storyId: s.story_id,
    prdAnchor: s.prd_ref?.anchor,
    sourceIssue: s.source_issue,
  }));

  // 2. PRD anchors (optional — absent = brownfield).
  const prdRel = val(rest, "--prd") ?? "docs/PRD.md";
  const prdAbs = resolve(cwd, prdRel);
  const prdAnchors = existsSync(prdAbs) ? parsePrdInitiatives(readFileSync(prdAbs, "utf8")).map((i) => i.anchor) : [];

  // 3. LCR nodes — mock screens + components (excluding the design system, which
  //    is convention/brand provenance, not story-specific).
  const mock = loadMockShapeConfig(cwd);
  const designDir = resolve(cwd, mock.design_system_dir);
  const lcrRoots = [resolve(cwd, mock.screens_root), resolve(cwd, mock.mock_root, "src/components")];
  const files = [...new Set(lcrRoots.flatMap((r) => walkTsx(r, new Set([designDir]))))];
  const lcrNodes: LcrNode[] = files.map((f) => ({
    file: relative(cwd, f).replace(/\\/g, "/"),
    provenance: parseLcrProvenance(readFileSync(f, "utf8")),
  }));

  if (specNodes.length === 0 && prdAnchors.length === 0 && lcrNodes.length === 0) {
    console.log("trace check: nothing GUCDI-shaped to trace (no specs, no PRD, no LCR) — ok.");
    return;
  }

  const result = checkTrace({ specs: specNodes, prdAnchors, lcrNodes });
  const coverage = checkCoverage({ specs: specNodes, lcrNodes });
  // Persona/surface trace: the same forward+inverse rules on the persona surfaces
  // declared in specs vs the routes the mock router actually exposes.
  const specSurfaces = readSpecSurfaces(cwd);
  const routerFile = mock.router_file ? resolve(cwd, mock.router_file) : "";
  const routes = routerFile ? readRouterPaths(routerFile) : [];
  const surfaceRes = checkSurfaces({ surfaces: specSurfaces, routes });

  console.log(
    `trace check: ${specNodes.length} specs · ${prdAnchors.length} PRD initiatives · ${lcrNodes.length} LCR files`,
  );
  if (result.craft.length) {
    console.log(`\n  ${result.craft.length} craft decision(s) — not in any requirement (ratify or note):`);
    for (const c of result.craft) console.log(`    · ${c.file}: ${c.rationale}`);
  }

  // Coverage (inverse): which stories have no surface in the mock. Informational
  // by default (backend/infra stories legitimately have none); --coverage makes
  // it a hard failure so a UI milestone can require every story to have a home.
  if (specNodes.length > 0) {
    if (coverage.ok) {
      console.log(`\n  coverage: every story has ≥1 LCR surface (${coverage.coveredCount}/${coverage.totalStories}).`);
    } else {
      const stream = enforceCoverage ? console.error : console.log;
      stream(`\n  coverage: ${coverage.uncovered.length}/${coverage.totalStories} stories have NO LCR surface${enforceCoverage ? " (FAIL — --coverage)" : " (review — backend stories may be fine)"}:`);
      for (const id of coverage.uncovered) stream(`    ✗ ${id}`);
    }
  }

  // Persona/surface trace report (same rules as provenance, applied to surfaces).
  if (specSurfaces.length > 0) {
    if (surfaceRes.ok) {
      console.log(`\n  surfaces: ${surfaceRes.surfaceCount} persona surface(s), every declared route resolves to a real mock route.`);
    } else {
      if (surfaceRes.dangling.length) {
        console.error(`\n  surfaces: ${surfaceRes.dangling.length} declared surface(s) with NO matching mock route (dangling):`);
        for (const s of surfaceRes.dangling) console.error(`    ✗ ${s.persona} → ${s.route} (${s.storyId})`);
      }
      if (surfaceRes.unreachablePersonas.length) {
        console.error(`  surfaces: persona(s) whose home route is unreachable: ${surfaceRes.unreachablePersonas.join(", ")}`);
      }
    }
  }

  const provenanceOk = result.ok;
  const coverageOk = !enforceCoverage || coverage.ok;
  const surfacesOk = surfaceRes.ok;
  if (provenanceOk && coverageOk && surfacesOk) {
    console.log("\ntrace check: PASS ✓ — every node has honest provenance" + (enforceCoverage ? ", every story has a surface," : "") + " and every persona surface resolves.");
    return;
  }
  if (!provenanceOk) {
    console.error(`\ntrace check: FAIL ✗ — ${result.violations.length} provenance violation(s):`);
    for (const v of result.violations) console.error(`  [${v.code}] ${v.subject}: ${v.detail}`);
  }
  if (!surfacesOk) {
    console.error(`\ntrace check: FAIL ✗ — ${surfaceRes.dangling.length + surfaceRes.unreachablePersonas.length} persona-surface violation(s) (a spec promises a surface the mock doesn't expose).`);
  }
  if (enforceCoverage && !coverage.ok) {
    console.error(`\ntrace check: FAIL ✗ — ${coverage.uncovered.length} story(ies) with no surface (--coverage).`);
  }
  process.exit(1);
}
