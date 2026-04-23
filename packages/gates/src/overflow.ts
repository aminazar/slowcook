import type { Page } from "@playwright/test";
import type { GateViolation } from "./types.js";

/**
 * Horizontal-overflow check. `document.scrollWidth > window.innerWidth`
 * means the page has horizontal scroll — usually a bug at mobile
 * viewports (something is wider than its container and broke the
 * layout).
 *
 * Report the widest offending elements (their rect.right > viewport).
 */
export async function checkNoOverflow(
  page: Page
): Promise<GateViolation[]> {
  const raw = await page.evaluate(() => {
    const viewportWidth = window.innerWidth;
    const scrollWidth = document.documentElement.scrollWidth;
    if (scrollWidth <= viewportWidth) return [];

    const selectorFor = (el: Element): string => {
      const id = (el as HTMLElement).id;
      if (id) return `#${id}`;
      const cls = (el as HTMLElement).className;
      if (typeof cls === "string" && cls) {
        return `${el.tagName.toLowerCase()}.${cls.split(/\s+/).filter(Boolean).slice(0, 2).join(".")}`;
      }
      return el.tagName.toLowerCase();
    };

    const offenders: { selector: string; evidence: string }[] = [
      {
        selector: "html",
        evidence: `document scrollWidth ${scrollWidth}px > viewport ${viewportWidth}px`,
      },
    ];
    // Name the three widest elements whose right edge exceeds viewport
    const widest = Array.from(document.querySelectorAll("*"))
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      .filter(({ rect }) => rect.right > viewportWidth && rect.width > 0)
      .sort((a, b) => b.rect.right - a.rect.right)
      .slice(0, 3);
    for (const { el, rect } of widest) {
      offenders.push({
        selector: selectorFor(el),
        evidence: `right ${Math.round(rect.right)}px (viewport ${viewportWidth}px)`,
      });
    }
    return offenders;
  });

  return raw.map((r) => ({
    gate: "checkNoOverflow",
    category: "overflow" as const,
    selector: r.selector,
    evidence: r.evidence,
  }));
}
