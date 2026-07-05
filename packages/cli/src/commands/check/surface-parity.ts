/**
 * `slowcook check surface-parity` — mock/prod drift detector (#261).
 *
 * Design-first apps ship ONE source tree whose surfaces carry a canned branch
 * (the reviewable mock) and a live branch (the real product), selected by
 * build-time flags. The two silently diverge: a dead CTA fixed only in one
 * mode, copy updated in one branch, or an entire live branch dead-code-
 * eliminated because a flag was never set at build time (the 2026-07 dash
 * wallet page shipped CANNED to prod for weeks that way).
 *
 * Two sub-checks, both static (no browser):
 *
 * 1. FLAG COMPLETENESS — every `import.meta.env.<PREFIX>…` the source reads
 *    must be *declared* in each profile marked `require_all_flags` (the value
 *    may be "" = deliberately off; UNDECLARED means nobody ever considered it,
 *    which is how live branches vanish).
 *
 * 2. NODE PARITY — the universe of review nodes is parsed from source
 *    (`rn("…")` / `data-review-node`, the @slowcook-ai/review-overlay
 *    convention). Each profile is built with its env; a node's id LITERAL
 *    surviving into the bundle means its branch was not DCE'd. Divergent
 *    presence across profiles = drift. Known/deliberate divergence lives in a
 *    BASELINE (`.slowcook/parity-baseline.yaml`) with a reason + direction;
 *    new unwaived divergence fails (a ratchet), healed entries are flagged
 *    for cleanup.
 *
 * v1 limit (documented in #261): runtime-gated modes (localStorage flags)
 * don't DCE, so literal survival can't see them — the rendered-profile pass
 * is the v2 follow-up.
 *
 * Config (`.slowcook/parity.yaml` at the repo root):
 *   app: mock                       # build cwd, relative to root
 *   src: mock/src                   # scanned for flags + node ids
 *   build: npx vite build --outDir {outDir} --emptyOutDir
 *   env_prefix: VITE_
 *   markers: [data-review-node]     # or e.g. [data-testid] for repos without rn()
 *   baseline: .slowcook/parity-baseline.yaml   # per-app in multi-app repos
 *   profiles:
 *     mock: { env: {} }
 *     prod:
 *       env: { VITE_DATA_BACKEND: "1", … }
 *       require_all_flags: true
 *       allow_unset: [VITE_REVIEW_TOOLS]   # deliberately absent (qa-only)
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface ParityProfile {
  env: Record<string, string>;
  require_all_flags?: boolean;
  allow_unset?: string[];
  /** markers that must NOT survive into this profile's bundle (e.g. fixture
   *  emails, preview gates, review tooling in the real/prod profile) —
   *  the prod-bundle sever philosophy, per profile. */
  forbid?: string[];
}

export interface ParityConfig {
  app: string;
  /** one or several source dirs (shared component packages count too). */
  src: string | string[];
  build: string;
  env_prefix: string;
  /** attribute names harvested as node ids (besides rn() and *node= props).
   *  Default: data-review-node. Repos without review nodes can point this at
   *  their own stable-marker convention, e.g. data-testid. */
  markers: string[];
  /** baseline path (relative to root) — lets multi-app repos keep one per app. */
  baseline: string;
  profiles: Record<string, ParityProfile>;
}

export interface BaselineEntry {
  node: string;
  absent_from: string[];
  reason?: string;
  owner?: string;
  /** who is truth for this surface: mock-first (greenfield) | prod-first (as-built) */
  direction?: string;
}

export interface FlagViolation { flag: string; profile: string; readAt: string }
export interface NodeDrift { node: string; absent_from: string[]; presentIn: string[] }
export interface ForbidViolation { marker: string; profile: string }

export interface ParityResult {
  flagViolations: FlagViolation[];
  /** forbidden markers found in a profile's bundle — always failing. */
  forbidViolations: ForbidViolation[];
  /** divergent nodes NOT covered by the baseline — these fail the check. */
  newDrift: NodeDrift[];
  /** divergent nodes covered by the baseline — reported, never failing. */
  waivedDrift: NodeDrift[];
  /** baseline entries whose drift no longer exists — prune them. */
  healed: BaselineEntry[];
  /** node ids absent from EVERY profile bundle — likely dead code. */
  deadNodes: string[];
  nodesChecked: number;
  flagsChecked: number;
  profilesBuilt: string[];
}

