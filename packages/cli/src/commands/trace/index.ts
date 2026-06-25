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
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import YAML from "yaml";
import { listActiveSpecs, SPECS_DIR } from "../refine/spec-yaml.js";
import { loadMockShapeConfig } from "../../lib/mock-shape.js";
import { parsePrdInitiatives, type PrdInitiative } from "../menu/prd.js";
import {
  checkTrace,
  checkCoverage,
  checkSurfaces,
  checkFreshness,
  computeImpact,
  diffPrdStates,
  anchorHash,
  parseLcrProvenance,
  type LcrNode,
  type SpecNode,
  type SpecSurface,
  type SpecLink,
  type PrdAnchorState,
} from "./check.js";

/** Specs → their PRD link facts (anchor + recorded fingerprint). */
function loadSpecLinks(cwd: string): SpecLink[] {
  return listActiveSpecs(cwd).map((s) => ({
    storyId: s.story_id,
    prdAnchor: s.prd_ref?.anchor,
    prdSha: s.prd_ref?.sha,
  }));
}

/** Parse a PRD markdown string → current anchor fingerprints. */
function prdAnchorStates(md: string): PrdAnchorState[] {
  return parsePrdInitiatives(md).map((i: PrdInitiative) => ({ anchor: i.anchor, hash: anchorHash(i.body) }));
}

/** Insert/replace `sha:` inside a spec's `prd_ref:` block, preserving the file's
 *  formatting (targeted line edit, not a YAML round-trip that would reflow the
 *  hand-tweaked spec). Returns the new text, or the original if there's no
 *  prd_ref/anchor to stamp. */
export function setPrdSha(text: string, hash: string): string {
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => /^\s*prd_ref:\s*$/.test(l));
  if (i < 0) return text;
  const baseIndent = lines[i]!.match(/^\s*/)![0]!.length;
  let anchorIdx = -1;
  let shaIdx = -1;
  let childIndent = "  ";
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j]!;
    if (l.trim() === "") continue;
    const indent = l.match(/^\s*/)![0]!.length;
    if (indent <= baseIndent) break; // left the prd_ref block
    childIndent = l.match(/^\s*/)![0]!;
    if (/^\s*anchor:/.test(l)) anchorIdx = j;
    if (/^\s*sha:/.test(l)) shaIdx = j;
  }
  if (shaIdx >= 0) lines[shaIdx] = `${childIndent}sha: ${hash}`;
  else if (anchorIdx >= 0) lines.splice(anchorIdx + 1, 0, `${childIndent}sha: ${hash}`);
  else return text;
  return lines.join("\n");
}

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
  const sub = argv[0];
  if (sub === "stamp") return runStamp(argv.slice(1));
  if (sub === "impact") return runImpact(argv.slice(1));
  if (sub !== "check") {
    console.error("usage: slowcook trace <check|stamp|impact> [--prd <path>] [--cwd <dir>]");
    console.error("  check   provenance + coverage + surface + freshness lints   [--coverage] [--strict]");
    console.error("  stamp   record each spec's PRD-anchor fingerprint (prd_ref.sha)");
    console.error("  impact  which stories a PRD change touches   [--since <gitref>] [--anchors a,b]");
    process.exit(64);
  }
  const rest = argv.slice(1);
  const cwd = resolve(val(rest, "--cwd") ?? ".");
  const enforceCoverage = has(rest, "--coverage"); // make uncovered stories a hard failure
  const strict = has(rest, "--strict"); // make stale specs a hard failure too

  // 1. Specs → requirement-provenance facts.
  const specNodes: SpecNode[] = listActiveSpecs(cwd).map((s) => ({
    storyId: s.story_id,
    prdAnchor: s.prd_ref?.anchor,
    sourceIssue: s.source_issue,
  }));

  // 2. PRD anchors + fingerprints (optional — absent = brownfield).
  const prdRel = val(rest, "--prd") ?? "docs/PRD.md";
  const prdAbs = resolve(cwd, prdRel);
  const prdStates = existsSync(prdAbs) ? prdAnchorStates(readFileSync(prdAbs, "utf8")) : [];
  const prdAnchors = prdStates.map((s) => s.anchor);

  // 2b. Freshness — has any spec's PRD anchor moved since it was stamped?
  const freshness = checkFreshness({ specs: loadSpecLinks(cwd), anchors: prdStates });

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

  // Freshness (PRD↔spec): which specs were refined against a PRD section that has
  // since changed. Advisory by default (a section hash also moves on cosmetic
  // reflow); --strict makes it a hard failure. Unstamped specs are reported as a
  // hint to run `trace stamp`, never as stale.
  if (prdStates.length > 0) {
    if (freshness.stale.length === 0 && freshness.unstamped.length === 0) {
      console.log(`\n  freshness: ${freshness.freshCount} spec(s) match their PRD anchor — none stale.`);
    } else {
      if (freshness.stale.length) {
        const stream = strict ? console.error : console.log;
        stream(`\n  freshness: ${freshness.stale.length} spec(s) STALE — their PRD section changed since stamping${strict ? " (FAIL — --strict)" : " (review / run reconcile)"}:`);
        for (const s of freshness.stale) stream(`    ⚠ story-${s.storyId} ← §${s.anchor} (PRD moved)`);
      }
      if (freshness.unstamped.length) {
        console.log(`\n  freshness: ${freshness.unstamped.length} spec(s) unstamped — run \`slowcook trace stamp\` to baseline:`);
        for (const s of freshness.unstamped) console.log(`    · story-${s.storyId} ← §${s.anchor}`);
      }
    }
  }

  const provenanceOk = result.ok;
  const coverageOk = !enforceCoverage || coverage.ok;
  const surfacesOk = surfaceRes.ok;
  const freshnessOk = !strict || freshness.stale.length === 0;
  if (provenanceOk && coverageOk && surfacesOk && freshnessOk) {
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
  if (strict && freshness.stale.length) {
    console.error(`\ntrace check: FAIL ✗ — ${freshness.stale.length} stale spec(s) vs the PRD (--strict).`);
  }
  process.exit(1);
}

