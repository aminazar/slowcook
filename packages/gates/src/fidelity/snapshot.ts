import type { Page } from "@playwright/test";

/**
 * Fidelity snapshots — the input to the visual/behavioural mock-vs-prod
 * diff (design #8). A snapshot is a structural record of a single render:
 * one entry per matched element, capturing the computed-style properties
 * and box we grade. Two snapshots (reference = `references.visual` render,
 * candidate = brew output) are compared by `diffSnapshots` (./diff.ts).
 *
 * The capture (`captureSnapshot`) is an impure Playwright wrapper; the
 * diff is pure + unit-tested. Same split as serve's
 * resolveCommand/runCommands.
 */

/** Which render a snapshot is — viewport, scheme, and optional event step. */
export interface SnapshotContext {
  /** "mobile" | "desktop", or any named viewport the matrix defines. */
  viewport: string;
  /** Color scheme the page was rendered under. */
  scheme: "light" | "dark";
  /**
   * design §6 — locale/direction the page was rendered under (e.g. "fa"/"en").
   * Absent on single-locale runs; present so the report distinguishes the
   * RTL/LTR cells of the viewport×scheme×locale matrix.
   */
  locale?: string;
  /**
   * Behavioural step label for stepped (event-sequence) captures, e.g.
   * "after:click [data-testid=submit]". Absent for static captures.
   */
  step?: string;
}

/** One matched element's graded properties within a render. */
export interface ElementSnapshot {
  /**
   * Stable selector pointer — prefers `#id` / `[data-testid]`, else
   * `tag.class:nth`. Used to match the same element across the reference
   * and candidate renders. A selector present in reference but absent in
   * candidate becomes a `missing` violation.
   */
  selector: string;
  /** Graded computed-style props, keyed by CSS property name → value. */
  styles: Record<string, string>;
  /** Bounding box in CSS px at the capture viewport. */
  box: { x: number; y: number; width: number; height: number };
}

export interface StyleSnapshot {
  context: SnapshotContext;
  /** One entry per matched element, in document order. */
  elements: ElementSnapshot[];
}

/**
 * Computed-style properties graded by default. Chosen for design-fidelity
 * signal: box model, color, typography, layout, and key visual props.
 * `getComputedStyle` normalises all of these (colors → `rgb(...)`, lengths
 * → `px`), so reference and candidate values compare as plain strings.
 */
export const FIDELITY_STYLE_PROPS: readonly string[] = [
  // box model
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "gap",
  // color
  "color", "background-color",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  // typography
  "font-size", "font-weight", "font-family", "line-height", "letter-spacing", "text-align",
  // layout
  "display", "flex-direction", "justify-content", "align-items", "position",
  // visual
  "border-radius", "opacity", "box-shadow",
];

/** Props whose violations are tagged with the `color` axis (vs `computed-style`). */
export const COLOR_PROPS: ReadonlySet<string> = new Set([
  "color", "background-color",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
]);

/**
 * Capture a `StyleSnapshot` from a live Playwright page. Walks the visible
 * DOM, builds a stable selector per element, and reads the graded computed
 * styles + box. Caller sets the viewport + scheme before calling and passes
 * the matching `context`.
 *
 * Not unit-tested (needs a real browser); the load-bearing logic lives in
 * the pure `diffSnapshots`. Integration coverage comes from the gate runner.
 */
export async function captureSnapshot(
  page: Page,
  context: SnapshotContext,
  options: { styleProps?: readonly string[] } = {}
): Promise<StyleSnapshot> {
  const styleProps = options.styleProps ?? FIDELITY_STYLE_PROPS;
  const elements = await page.evaluate((props: readonly string[]) => {
    const selectorFor = (el: Element): string => {
      const he = el as HTMLElement;
      if (he.id) return `#${he.id}`;
      const testid = he.getAttribute("data-testid");
      if (testid) return `[data-testid="${testid}"]`;
      const tag = el.tagName.toLowerCase();
      const cls =
        typeof he.className === "string" && he.className
          ? "." +
            he.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".")
          : "";
      const base = `${tag}${cls}`;
      // disambiguate among siblings matching the same base
      const parent = el.parentElement;
      if (!parent) return base;
      const sameBase = Array.from(parent.children).filter((sib) => {
        const se = sib as HTMLElement;
        const sc =
          typeof se.className === "string" && se.className
            ? "." +
              se.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".")
            : "";
        return `${sib.tagName.toLowerCase()}${sc}` === base;
      });
      if (sameBase.length <= 1) return base;
      return `${base}:nth-of-type(${sameBase.indexOf(el) + 1})`;
    };

    const out: {
      selector: string;
      styles: Record<string, string>;
      box: { x: number; y: number; width: number; height: number };
    }[] = [];
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const styles: Record<string, string> = {};
      for (const p of props) styles[p] = cs.getPropertyValue(p).trim();
      out.push({
        selector: selectorFor(el),
        styles,
        box: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
    }
    return out;
  }, styleProps as string[]);

  return { context, elements };
}
