/**
 * GUCDI — brand logo tokenizer (pure). The genuinely useful, deterministic part
 * of the logo pipeline: take an SVG (passthrough, or PNG traced by potrace/
 * vtracer in the command shell — an LLM NEVER authors paths) and rewrite its
 * hardcoded colors to design-token CSS-var references so it recolors with the
 * brand and flips for dark/light automatically.
 *
 * Pure + unit-tested. The tracer shell-out + IO live in ./logo-cmd.ts.
 * See docs/plans/gucdi-greenfield.md Risk 4.
 */

/** Canonicalize a hex color to lowercase #rrggbb (expands #rgb). */
function norm(hex: string): string {
  let h = hex.replace("#", "").toLowerCase();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return `#${h}`;
}

function isColorLen(hex: string): boolean {
  const n = hex.replace("#", "").length;
  return n === 3 || n === 6;
}

/** Distinct colors (#rgb / #rrggbb), canonicalized, in document order. */
export function extractSvgColors(svg: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of svg.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    if (!isColorLen(m[0])) continue;
    const c = norm(m[0]);
    if (!seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

/**
 * Replace each hardcoded hex color with `var(--<token>)` per `colorMap` (hex →
 * token name, matched case-insensitively and #rgb/#rrggbb-equivalently). Colors
 * not in the map are left untouched (and reported by the caller for the PM to
 * map). Once tokenized, the same SVG flips dark/light via the CSS vars — no
 * separate variant file needed.
 */
export function tokenizeSvg(svg: string, colorMap: Record<string, string>): string {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(colorMap)) map.set(norm(k), v);
  return svg.replace(/#[0-9a-fA-F]{3,8}\b/g, (hex) => {
    if (!isColorLen(hex)) return hex;
    const tok = map.get(norm(hex));
    return tok ? `var(--${tok})` : hex;
  });
}

/** Colors still hardcoded after tokenizing — what the PM must add to the map. */
export function untokenizedColors(svg: string, colorMap: Record<string, string>): string[] {
  const mapped = new Set(Object.keys(colorMap).map(norm));
  return extractSvgColors(svg).filter((c) => !mapped.has(c));
}
