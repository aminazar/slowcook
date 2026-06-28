// ReviewWidget — the context-free floating review shell, decoupled from the LCR
// overlay's EPSS/CSS-selector machinery. It anchors comments to SEMANTIC NODES
// (an attribute, default `data-review-node`) instead of DOM selectors, so it suits
// structured, mutating content (a PRD passage, an invariant, a budget knob) that
// re-renders and reorders. Same reusable abstractions as the LCR pill — floating +
// draggable chrome, a configurable mode toggle, anchored markers + a sidebar list,
// an accessory slot, host-theme awareness — minus anything mock/EPSS-specific.
//
// First consumer: dash's coral "Refine" pill (PM requirement review). Next: QA on a
// real backend. The LCR mock-review overlay stays as-is for vibe/plate.
import { useEffect, useMemo, useState, type ReactNode, type CSSProperties, type JSX, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { usePrefersDark, sheetTheme } from "./theme.js";

export interface ReviewComment { id: string; node: string; label: string; text: string; author: string; createdAt: number; }
export type Corner = "bottom-left" | "bottom-right" | "top-left" | "top-right";

export interface ReviewWidgetProps {
  enabled?: boolean;
  /** Pill title, e.g. "Refine". */
  title?: string;
  /** Brand accent for the pill, markers, highlight (dash coral by default). */
  accent?: string;
  /** Pill glyph/icon. */
  icon?: ReactNode;
  /** Initial corner (draggable thereafter). */
  corner?: Corner;
  /** The two mode labels — [browse, comment]. */
  toggleLabels?: [string, string];
  /** Attribute carrying the semantic node id (default `data-review-node`). */
  anchorAttribute?: string;
  /** Attribute carrying the human label (default `data-review-label`). */
  labelAttribute?: string;
  author?: string;
  /** localStorage key for the (v1) internal comment store. */
  storageKey?: string;
  accessory?: ReactNode;
}

const DASH_CORAL = "#FF6B6B";
const Z = 2147483000;

const load = (k: string): ReviewComment[] => { try { const r = localStorage.getItem(k); return r ? (JSON.parse(r) as ReviewComment[]) : []; } catch { return []; } };
const save = (k: string, v: ReviewComment[]) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };
const attrSel = (attr: string, val: string) => `[${attr}="${val.replace(/(["\\])/g, "\\$1")}"]`;
const flash = (el: HTMLElement, color: string) => { const prev = el.style.outline; el.style.transition = "outline .15s"; el.style.outline = `2px solid ${color}`; el.style.outlineOffset = "2px"; setTimeout(() => { el.style.outline = prev; }, 1100); };
const ago = (t: number) => { const s = Math.floor((Date.now() - t) / 1000); if (s < 60) return "just now"; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return `${Math.floor(s / 86400)}d ago`; };

