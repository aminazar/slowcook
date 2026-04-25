import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * 0.13.3 (brownfield-extraction track for 0.14 mockup-first refinement) —
 * walk `**\/*.css` files (excluding build output) and extract design tokens
 * declared via `:root { --var: value }` and `@theme { --var: value }` blocks.
 *
 * Supports the Tailwind v4 idiom (inline `@theme`) and classic CSS-vars
 * theming. Light/dark variants captured separately when `:root` lives
 * inside `@media (prefers-color-scheme: dark)`.
 *
 * Output: `.brewing/diagrams/tokens.md` — refine reads this so its
 * mockup proposals reuse the consumer's existing palette / scale rather
 * than inventing arbitrary hex values.
 */

export interface TokenEntry {
  name: string;
  value: string;
  variant: "light" | "dark";
  source: string;
}

export interface TokenCatalog {
  light: TokenEntry[];
  dark: TokenEntry[];
  themeMappings: TokenEntry[];
  filesScanned: number;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".open-next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".vercel",
  ".git",
  "coverage",
  ".brewing",
  ".claude",
]);

function walkCss(root: string, acc: string[] = [], cur: string = root): string[] {
  let entries: string[];
  try {
    entries = readdirSync(cur);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(cur, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkCss(root, acc, full);
    } else if (name.endsWith(".css")) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Parse a CSS file's :root and @theme blocks into TokenEntry rows.
 *
 * Strategy: walk top-level by tracking brace depth + remembering the
 * last selector / at-rule prefix. We need only enough to distinguish:
 *   - `:root { ... }` at depth 0 → light variant
 *   - `:root { ... }` inside `@media (prefers-color-scheme: dark)` → dark
 *   - `@theme { ... }` → theme mappings (Tailwind v4)
 *
 * We are not building a full CSS AST; the regex+brace pass is enough
 * for the conventional vars-in-:root pattern and degrades gracefully
 * on weird input by emitting fewer rows.
 */
export function parseCssTokens(
  content: string,
  sourceLabel: string
): { light: TokenEntry[]; dark: TokenEntry[]; themeMappings: TokenEntry[] } {
  const light: TokenEntry[] = [];
  const dark: TokenEntry[] = [];
  const themeMappings: TokenEntry[] = [];

  let i = 0;
  const len = content.length;
  // Track if we're inside a dark-mode @media block so nested :root captures
  // are routed to dark[].
  let mediaDarkDepth = 0;

  while (i < len) {
    // Skip whitespace + comments.
    while (i < len && /\s/.test(content[i]!)) i++;
    if (i + 1 < len && content[i] === "/" && content[i + 1] === "*") {
      const end = content.indexOf("*/", i + 2);
      if (end < 0) break;
      i = end + 2;
      continue;
    }

    // Handle bodyless at-rules (`@import "x";`, `@charset "y";`, `@use ...`)
    // that would otherwise get glued onto the next selector head.
    if (content[i] === "@") {
      const semi = content.indexOf(";", i);
      const braceLook = content.indexOf("{", i);
      if (semi >= 0 && (braceLook < 0 || semi < braceLook)) {
        i = semi + 1;
        continue;
      }
    }
    // Find next selector / at-rule up to `{`.
    const braceOpen = content.indexOf("{", i);
    if (braceOpen < 0) break;
    let head = content.slice(i, braceOpen).trim();
    // Defense in depth: if any bodyless at-rule still slipped into head
    // (e.g. `@import "x"; :root`), keep only the trailing selector after
    // the last `;`.
    const lastSemi = head.lastIndexOf(";");
    if (lastSemi >= 0) head = head.slice(lastSemi + 1).trim();
    const body = readBlock(content, braceOpen + 1);
    if (body == null) break;

    if (/^@media\b/.test(head) && /prefers-color-scheme\s*:\s*dark/.test(head)) {
      // Recurse into the media block's body so nested :root → dark.
      const inner = parseCssTokens(body.text, sourceLabel);
      // Inner light entries (i.e. :root inside the dark @media) become dark.
      // Inner dark entries (nested @media — unusual) collapse into dark too.
      dark.push(
        ...inner.light.map((e) => ({ ...e, variant: "dark" as const })),
        ...inner.dark
      );
      themeMappings.push(...inner.themeMappings);
    } else if (/^@theme\b/.test(head)) {
      for (const v of parseVars(body.text)) {
        themeMappings.push({ ...v, variant: "light", source: sourceLabel });
      }
    } else if (head === ":root" || /(^|,)\s*:root\s*($|,)/.test(head)) {
      const target = mediaDarkDepth > 0 ? dark : light;
      const variant: "light" | "dark" = mediaDarkDepth > 0 ? "dark" : "light";
      for (const v of parseVars(body.text)) {
        target.push({ ...v, variant, source: sourceLabel });
      }
    }
    // Other selectors (`body`, `.foo`) are ignored — we only want declared tokens.

    i = body.end;
  }

  return { light, dark, themeMappings };
}

/** Read a block starting after the opening `{`, returns text + index after closing `}`. */
function readBlock(s: string, start: number): { text: string; end: number } | null {
  let depth = 1;
  let i = start;
  while (i < s.length && depth > 0) {
    const ch = s[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { text: s.slice(start, i), end: i + 1 };
    } else if (ch === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      if (end < 0) return null;
      i = end + 2;
      continue;
    }
    i++;
  }
  return null;
}

/** Extract `--name: value;` declarations from a block body. */
function parseVars(body: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  // Strip block comments first.
  const stripped = body.replace(/\/\*[\s\S]*?\*\//g, "");
  // Match `--name: value;` (value may contain colons/parens, so non-greedy
  // up to the next semicolon at depth 0). Simple approach: split on `;`
  // and check each piece.
  for (const raw of stripped.split(";")) {
    const piece = raw.trim();
    if (!piece) continue;
    const m = piece.match(/^(--[A-Za-z0-9_-]+)\s*:\s*([\s\S]+)$/);
    if (!m) continue;
    out.push({ name: m[1]!, value: m[2]!.trim() });
  }
  return out;
}

const COLOR_VALUE_RE = /^(#|rgb\(|rgba\(|hsl\(|hsla\(|color\(|oklch\(|oklab\()/i;
const NAMED_COLORS = new Set([
  "transparent",
  "currentcolor",
  "black",
  "white",
  "red",
  "green",
  "blue",
  "yellow",
  "orange",
  "purple",
  "pink",
  "gray",
  "grey",
  "brown",
]);

function isColorValue(v: string, allTokens: Map<string, string>): boolean {
  const trimmed = v.trim();
  if (COLOR_VALUE_RE.test(trimmed)) return true;
  if (NAMED_COLORS.has(trimmed.toLowerCase())) return true;
  const varRef = trimmed.match(/^var\((--[A-Za-z0-9_-]+)\)$/);
  if (varRef) {
    const target = allTokens.get(varRef[1]!);
    if (target) return isColorValue(target, allTokens);
  }
  return false;
}

function classify(name: string, value: string, allTokens: Map<string, string>): string {
  const n = name.toLowerCase();
  if (
    n.includes("color") ||
    n.includes("bg") ||
    n.includes("background") ||
    n.includes("foreground") ||
    n.includes("border") ||
    n.includes("tint") ||
    n.includes("shadow") ||
    isColorValue(value, allTokens)
  ) {
    return "color";
  }
  if (n.startsWith("--font") || n.includes("font") || n.includes("text-")) return "typography";
  if (
    n.includes("space") ||
    n.includes("spacing") ||
    n.includes("gap") ||
    n.includes("size") ||
    n.includes("radius")
  ) {
    return "spacing";
  }
  return "other";
}

export function emitTokensCatalog(repoRoot: string): {
  written: boolean;
  filesScanned: number;
  lightCount?: number;
  darkCount?: number;
  themeCount?: number;
  skippedReason?: string;
} {
  const cssFiles = walkCss(repoRoot);
  if (cssFiles.length === 0) {
    return { written: false, filesScanned: 0, skippedReason: "no .css files found" };
  }

  const catalog: TokenCatalog = {
    light: [],
    dark: [],
    themeMappings: [],
    filesScanned: cssFiles.length,
  };

  for (const file of cssFiles) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = relative(repoRoot, file);
    const parsed = parseCssTokens(content, rel);
    catalog.light.push(...parsed.light);
    catalog.dark.push(...parsed.dark);
    catalog.themeMappings.push(...parsed.themeMappings);
  }

  if (
    catalog.light.length === 0 &&
    catalog.dark.length === 0 &&
    catalog.themeMappings.length === 0
  ) {
    return {
      written: false,
      filesScanned: cssFiles.length,
      skippedReason: `scanned ${cssFiles.length} .css file(s), found no :root or @theme tokens`,
    };
  }

  const md = renderTokensMarkdown(catalog);
  const outDir = join(repoRoot, ".brewing/diagrams");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "tokens.md");
  writeFileSync(outPath, md, "utf8");

  return {
    written: true,
    filesScanned: cssFiles.length,
    lightCount: catalog.light.length,
    darkCount: catalog.dark.length,
    themeCount: catalog.themeMappings.length,
  };
}

export function renderTokensMarkdown(catalog: TokenCatalog): string {
  const allTokens = new Map<string, string>();
  for (const e of [...catalog.light, ...catalog.dark, ...catalog.themeMappings]) {
    if (!allTokens.has(e.name)) allTokens.set(e.name, e.value);
  }

  const out: string[] = [];
  out.push(
    "<!-- Auto-emitted by `slowcook map --emit-tokens`. Do not hand-edit; regenerate. -->"
  );
  out.push(
    `<!-- Source: ${catalog.filesScanned} .css file(s); ${catalog.light.length} light, ${catalog.dark.length} dark, ${catalog.themeMappings.length} @theme mapping(s). -->`
  );
  out.push("");
  out.push("# Design tokens (extracted)");
  out.push("");
  out.push(
    "Brownfield extraction of `:root { --var }` + `@theme { --var }` declarations."
  );
  out.push("");

  const groups: Array<["light" | "dark" | "theme", TokenEntry[], string]> = [
    ["light", catalog.light, "Light variant (`:root`)"],
    ["dark", catalog.dark, "Dark variant (`@media (prefers-color-scheme: dark)`)"],
    ["theme", catalog.themeMappings, "Theme mappings (`@theme` — Tailwind v4)"],
  ];

  for (const [, entries, heading] of groups) {
    if (entries.length === 0) continue;
    out.push(`## ${heading}`);
    out.push("");

    const buckets = { color: [] as TokenEntry[], typography: [] as TokenEntry[], spacing: [] as TokenEntry[], other: [] as TokenEntry[] };
    for (const e of entries) {
      const k = classify(e.name, e.value, allTokens) as keyof typeof buckets;
      buckets[k].push(e);
    }
    for (const [bucketName, bucketEntries] of Object.entries(buckets)) {
      if (bucketEntries.length === 0) continue;
      out.push(`### ${bucketName} (${bucketEntries.length})`);
      out.push("");
      out.push("| Token | Value | Source |");
      out.push("| --- | --- | --- |");
      for (const e of bucketEntries) {
        const value = e.value.replace(/\|/g, "\\|");
        out.push(`| \`${e.name}\` | \`${value}\` | \`${e.source}\` |`);
      }
      out.push("");
    }
  }
  return out.join("\n") + "\n";
}