/** `slowcook trace stamp` — record each spec's PRD-anchor fingerprint into
 *  `prd_ref.sha`, baselining freshness. Run after a PRD↔spec set is agreed. */
async function runStamp(rest: string[]): Promise<void> {
  const cwd = resolve(val(rest, "--cwd") ?? ".");
  const prdRel = val(rest, "--prd") ?? "docs/PRD.md";
  const prdAbs = resolve(cwd, prdRel);
  if (!existsSync(prdAbs)) {
    console.error(`trace stamp: no PRD at ${prdRel} — nothing to fingerprint.`);
    process.exit(64);
  }
  const byAnchor = new Map(prdAnchorStates(readFileSync(prdAbs, "utf8")).map((s) => [s.anchor, s.hash]));
  const specsDir = resolve(cwd, SPECS_DIR);
  let stamped = 0;
  let skipped = 0;
  for (const spec of listActiveSpecs(cwd)) {
    const anchor = spec.prd_ref?.anchor;
    if (!anchor) { skipped++; continue; }
    const hash = byAnchor.get(anchor);
    if (hash === undefined) { console.log(`  · story-${spec.story_id}: anchor §${anchor} not in PRD — skipped`); skipped++; continue; }
    const file = join(specsDir, `story-${spec.story_id}.yaml`);
    const before = readFileSync(file, "utf8");
    const after = setPrdSha(before, hash);
    if (after !== before) { writeFileSync(file, after); stamped++; }
  }
  console.log(`trace stamp: ${stamped} spec(s) stamped${skipped ? `, ${skipped} skipped (no prd_ref / unknown anchor)` : ""}.`);
}

/** `slowcook trace impact` — which stories does a PRD change touch? Changed
 *  anchors come from `--anchors a,b` or `--since <gitref>` (diff the PRD between
 *  that revision and the working tree). Read-only. */
async function runImpact(rest: string[]): Promise<void> {
  const cwd = resolve(val(rest, "--cwd") ?? ".");
  const prdRel = val(rest, "--prd") ?? "docs/PRD.md";
  const prdAbs = resolve(cwd, prdRel);
  const specs = loadSpecLinks(cwd);

  let changedAnchors: string[];
  const explicit = val(rest, "--anchors");
  const since = val(rest, "--since");
  if (explicit) {
    changedAnchors = explicit.split(",").map((a) => a.trim()).filter(Boolean);
  } else if (since) {
    if (!existsSync(prdAbs)) { console.error(`trace impact: no PRD at ${prdRel}.`); process.exit(64); }
    let beforeMd: string;
    try {
      beforeMd = execFileSync("git", ["show", `${since}:${prdRel}`], { cwd, encoding: "utf8" });
    } catch {
      console.error(`trace impact: couldn't read ${prdRel} at '${since}' (bad ref or path?).`);
      process.exit(1);
    }
    const afterMd = readFileSync(prdAbs, "utf8");
    const d = diffPrdStates(prdAnchorStates(beforeMd), prdAnchorStates(afterMd));
    changedAnchors = d.changed;
    const extra = [...d.added.map((a) => `+§${a}`), ...d.removed.map((a) => `-§${a}`)];
    console.log(`trace impact: PRD diff ${since}..worktree — ${d.changed.length} changed${extra.length ? `, ${extra.join(" ")}` : ""}.`);
  } else {
    console.error("trace impact: pass --since <gitref> or --anchors a,b");
    process.exit(64);
  }

  const { affected } = computeImpact({ specs, changedAnchors });
  if (changedAnchors.length === 0) { console.log("  no PRD anchors changed — no stories impacted."); return; }
  console.log(`  changed anchors: ${changedAnchors.map((a) => `§${a}`).join(", ")}`);
  if (affected.length === 0) { console.log("  no stories link the changed anchors."); return; }
  const byAnchor = new Map<string, string[]>();
  for (const a of affected) (byAnchor.get(a.anchor) ?? byAnchor.set(a.anchor, []).get(a.anchor)!).push(`story-${a.storyId}`);
  console.log(`\n  ${affected.length} story(ies) impacted:`);
  for (const [anchor, stories] of byAnchor) console.log(`    §${anchor} → ${stories.join(", ")}`);
  console.log(`\n  next: \`slowcook reconcile --story <id>\` proposes the per-story edits (one hop, review before apply).`);
}
