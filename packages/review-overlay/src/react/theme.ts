// Shared, context-free theme primitives for the review widgets. Extracted from
// overlay.tsx so both the LCR mock-review overlay AND the generic ReviewWidget
// (PM/QA reuse) follow the host page's light/dark scheme identically.
import { useEffect, useState } from "react";

/** Detect whether the HOST PAGE is dark — by its theme attribute, else its bg
 *  luminance, else the OS preference. (Not the OS alone: the overlay must match
 *  the app it floats over, which may differ from the system scheme.) */
export function detectPageDark(): boolean {
  try {
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      const t = (el.getAttribute("data-theme") || el.getAttribute("data-color-scheme") || el.style.colorScheme || "").toLowerCase();
      if (t.includes("dark")) return true;
      if (t.includes("light")) return false;
    }
    for (const el of [document.body, document.documentElement]) {
      const bg = el && getComputedStyle(el).backgroundColor;
      const m = bg && bg.match(/[\d.]+/g);
      if (m && m.length >= 3 && (m.length < 4 || parseFloat(m[3]!) > 0.1)) {
        const r = Number(m[0]), g = Number(m[1]), b = Number(m[2]);
        return 0.299 * r + 0.587 * g + 0.114 * b < 128;
      }
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch { return true; }
}

/** React hook over detectPageDark — re-detects on OS change AND when the host app
 *  toggles its theme attribute/class. */
export function usePrefersDark(): boolean {
  const [dark, setDark] = useState<boolean>(() => { try { return detectPageDark(); } catch { return true; } });
  useEffect(() => {
    const update = (): void => setDark(detectPageDark());
    update();
    let mq: MediaQueryList | undefined;
    try { mq = window.matchMedia("(prefers-color-scheme: dark)"); mq.addEventListener("change", update); } catch { /* ignore */ }
    const mo = new MutationObserver(update);
    try {
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-color-scheme", "style", "class"] });
      if (document.body) mo.observe(document.body, { attributes: true, attributeFilter: ["data-theme", "data-color-scheme", "style", "class"] });
    } catch { /* ignore */ }
    return () => { try { mq?.removeEventListener("change", update); } catch { /* ignore */ } mo.disconnect(); };
  }, []);
  return dark;
}

export interface PillTheme { bg: string; border: string; fg: string; fgDim: string; sub: string; subBorder: string; shadow: string; ghBg: string; ghFg: string; }
export function pillTheme(dark: boolean): PillTheme {
  return dark
    ? { bg: "rgba(15,15,24,0.92)", border: "rgba(255,255,255,0.16)", fg: "white", fgDim: "rgba(255,255,255,0.55)", sub: "rgba(255,255,255,0.08)", subBorder: "rgba(255,255,255,0.15)", shadow: "0 4px 14px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06)", ghBg: "#ffffff", ghFg: "#24292f" }
    : { bg: "rgba(255,255,255,0.96)", border: "rgba(0,0,0,0.12)", fg: "#1a1a1a", fgDim: "rgba(0,0,0,0.5)", sub: "rgba(0,0,0,0.05)", subBorder: "rgba(0,0,0,0.12)", shadow: "0 4px 16px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.7)", ghBg: "#24292f", ghFg: "#ffffff" };
}

export interface SheetTheme { backdrop: string; sheet: string; fg: string; fgDim: string; header: string; input: string; inputBorder: string; border: string; rowActive: string; rowHover: string; }
export function sheetTheme(dark: boolean): SheetTheme {
  return dark
    ? { backdrop: "rgba(0,0,0,0.5)", sheet: "#1b1b22", fg: "#f3f3f7", fgDim: "#bdbdc8", header: "#8a8a96", input: "#26262f", inputBorder: "#3a3a46", border: "rgba(255,255,255,0.08)", rowActive: "rgba(59,175,160,0.22)", rowHover: "rgba(255,255,255,0.06)" }
    : { backdrop: "rgba(0,0,0,0.4)", sheet: "#ffffff", fg: "#111111", fgDim: "#999999", header: "#8a8a8a", input: "#ffffff", inputBorder: "#d0d7de", border: "#eeeeee", rowActive: "rgba(59,175,160,0.14)", rowHover: "#f3f4f6" };
}
