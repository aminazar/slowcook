/**
 * `slowcook check style-drift` — the inline-style ratchet (2026-07-08).
 *
 * The dash post-mortem: a real design system (Tailwind @theme + `.sc-*`
 * component classes) shipped and then 1,937 inline `style={{…}}` blocks grew
 * around it — because the mock's first pages set an inline idiom, every
 * subsequent page (agent- or human-written) matched the surrounding code, and
 * nothing deterministic pushed back. Changing a token stayed cheap (styles
 * reference CSS vars) but changing a COMPONENT (what a card/button/chip is)
 * became a mass edit.
 *
 * The contract this check enforces:
 *   - tokens (color/font/radius/shadow/spacing scale) come from CSS vars;
 *   - recurring patterns come from the design system's classes;
 *   - inline `style` is legal ONLY for one-off geometry (flex/grid math,
 *     sizes, positions) — never for skin.
 *
 * Deterministic ratchet:
 *   - a style block is DRIFT when it contains ≥1 SKIN prop (color, background,
 *     border*, font*, boxShadow, borderRadius, …). Geometry-only blocks are
 *     free.
 *   - per-file drift counts live in a committed baseline
 *     (`.slowcook/style-drift-baseline.json`). Counts may only go DOWN:
 *     any file above its baseline fails; files at/below refresh automatically
 *     with `--write` (which is also how migration progress is recorded).
 *   - new files start at baseline 0 — new code must use classes from day one.
 *
 * Usage:
 *   slowcook check style-drift            # verify against the baseline
 *   slowcook check style-drift --write    # (re)write the baseline
 * Config (optional, `.slowcook/style-drift.yaml`):
 *   src: mock/src          # scan root (default: src, then mock/src fallback)
 *   baseline: .slowcook/style-drift-baseline.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";

function walkTsx(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkTsx(p, out);
    else if (/\.(tsx|jsx)$/.test(e) && !/\.test\./.test(e)) out.push(p);
  }
  return out;
}

/** props that may appear inline — layout geometry, not skin. */
const GEOMETRY = new Set([
  "display", "position", "top", "right", "bottom", "left", "inset", "zIndex",
  "width", "height", "minWidth", "minHeight", "maxWidth", "maxHeight",
  "margin", "marginTop", "marginRight", "marginBottom", "marginLeft",
  "padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "flex", "flexDirection", "flexWrap", "flexShrink", "flexGrow", "flexBasis",
  "alignItems", "alignSelf", "alignContent", "justifyContent", "justifySelf", "justifyItems",
  "gap", "rowGap", "columnGap", "grid", "gridTemplateColumns", "gridTemplateRows",
  "gridColumn", "gridRow", "gridArea", "placeItems", "placeContent",
  "overflow", "overflowX", "overflowY", "textAlign", "verticalAlign",
  "transform", "transformOrigin", "pointerEvents", "cursor", "userSelect",
  "visibility", "opacity", "order", "aspectRatio", "objectFit", "whiteSpace",
  "textOverflow", "wordBreak", "overflowWrap", "lineClamp", "WebkitLineClamp",
  "WebkitBoxOrient", "float", "clear", "resize", "appearance", "outline",
]);

export interface StyleDriftReport {
  counts: Record<string, number>;
  failures: { file: string; count: number; baseline: number; sampleProps: string[] }[];
  totalDrift: number;
}

