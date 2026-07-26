/**
 * Brand presence (storyteller P4) — the inverted fidelity ceiling,
 * generalized: a MOCK must wear its design system from the first page.
 * Domain-agnostic signals only:
 *  - the document defines design tokens (CSS custom properties on :root)
 *  - visible elements actually CONSUME tokens (var() in computed sources
 *    is invisible post-computation, so we sample: root tokens exist AND
 *    the body font is deliberately set (not the UA serif default) AND the
 *    page is not all-default-black-on-white)
 */
import type { GateViolation } from "./types.js";

export interface BrandFacts {
  tokenCount: number;
  bodyFont: string;
  distinctColors: number;
}

export function classifyBrand(f: BrandFacts): GateViolation[] {
  const out: GateViolation[] = [];
  if (f.tokenCount < 3) {
    out.push({ gate: "brand-presence", selector: ":root", evidence: `${f.tokenCount} design token(s) defined — the design system is not loaded`, category: "visual" });
  }
  const firstFont = f.bodyFont.trim().split(",")[0]?.replace(/["']/g, "").trim() ?? "";
  if (firstFont === "" || /^(serif|times)/i.test(firstFont)) {
    out.push({ gate: "brand-presence", selector: "body", evidence: `body font is the UA default ("${f.bodyFont.slice(0, 50)}") — no typographic voice`, category: "visual" });
  }
  if (f.distinctColors < 3) {
    out.push({ gate: "brand-presence", selector: "body", evidence: `only ${f.distinctColors} distinct colors on the page — reads unstyled`, category: "visual" });
  }
  return out;
}

export async function checkBrandPresence(page: { evaluate<T>(expression: string): Promise<T> }): Promise<GateViolation[]> {
  const facts = await page.evaluate<BrandFacts>(`(() => {
    let tokenCount = 0;
    for (const sheet of Array.from(document.styleSheets)) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of Array.from(rules || [])) {
        if (rule.selectorText === ':root' || (rule.selectorText || '').includes(':root')) {
          for (const prop of Array.from(rule.style || [])) if (prop.startsWith('--')) tokenCount++;
        }
      }
    }
    const rootStyle = getComputedStyle(document.documentElement);
    // runtime-injected tokens (CSS-in-JS) — sample known-common names is
    // domain-coupled; instead count custom props visible on :root inline
    for (const prop of Array.from(document.documentElement.style)) if (prop.startsWith('--')) tokenCount++;
    const colors = new Set();
    for (const el of Array.from(document.querySelectorAll('body *')).slice(0, 400)) {
      const cs = getComputedStyle(el);
      colors.add(cs.color); colors.add(cs.backgroundColor);
    }
    colors.delete('rgba(0, 0, 0, 0)');
    return { tokenCount, bodyFont: getComputedStyle(document.body).fontFamily, distinctColors: colors.size };
  })()`);
  return classifyBrand(facts);
}