const SRC_EXT = /\.(tsx?|jsx?|mjs|cjs|svelte|vue)$/;
// test files never ship — their ids would sit in the universe as permanent
// dead-node noise (found via delgoosh's button.test.tsx data-testid="custom").
const TEST_FILE = /\.(test|spec)\.[a-z]+$/;

function walk(dir: string, pred: (name: string) => boolean, acc: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const name of entries) {
    if (name.startsWith(".") || name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, pred, acc);
    else if (pred(name)) acc.push(full);
  }
  return acc;
}

/** every `import.meta.env.<PREFIX>X` / `["<PREFIX>X"]` read, with a source location. */
export function scanFlagReads(root: string, srcRel: string | string[], prefix: string): Map<string, string> {
  const srcDirs = (Array.isArray(srcRel) ? srcRel : [srcRel]).map((s) => join(root, s));
  const reads = new Map<string, string>(); // flag -> first "file:line"
  const re = new RegExp(String.raw`import\.meta\.env(?:\.(${prefix}[A-Z0-9_]+)|\[\s*["'](${prefix}[A-Z0-9_]+)["']\s*\])`, "g");
  for (const file of srcDirs.flatMap((d) => walk(d, (n) => SRC_EXT.test(n)))) {
    const body = readFileSync(file, "utf8");
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const flag = (m[1] ?? m[2])!;
      if (!reads.has(flag)) {
        const line = body.slice(0, m.index).split("\n").length;
        reads.set(flag, `${relative(root, file).replace(/\\/g, "/")}:${line}`);
      }
    }
  }
  return reads;
}

/**
 * review-node ids from source: rn("id", …), literal data-review-node="id",
 * and ids passed through props whose NAME mentions node (e.g.
 * `<RateInput node="budget/assumption/labor-rate" …>` — the wrapper calls
 * rn() internally). The prop form requires the slashed `area/name` shape so
 * ordinary strings don't false-positive.
 */