export function ReviewWidget(props: ReviewWidgetProps): JSX.Element | null {
  const {
    enabled = true, title = "Refine", accent = DASH_CORAL, icon = "✎",
    corner = "bottom-left", toggleLabels = ["Read", "Comment"],
    anchorAttribute = "data-review-node", labelAttribute = "data-review-label",
    author = "PM", storageKey = "slowcook.review-widget.comments", accessory,
  } = props;
  const dark = usePrefersDark();
  const S = sheetTheme(dark);
  const [comments, setComments] = useState<ReviewComment[]>(() => (typeof window !== "undefined" ? load(storageKey) : []));
  const persist = (next: ReviewComment[]) => { setComments(next); save(storageKey, next); };
  const [mode, setMode] = useState<"read" | "comment">("read");
  const [listOpen, setListOpen] = useState(false);
  const [hover, setHover] = useState<{ rect: DOMRect; label: string } | null>(null);
  const [composer, setComposer] = useState<{ node: string; label: string } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [, setTick] = useState(0);

  const sel = `[${anchorAttribute}]`;
  const isSelf = (el: Element | null) => !!el?.closest?.("[data-review-widget]");

  // Initial pill position from the chosen corner.
  useEffect(() => {
    if (pos || typeof window === "undefined") return;
    const m = 16, w = 250, h = 44;
    const x = corner.includes("left") ? m : window.innerWidth - w - m;
    const y = corner.includes("top") ? m : window.innerHeight - h - m;
    setPos({ x, y });
  }, [corner, pos]);

  // Comment-mode interactions: hover-highlight a node, click to open the composer.
  useEffect(() => {
    if (!enabled || mode !== "comment") { setHover(null); return; }
    const move = (e: PointerEvent) => {
      if (isSelf(e.target as Element)) { setHover(null); return; }
      const el = (e.target as Element)?.closest?.(sel) as HTMLElement | null;
      setHover(el ? { rect: el.getBoundingClientRect(), label: el.getAttribute(labelAttribute) || el.getAttribute(anchorAttribute) || "" } : null);
    };
    const click = (e: MouseEvent) => {
      if (isSelf(e.target as Element)) return;
      const el = (e.target as Element)?.closest?.(sel) as HTMLElement | null;
      if (!el) return;
      e.preventDefault(); e.stopPropagation();
      setComposer({ node: el.getAttribute(anchorAttribute)!, label: el.getAttribute(labelAttribute) || el.getAttribute(anchorAttribute)! });
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("click", click, true);
    return () => { document.removeEventListener("pointermove", move, true); document.removeEventListener("click", click, true); };
  }, [enabled, mode, sel, anchorAttribute, labelAttribute]);

  // Reposition markers on scroll/resize/route (interval covers SPA nav).
  useEffect(() => {
    if (!enabled) return;
    const bump = () => setTick((t) => t + 1);
    window.addEventListener("scroll", bump, true);
    window.addEventListener("resize", bump);
    const iv = setInterval(bump, 600);
    return () => { window.removeEventListener("scroll", bump, true); window.removeEventListener("resize", bump); clearInterval(iv); };
  }, [enabled]);

  const byNode = useMemo(() => {
    const m = new Map<string, ReviewComment[]>();
    for (const c of comments) { const a = m.get(c.node); if (a) a.push(c); else m.set(c.node, [c]); }
    return m;
  }, [comments]);

  if (!enabled || typeof document === "undefined") return null;

  // Live marker rects (recomputed each render; `setTick` drives re-render).
  const markers: { node: string; count: number; x: number; y: number }[] = [];
  byNode.forEach((list, node) => {
    const el = document.querySelector(attrSel(anchorAttribute, node)) as HTMLElement | null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    markers.push({ node, count: list.length, x: r.right - 7, y: r.top + 7 });
  });

  const addComment = (text: string) => {
    if (!composer || !text.trim()) return;
    persist([{ id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, node: composer.node, label: composer.label, text: text.trim(), author, createdAt: Date.now() }, ...comments]);
    setComposer(null);
  };
  const gotoNode = (node: string) => {
    const el = document.querySelector(attrSel(anchorAttribute, node)) as HTMLElement | null;
    if (el) { el.scrollIntoView({ block: "center", behavior: "smooth" }); flash(el, accent); }
  };

  const seg = (active: boolean): CSSProperties => ({ padding: "3px 10px", borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: "pointer", background: active ? accent : "transparent", color: active ? "#1a1a1a" : S.fgDim });

  return createPortal(
    <div data-review-widget="" style={{ position: "fixed", inset: 0, zIndex: Z, pointerEvents: "none" }}>
      {/* hover highlight (comment mode) */}
      {mode === "comment" && hover && (
        <div style={{ position: "fixed", left: hover.rect.left - 3, top: hover.rect.top - 3, width: hover.rect.width + 6, height: hover.rect.height + 6, border: `2px solid ${accent}`, borderRadius: 6, background: `${accent}14`, pointerEvents: "none", zIndex: Z + 1 }}>
          <span style={{ position: "absolute", top: -20, left: 0, fontSize: 10, fontWeight: 700, color: "#1a1a1a", background: accent, borderRadius: 4, padding: "1px 6px", whiteSpace: "nowrap" }}>💬 {hover.label}</span>
        </div>
      )}

      {/* anchored markers */}
      {markers.map((m) => (
        <button key={m.node} onClick={() => { setListOpen(true); gotoNode(m.node); }}
          style={{ position: "fixed", left: m.x, top: m.y, transform: "translate(-50%, -50%)", width: 18, height: 18, borderRadius: 999, background: accent, color: "#1a1a1a", border: "1.5px solid #fff", fontSize: 10, fontWeight: 800, cursor: "pointer", pointerEvents: "auto", zIndex: Z + 1, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 6px rgba(0,0,0,.35)" }}
          title={`${m.count} comment${m.count > 1 ? "s" : ""}`}>{m.count}</button>
      ))}

      {/* the floating pill */}
      {pos && (
        <div style={{ position: "fixed", left: pos.x, top: pos.y, display: "flex", alignItems: "center", gap: 8, padding: "6px 8px 6px 10px", borderRadius: 999, background: S.sheet, border: `1px solid ${S.border}`, boxShadow: "0 6px 20px rgba(0,0,0,.35)", pointerEvents: "auto", zIndex: Z + 2, fontFamily: "system-ui, sans-serif", userSelect: "none" }}>
          <span onPointerDown={(e) => startDrag(e, pos, setPos)} title="Drag to move" style={{ display: "flex", alignItems: "center", gap: 6, cursor: "grab", color: S.fg }}>
            <span style={{ width: 18, height: 18, borderRadius: 999, background: accent, color: "#1a1a1a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800 }}>{icon}</span>
            <span style={{ fontSize: 12.5, fontWeight: 800 }}>{title}</span>
          </span>
          <span style={{ display: "flex", gap: 2, background: dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)", borderRadius: 9, padding: 2 }}>
            <button onClick={() => setMode("read")} style={seg(mode === "read")}>{toggleLabels[0]}</button>
            <button onClick={() => setMode("comment")} style={seg(mode === "comment")}>{toggleLabels[1]}</button>
          </span>
          <button onClick={() => setListOpen((o) => !o)} title="All comments"
            style={{ display: "flex", alignItems: "center", gap: 4, background: "transparent", border: `1px solid ${S.border}`, borderRadius: 8, color: S.fgDim, cursor: "pointer", fontSize: 12, padding: "3px 8px" }}>
            🗨 {comments.length}
          </button>
          {accessory}
        </div>
      )}

      {/* composer popover */}
      {composer && <Composer label={composer.label} S={S} accent={accent} onSubmit={addComment} onCancel={() => setComposer(null)} />}

      {/* sidebar list */}
      {listOpen && <Sidebar comments={comments} title={title} S={S} accent={accent} onClose={() => setListOpen(false)} onDelete={(id) => persist(comments.filter((c) => c.id !== id))} onGoto={gotoNode} />}
    </div>,
    document.body,
  );
}

function startDrag(e: ReactPointerEvent, pos: { x: number; y: number }, setPos: (p: { x: number; y: number }) => void) {
  e.preventDefault();
  const sx = e.clientX, sy = e.clientY, ox = pos.x, oy = pos.y;
  const move = (ev: PointerEvent) => setPos({ x: Math.max(4, ox + ev.clientX - sx), y: Math.max(4, oy + ev.clientY - sy) });
  const up = () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); };
  document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
}

function Composer({ label, S, accent, onSubmit, onCancel }: { label: string; S: ReturnType<typeof sheetTheme>; accent: string; onSubmit: (t: string) => void; onCancel: () => void }): JSX.Element {
  const [text, setText] = useState("");
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "auto", zIndex: Z + 5 }} onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 420, maxWidth: "92vw", background: S.sheet, color: S.fg, border: `1px solid ${S.border}`, borderRadius: 12, padding: 16, boxShadow: "0 20px 60px rgba(0,0,0,.45)", fontFamily: "system-ui, sans-serif" }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: accent, marginBottom: 8 }}>Comment on · {label}</div>
        <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="What should change here? (an AI will draft the edit — coming next)"
          style={{ width: "100%", boxSizing: "border-box", fontSize: 13.5, padding: 10, borderRadius: 8, border: `1px solid ${S.inputBorder}`, background: S.input, color: S.fg, fontFamily: "inherit", resize: "vertical" }} />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
          <button onClick={onCancel} style={{ padding: "7px 14px", borderRadius: 8, border: `1px solid ${S.border}`, background: "transparent", color: S.fgDim, cursor: "pointer", font: "inherit", fontWeight: 600 }}>Cancel</button>
          <button onClick={() => onSubmit(text)} disabled={!text.trim()} style={{ padding: "7px 14px", borderRadius: 8, border: "none", background: accent, color: "#1a1a1a", cursor: text.trim() ? "pointer" : "not-allowed", opacity: text.trim() ? 1 : 0.5, font: "inherit", fontWeight: 700 }}>Comment</button>
        </div>
      </div>
    </div>
  );
}

