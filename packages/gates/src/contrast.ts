import type { Page } from "@playwright/test";
import type { GateViolation } from "./types.js";

/**
 * WCAG 2.1 AA contrast check. Runs in-browser via `page.evaluate` so it
 * uses the real computed styles after CSS vars, user-agent stylesheets,
 * and any runtime theme flips have applied. Calls a minimal contrast
 * algorithm inline — no axe dependency.
 *
 * Thresholds:
 *  - Normal text: 4.5 : 1
 *  - Large text (≥18pt regular or ≥14pt bold): 3.0 : 1
 *
 * Reports the first ~10 violations to keep the output scannable.
 */
export async function checkContrast(page: Page): Promise<GateViolation[]> {
  const raw = await page.evaluate(() => {
    const parseRgb = (s: string): [number, number, number, number] | null => {
      const m = s.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const parts = m[1]!.split(",").map((x) => parseFloat(x.trim()));
      const r = parts[0] ?? 0;
      const g = parts[1] ?? 0;
      const b = parts[2] ?? 0;
      const a = parts[3] ?? 1;
      return [r, g, b, a];
    };

    const relLum = (c: number) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };

    const contrast = (fg: [number, number, number], bg: [number, number, number]) => {
      const L1 = 0.2126 * relLum(fg[0]) + 0.7152 * relLum(fg[1]) + 0.0722 * relLum(fg[2]);
      const L2 = 0.2126 * relLum(bg[0]) + 0.7152 * relLum(bg[1]) + 0.0722 * relLum(bg[2]);
      const [lighter, darker] = L1 > L2 ? [L1, L2] : [L2, L1];
      return (lighter + 0.05) / (darker + 0.05);
    };

    const resolveBg = (el: Element): [number, number, number] | null => {
      let cur: Element | null = el;
      while (cur) {
        const bg = parseRgb(getComputedStyle(cur).backgroundColor);
        if (bg && bg[3] > 0) return [bg[0], bg[1], bg[2]];
        cur = cur.parentElement;
      }
      // Fallback to document bg
      const docBg = parseRgb(getComputedStyle(document.body).backgroundColor);
      return docBg ? [docBg[0], docBg[1], docBg[2]] : [255, 255, 255];
    };

    const selectorFor = (el: Element): string => {
      const id = (el as HTMLElement).id;
      if (id) return `#${id}`;
      const cls = (el as HTMLElement).className;
      if (typeof cls === "string" && cls) {
        return `${el.tagName.toLowerCase()}.${cls.split(/\s+/).filter(Boolean).slice(0, 2).join(".")}`;
      }
      return el.tagName.toLowerCase();
    };

    const violations: { selector: string; evidence: string }[] = [];

    const walk = (root: Element): void => {
      const stack: Element[] = [root];
      while (stack.length && violations.length < 10) {
        const el = stack.pop()!;
        for (const child of Array.from(el.children)) stack.push(child);
        if (!el.textContent || !el.textContent.trim()) continue;
        // Skip elements whose text is entirely in descendants
        const ownText = Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => (n.textContent ?? "").trim())
          .join("");
        if (!ownText) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) < 0.1)
          continue;
        const fg = parseRgb(cs.color);
        if (!fg) continue;
        const bg = resolveBg(el);
        if (!bg) continue;
        const ratio = contrast([fg[0], fg[1], fg[2]], bg);
        const fontSizePx = parseFloat(cs.fontSize);
        const fontWeight = parseInt(cs.fontWeight, 10) || 400;
        const isLarge =
          fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
        const threshold = isLarge ? 3.0 : 4.5;
        if (ratio < threshold) {
          violations.push({
            selector: selectorFor(el),
            evidence: `contrast ${ratio.toFixed(2)}:1 (required ${threshold}:1)`,
          });
        }
      }
    };

    walk(document.body);
    return violations;
  });

  return raw.map((r) => ({
    gate: "checkContrast",
    category: "contrast" as const,
    selector: r.selector,
    evidence: r.evidence,
  }));
}
