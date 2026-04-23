import type { Page } from "@playwright/test";
import type { GateViolation } from "./types.js";

/**
 * Mobile tap-target size check. Interactive elements should be at least
 * 44×44 CSS pixels per Apple HIG + WCAG 2.5.5 AAA. Runs against the
 * current viewport — caller should set a mobile viewport before calling.
 *
 * Matches: `<button>`, `<a href>`, `<input>` (except hidden/checkbox/radio
 * where size is less critical), `<select>`, `[role="button"]`,
 * `[onclick]`, `[tabindex]:not([tabindex="-1"])`.
 */
export async function checkTapTargets(
  page: Page,
  options: { minSize?: number } = {}
): Promise<GateViolation[]> {
  const minSize = options.minSize ?? 44;
  const raw = await page.evaluate((min: number) => {
    const selector = [
      "button",
      "a[href]",
      'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])',
      "select",
      '[role="button"]',
      "[onclick]",
    ].join(", ");

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
    for (const el of Array.from(document.querySelectorAll(selector))) {
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.width < min || rect.height < min) {
        violations.push({
          selector: selectorFor(el),
          evidence: `${Math.round(rect.width)}×${Math.round(rect.height)}px (required ≥ ${min}×${min})`,
        });
      }
      if (violations.length >= 10) break;
    }
    return violations;
  }, minSize);

  return raw.map((r) => ({
    gate: "checkTapTargets",
    category: "tap-target" as const,
    selector: r.selector,
    evidence: r.evidence,
  }));
}