function Sidebar({ comments, title, S, accent, onClose, onDelete, onGoto }: { comments: ReviewComment[]; title: string; S: ReturnType<typeof sheetTheme>; accent: string; onClose: () => void; onDelete: (id: string) => void; onGoto: (node: string) => void }): JSX.Element {
  return (
    <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 340, maxWidth: "90vw", background: S.sheet, color: S.fg, borderLeft: `1px solid ${S.border}`, boxShadow: "-12px 0 40px rgba(0,0,0,.4)", pointerEvents: "auto", zIndex: Z + 4, display: "flex", flexDirection: "column", fontFamily: "system-ui, sans-serif", fontSize: 13 }}>
      <div style={{ padding: "13px 16px", borderBottom: `1px solid ${S.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontWeight: 700 }}>{title} comments ({comments.length})</span>
        <button onClick={onClose} aria-label="Close" style={{ background: "transparent", border: "none", color: S.fgDim, cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
      </div>
      <div style={{ overflow: "auto", flex: 1, padding: 10 }}>
        {comments.length === 0 ? (
          <div style={{ padding: 16, opacity: 0.6, textAlign: "center", fontSize: 12 }}>No comments yet. Switch to <b style={{ color: accent }}>Comment</b> and click a labelled part of the page.</div>
        ) : comments.map((c) => (
          <div key={c.id} style={{ background: "rgba(127,127,127,0.06)", border: `1px solid ${S.border}`, borderRadius: 8, padding: 10, marginBottom: 8 }}>
            <button onClick={() => onGoto(c.node)} style={{ display: "block", textAlign: "left", width: "100%", background: "transparent", border: "none", cursor: "pointer", color: accent, fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3, padding: 0, marginBottom: 4 }}>📍 {c.label}</button>
            <div style={{ fontSize: 13, color: S.fg, lineHeight: 1.4 }}>{c.text}</div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
              <span style={{ fontSize: 10.5, color: S.fgDim }}>@{c.author} · {ago(c.createdAt)}</span>
              <button onClick={() => onDelete(c.id)} style={{ background: "transparent", border: "none", color: S.fgDim, cursor: "pointer", fontSize: 11 }}>Delete</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