export function scanNodeIds(root: string, srcRel: string | string[], markers: string[] = ["data-review-node"]): Set<string> {
  const srcDirs = (Array.isArray(srcRel) ? srcRel : [srcRel]).map((s) => join(root, s));
  const ids = new Set<string>();
  const rnCall = /\brn\(\s*["'`]([^"'`]+)["'`]/g;
  const markerRes = markers.map(
    (attr) => new RegExp(String.raw`${attr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\s*[:=]\s*["'\`]([^"'\`]+)["'\`]`, "g"),
  );
  const nodeProp = /\b[a-zA-Z]*[nN]ode\s*=\s*["'`]([a-z0-9_-]+(?:\/[a-z0-9_-]+)+)["'`]/g;
  for (const file of srcDirs.flatMap((d) => walk(d, (n) => SRC_EXT.test(n) && !TEST_FILE.test(n)))) {
    const body = readFileSync(file, "utf8");
    let m: RegExpExecArray | null;
    while ((m = rnCall.exec(body)) !== null) if (!m[1]!.includes("${")) ids.add(m[1]!);
    for (const re of markerRes) {
      re.lastIndex = 0;
      while ((m = re.exec(body)) !== null) if (!m[1]!.includes("${")) ids.add(m[1]!);
    }
    while ((m = nodeProp.exec(body)) !== null) ids.add(m[1]!);
  }
  return ids;
}

/** all emitted .js text of a built dist, concatenated for literal probing. */
function bundleText(distDir: string): string {
  return walk(distDir, (n) => /\.(js|mjs|cjs|html)$/.test(n))
    .map((f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } })
    .join("\n");
}

export function loadConfig(root: string, path = ".slowcook/parity.yaml"): ParityConfig {
  const abs = join(root, path);
  if (!existsSync(abs)) throw new Error(`no parity config at ${path} — write one (see \`slowcook check help\`)`);
  const raw = parseYaml(readFileSync(abs, "utf8")) as Partial<ParityConfig>;
  if (!raw || typeof raw.build !== "string" || !raw.profiles || Object.keys(raw.profiles).length < 2) {
    throw new Error(`${path} needs at least: build, src, and TWO profiles`);
  }
  return {
    app: raw.app ?? ".",
    src: raw.src ?? "src",
    build: raw.build,
    env_prefix: raw.env_prefix ?? "VITE_",
    markers: raw.markers && raw.markers.length > 0 ? raw.markers : ["data-review-node"],
    baseline: raw.baseline ?? ".slowcook/parity-baseline.yaml",
    profiles: Object.fromEntries(
      Object.entries(raw.profiles).map(([k, v]) => [k, { env: v?.env ?? {}, require_all_flags: v?.require_all_flags, allow_unset: v?.allow_unset ?? [], forbid: v?.forbid ?? [] }]),
    ),
  };
}

export function loadBaseline(root: string, path = ".slowcook/parity-baseline.yaml"): BaselineEntry[] {
  const abs = join(root, path);
  if (!existsSync(abs)) return [];
  const raw = parseYaml(readFileSync(abs, "utf8")) as { divergences?: BaselineEntry[] } | null;
  return raw?.divergences ?? [];
}

export function runSurfaceParityCheck(
  root: string,
  config: ParityConfig,
  baseline: BaselineEntry[],
  opts: { build?: (profile: string, env: Record<string, string>, outDir: string) => void } = {},
): ParityResult {
  const flags = scanFlagReads(root, config.src, config.env_prefix);
  const nodeIds = scanNodeIds(root, config.src, config.markers);

  // 1. flag completeness
  const flagViolations: FlagViolation[] = [];
  for (const [name, profile] of Object.entries(config.profiles)) {
    if (!profile.require_all_flags) continue;
    for (const [flag, readAt] of flags) {
      if (!(flag in profile.env) && !profile.allow_unset!.includes(flag)) {
        flagViolations.push({ flag, profile: name, readAt });
      }
    }
  }

  // 2. build each profile, probe node-literal survival + forbidden markers
  const presence = new Map<string, Record<string, boolean>>();
  const forbidViolations: ForbidViolation[] = [];
  const tmp = mkdtempSync(join(tmpdir(), "sc-parity-"));
  const profilesBuilt: string[] = [];
  try {
    for (const [name, profile] of Object.entries(config.profiles)) {
      const outDir = join(tmp, name);
      mkdirSync(outDir, { recursive: true });
      if (opts.build) {
        opts.build(name, profile.env, outDir);
      } else {
        const cmd = config.build.replace(/\{outDir\}/g, outDir);
        // start from the caller's env MINUS any prefixed flags: a profile's
        // absent flag must be truly absent, not inherited from the shell.
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (v !== undefined && !k.startsWith(config.env_prefix)) env[k] = v;
        }
        Object.assign(env, profile.env);
        execSync(cmd, { cwd: join(root, config.app), env, stdio: "pipe" });
      }
      profilesBuilt.push(name);
      const text = bundleText(outDir);
      for (const marker of profile.forbid ?? []) {
        if (text.includes(marker)) forbidViolations.push({ marker, profile: name });
      }
      for (const id of nodeIds) {
        const rec = presence.get(id) ?? {};
        rec[name] = text.includes(id);
        presence.set(id, rec);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // 3. classify
  const profileNames = Object.keys(config.profiles);
  const drift: NodeDrift[] = [];
  const deadNodes: string[] = [];
  for (const [id, rec] of presence) {
    const present = profileNames.filter((p) => rec[p]);
    if (present.length === profileNames.length) continue;
    if (present.length === 0) { deadNodes.push(id); continue; }
    drift.push({ node: id, absent_from: profileNames.filter((p) => !rec[p]).sort(), presentIn: present.sort() });
  }

  const byNode = new Map(baseline.map((b) => [b.node, b]));
  const newDrift: NodeDrift[] = [];
  const waivedDrift: NodeDrift[] = [];
  for (const d of drift) {
    const b = byNode.get(d.node);
    // a baseline entry waives EXACTLY the recorded shape; drift that moved
    // (absent from a different profile set) is NEW — that's the conflict case.
    if (b && sameSet(b.absent_from, d.absent_from)) waivedDrift.push(d);
    else newDrift.push(d);
  }
  const drifted = new Set(drift.map((d) => d.node));
  const healed = baseline.filter((b) => !drifted.has(b.node));

  return {
    flagViolations, forbidViolations, newDrift, waivedDrift, healed, deadNodes,
    nodesChecked: nodeIds.size, flagsChecked: flags.size, profilesBuilt,
  };
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort(), sb = [...b].sort();
  return sa.every((x, i) => x === sb[i]);
}

export function writeBaseline(root: string, drift: NodeDrift[], prior: BaselineEntry[], path = ".slowcook/parity-baseline.yaml"): void {
  const byNode = new Map(prior.map((b) => [b.node, b]));
  const divergences: BaselineEntry[] = drift.map((d) => {
    const existing = byNode.get(d.node);
    return {
      node: d.node,
      absent_from: d.absent_from,
      reason: existing?.reason ?? "TODO: why is this divergence deliberate?",
      ...(existing?.owner ? { owner: existing.owner } : {}),
      ...(existing?.direction ? { direction: existing.direction } : {}),
    };
  });
  const abs = join(root, path);
  mkdirSync(join(root, ".slowcook"), { recursive: true });
  writeFileSync(abs, stringifyYaml({
    "#": "surface-parity baseline — every entry is a DELIBERATE mock/prod divergence with a reason. New unwaived drift fails CI (the ratchet).",
    divergences,
  }), "utf8");
}

export function runSurfaceParityCli(argv: string[]): void {
  const cwdIdx = argv.indexOf("--cwd");
  const root = cwdIdx >= 0 ? argv[cwdIdx + 1]! : process.cwd();
  const cfgIdx = argv.indexOf("--config");
  const configPath = cfgIdx >= 0 ? argv[cfgIdx + 1]! : ".slowcook/parity.yaml";
  const update = argv.includes("--update-baseline");

  let config: ParityConfig;
  try { config = loadConfig(root, configPath); } catch (e) {
    console.error(`✗ surface-parity: ${(e as Error).message}`);
    process.exit(2);
  }
  const baseline = loadBaseline(root, config.baseline);
  let result: ParityResult;
  try { result = runSurfaceParityCheck(root, config, baseline); } catch (e) {
    console.error(`✗ surface-parity: build failed — ${(e as Error).message.slice(0, 400)}`);
    process.exit(2);
  }

  const { flagViolations, forbidViolations, newDrift, waivedDrift, healed, deadNodes } = result;
  console.log(`surface-parity: ${result.nodesChecked} nodes · ${result.flagsChecked} flags · profiles: ${result.profilesBuilt.join(", ")}`);

  for (const v of flagViolations) {
    console.error(`  ✗ flag ${v.flag} is read (${v.readAt}) but UNDECLARED in profile '${v.profile}' — its live branch would be silently dropped. Declare it (value may be "") or list it under allow_unset.`);
  }
  for (const v of forbidViolations) {
    console.error(`  ✗ FORBIDDEN marker ${JSON.stringify(v.marker)} survives into profile '${v.profile}' — this profile must be SEVERED from it at build time, not runtime-bypassed.`);
  }
  for (const d of newDrift) {
    console.error(`  ✗ node '${d.node}' is absent from [${d.absent_from.join(", ")}] but present in [${d.presentIn.join(", ")}] — NEW drift. Fix the missing branch, or record it in .slowcook/parity-baseline.yaml with a reason (--update-baseline scaffolds it).`);
  }
  for (const d of waivedDrift) {
    console.log(`  · waived: '${d.node}' absent from [${d.absent_from.join(", ")}] (baselined)`);
  }
  for (const b of healed) {
    console.log(`  ✚ healed: '${b.node}' no longer diverges — prune it from the baseline.`);
  }
  if (deadNodes.length > 0) {
    console.log(`  ⚠ ${deadNodes.length} node id(s) absent from EVERY profile (dead code?): ${deadNodes.slice(0, 5).join(", ")}${deadNodes.length > 5 ? ", …" : ""}`);
  }

  if (update) {
    writeBaseline(root, [...newDrift, ...waivedDrift], baseline, config.baseline);
    console.log(`  baseline updated (${newDrift.length + waivedDrift.length} divergence(s)) — fill in the TODO reasons before committing.`);
    return;
  }
  if (flagViolations.length > 0 || forbidViolations.length > 0 || newDrift.length > 0) process.exit(1);
  console.log(`✓ surface-parity: no new drift (${waivedDrift.length} waived, ${healed.length} healed)`);
}