/** extract the top-level keys of every `style={{ … }}` object in a source. */
export function driftBlocks(source: string): { keys: string[] }[] {
  const out: { keys: string[] }[] = [];
  const re = /style=\{\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    // walk to the matching `}}` of the object literal
    let depth = 1; // inside the object brace (the second `{`)
    let i = m.index + m[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === '"' || ch === "'" || ch === "`") {
        const q = ch; i++;
        while (i < source.length && source[i] !== q) { if (source[i] === "\\") i++; i++; }
      }
      i++;
    }
    const body = source.slice(start, i - 1);
    // top-level keys: strip nested braces/parens first (template exprs, sub-objects)
    let flat = "", d = 0;
    for (let j = 0; j < body.length; j++) {
      const ch = body[j];
      if (ch === "{" || ch === "(") d++;
      else if (ch === "}" || ch === ")") d--;
      else if (d === 0) flat += ch;
    }
    const keys = [...flat.matchAll(/(?:^|,)\s*(?:\.\.\.[a-zA-Z_$][\w$.]*|(["']?)([a-zA-Z_$][\w$-]*)\1\s*:)/g)]
      .map((k) => k[2]).filter((k): k is string => !!k);
    out.push({ keys });
  }
  return out;
}

export function isDrift(keys: string[]): boolean {
  // spread-only or geometry-only blocks are fine; any skin prop = drift.
  const named = keys.filter((k) => !k.startsWith("..."));
  return named.some((k) => !GEOMETRY.has(k));
}

export function scanStyleDrift(root: string, srcDir: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const files = walkTsx(join(root, srcDir));
  for (const full of files.sort()) {
    const src = readFileSync(full, "utf8");
    const n = driftBlocks(src).filter((b) => isDrift(b.keys)).length;
    if (n > 0) counts[relative(root, full)] = n;
  }
  return counts;
}

export async function runStyleDriftCli(argv: string[]): Promise<void> {
  const write = argv.includes("--write");
  const root = process.cwd();
  // config: explicit yaml > src/ > mock/src fallback
  let srcDir = "src";
  let baselinePath = ".slowcook/style-drift-baseline.json";
  const cfgPath = join(root, ".slowcook/style-drift.yaml");
  if (existsSync(cfgPath)) {
    const cfg = readFileSync(cfgPath, "utf8");
    srcDir = /^\s*src:\s*(\S+)/m.exec(cfg)?.[1] ?? srcDir;
    baselinePath = /^\s*baseline:\s*(\S+)/m.exec(cfg)?.[1] ?? baselinePath;
  } else if (!existsSync(join(root, srcDir)) && existsSync(join(root, "mock/src"))) {
    srcDir = "mock/src";
  }

  const counts = scanStyleDrift(root, srcDir);
  const total = Object.values(counts).reduce((s, n) => s + n, 0);

  if (write) {
    mkdirSync(join(root, dirname(baselinePath)), { recursive: true });
    writeFileSync(join(root, baselinePath), JSON.stringify(counts, null, 2) + "\n");
    console.log(`✓ style-drift baseline written: ${Object.keys(counts).length} files, ${total} skin-styled inline blocks (${baselinePath})`);
    return;
  }

  const baseline: Record<string, number> = existsSync(join(root, baselinePath))
    ? JSON.parse(readFileSync(join(root, baselinePath), "utf8")) as Record<string, number>
    : {};

  const failures: { file: string; count: number; baseline: number }[] = [];
  for (const [file, n] of Object.entries(counts)) {
    const base = baseline[file] ?? 0; // new files start at ZERO
    if (n > base) failures.push({ file, count: n, baseline: base });
  }
  const healed = Object.entries(baseline).filter(([f, b]) => (counts[f] ?? 0) < b);

  if (failures.length > 0) {
    console.error(`✗ style-drift: inline SKIN styles increased in ${failures.length} file(s) — skin comes from the design system's classes; inline style is for geometry only.`);
    for (const f of failures.slice(0, 20)) console.error(`  ${f.file}: ${f.count} (baseline ${f.baseline})`);
    console.error(`  Fix: use .sc-*/utility classes (tokens via CSS vars). If a file was legitimately migrated+edited, re-run with --write AFTER review.`);
    process.exit(1);
  }
  if (healed.length > 0) {
    console.log(`✓ style-drift: no increases. ${healed.length} file(s) improved vs baseline — run --write to ratchet down.`);
  } else {
    console.log(`✓ style-drift: no increases (${Object.keys(counts).length} files, ${total} baseline skin blocks).`);
  }
}
