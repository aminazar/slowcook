// ATTACHED WINDOW — the pill's other slot.
//
// The pill already takes extra BUTTONS through `accessory`. This is the
// surface those buttons open: a panel that attaches to the pill itself —
// flush against its top edge when there is room above, its bottom edge when
// there is not, always sharing the pill's horizontal centre, always on
// screen, and following the pill as it is dragged.
//
// Two hard-won details live here so no host repeats them:
//   · the pill carries a CSS transform, and a transformed ancestor becomes
//     the containing block for position:fixed descendants — so a panel
//     rendered inside the pill measures against the PILL, not the viewport.
//     This portals to <body> to escape that.
//   · it stamps data-review-chrome, so the doctrine gates skip it and
//     comment mode never eats its clicks (it is tooling, not product).
//
// Hosts bring their own content and their own colours; the window brings
// the geometry, the surface, and the escape hatches (Escape / click-away).
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePrefersDark, sheetTheme } from "./theme.js";

export interface AttachedWindowProps {
  /** whether the window stands open */
  open: boolean;
  /** Escape and click-away call this; omit to make the window sticky */
  onClose?: () => void;
  /** the window's content — the host's own markup */
  children: ReactNode;
  /** width in px (clamped to the viewport). Default 300. */
  width?: number;
  /** an optional title row rendered above the content */
  title?: ReactNode;
  /** override the surface (default: the shell's sheet theme) */
  surface?: CSSProperties;
}

const Z = 2147483200;

export function AttachedWindow({ open, onClose, children, width = 300, title, surface }: AttachedWindowProps): ReactElement | null {
  const dark = usePrefersDark();
  const S = sheetTheme(dark);
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!open || typeof document === "undefined") { setAt(null); return; }
    const place = () => {
      const pill = document.querySelector("[data-review-pill]") as HTMLElement | null;
      const r = pill?.getBoundingClientRect();
      if (!r) return;
      const M = 6;
      const W = Math.min(width, window.innerWidth - M * 2);
      const H = ref.current?.offsetHeight ?? 240;
      const fitsAbove = r.top - H >= M;
      const top = fitsAbove ? r.top - H : Math.min(r.bottom, window.innerHeight - H - M);
      const left = Math.max(M, Math.min(r.left + r.width / 2 - W / 2, window.innerWidth - W - M));
      const next = { left: Math.round(left), top: Math.round(Math.max(M, top)) };
      setAt((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
    };
    let raf = 0;
    const loop = () => { place(); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, width]);

  useEffect(() => {
    if (!open || !onClose || typeof document === "undefined") return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (ref.current?.contains(t as Node)) return;
      if (t?.closest?.("[data-review-widget]")) return; // the pill's own buttons
      onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown, true); };
  }, [open, onClose]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div ref={ref} data-review-chrome data-attached-window=""
      style={{
        position: "fixed", left: at?.left ?? -9999, top: at?.top ?? -9999,
        width: Math.min(width, typeof window !== "undefined" ? window.innerWidth - 12 : width),
        background: S.sheet, color: S.fg, border: `1px solid ${S.border}`, borderRadius: 12,
        padding: 12, zIndex: Z, fontFamily: "system-ui, sans-serif",
        boxShadow: "0 14px 44px rgba(0,0,0,.28)", pointerEvents: "auto",
        ...surface,
      }}>
      {title && <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 8 }}>{title}</div>}
      {children}
    </div>,
    document.body,
  );
}
