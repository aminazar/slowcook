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
import { useEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties, type JSX, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { MdLite } from "./md-lite.js";
import { usePrefersDark, sheetTheme } from "./theme.js";
import { clampPillPosition } from "../selector.js";
import { CometSheen } from "./comet.js";
import { installBreadcrumbRecorder } from "./breadcrumbs.js";

// ── SHELL PRIMITIVE (0.12.0 decoupling) ─────────────────────────────────────
// ReviewShell is the GENERIC review surface: pill + mode toggle + anchor
// picking (data-review-node) + hover highlight + markers + composer + sidebar
// threads. It knows NOTHING about GitHub, vibe/plate, or any workflow — all
// behavior is injected: persistence via CommentStore, transport via onComment,
// thread state via meta, host UI via renderCommentExtra/sidebarFooter.
// Consumers: the OSS ReviewWidget (back-compat alias w/ localStorage), dash's
// RefinePill (pm-/brand-assistant loop), and the vibe/plate overlay over time.

/** where comments persist — injectable; localStorage by default. */
export interface CommentStore {
  load(): ReviewComment[];
  save(comments: ReviewComment[]): void;
}

export const localStorageStore = (key: string): CommentStore => ({
  load: () => { try { const r = localStorage.getItem(key); return r ? (JSON.parse(r) as ReviewComment[]) : []; } catch { return []; } },
  save: (v) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } },
});

export interface ReviewComment { id: string; node: string; label: string; text: string; author: string; createdAt: number; url?: string; remoteId?: string | number; }

// 0.14.0 — drafts: text typed into a composer/reply box survives a stray
// backdrop click (and a reload). Keyed by anchor node (composer) or
// `reply:<commentId>` (reply box); cleared on submit.
const DRAFTS_KEY = "review-shell-drafts";
const loadDrafts = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? "{}") as Record<string, string>; } catch { return {}; } };
export const draftFor = (key: string): string => loadDrafts()[key] ?? "";
export const saveDraft = (key: string, text: string): void => {
  try {
    const d = loadDrafts();
    if (text.trim()) d[key] = text; else delete d[key];
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(d));
  } catch { /* ignore */ }
};

/** 0.12.0 — external per-comment state supplied by the host (agent replies,
 *  lifecycle status like "applied"), keyed by comment id. */
export interface ReviewCommentMeta {
  status?: string;
  replies?: { author: string; text: string; createdAt?: number }[];
  url?: string;
}
export type Corner = "bottom-left" | "bottom-right" | "top-left" | "top-right";

export interface ReviewShellProps {
  /** Gate (a): whether the current persona/user may review/chat here. When false
   *  the widget renders nothing. */
  enabled?: boolean;
  /** Gate (b): hide the widget when the page has NO reviewable context (no nodes
   *  carrying `anchorAttribute`). Default true — the pill only appears where there
   *  is actually something to review. */
  requireTargets?: boolean;
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
  /** 0.14.0 — never refuse a target: when a click has NO anchor-attribute
   *  ancestor, synthesize one from the DOM path (`dom:<selector>`) + visible
   *  text. For bug-reporter shells (QA): every element on the page must be
   *  commentable, labelled or not. Markers/goto resolve `dom:` nodes by path. */
  anchorFallback?: boolean;
  author?: string;
  /** comment persistence — inject your own; defaults to localStorage. */
  store?: CommentStore;
  accessory?: ReactNode;
  /** 0.12.0 — transport hook: called when a comment is posted. May return a
   *  remote id/url (e.g. a GitHub issue) merged into the stored comment. */
  onComment?: (c: ReviewComment) => void | Promise<void | { url?: string; remoteId?: string | number }>;
  /** 0.14.0 — reply transport: when provided, every comment (sidebar + the
   *  anchored thread popover) grows a reply box. Replies render optimistically;
   *  the host's transport (e.g. a GitHub issue comment) reconciles via `meta`. */
  onReply?: (c: ReviewComment, text: string) => void | Promise<void>;
  /** 0.12.0 — per-comment external state (replies/status), keyed by comment id. */
  meta?: Record<string, ReviewCommentMeta>;
  /** 0.12.0 — extra per-comment UI (e.g. a before/after diff toggle). */
  renderCommentExtra?: (c: ReviewComment) => ReactNode;
  /** 0.12.0 — sidebar footer slot (e.g. a final-approval action). */
  sidebarFooter?: ReactNode;
  /** 0.12.1 — first-appearance choreography: the pill is born CENTER-stage,
   *  and 1s later a deliberate meteor streaks across the page and strikes it;
   *  after a beat the pill settles to its corner. Runs ONCE (persisted under
   *  `storageKey`), honors prefers-reduced-motion, and any user interaction
   *  cuts straight to the settled state. */
  intro?: { storageKey?: string };
}

const DASH_CORAL = "#FF6B6B";
const Z = 2147483000;

const attrSel = (attr: string, val: string) => `[${attr}="${val.replace(/(["\\])/g, "\\$1")}"]`;

// ── 0.14.0 anchor fallback ───────────────────────────────────────────────────
// A synthesized anchor for elements without a semantic node: a capped
// tag:nth-of-type path from <body>, prefixed `dom:`. Less durable than a real
// anchor (a re-render that reorders siblings moves it) — but a QA comment that
// lands approximately beats one that can't be placed at all.
const FALLBACK_CONTAINERS = new Set(["DIV", "SECTION", "ARTICLE", "ASIDE", "FORM", "LI", "TABLE", "FIELDSET", "NAV", "HEADER", "FOOTER", "MAIN", "DIALOG"]);

export function domPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.tagName !== "BODY" && parts.length < 8) {
    const tag = cur.tagName.toLowerCase();
    let nth = 1;
    for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (sib.tagName === cur.tagName) nth++;
    }
    parts.unshift(`${tag}:nth-of-type(${nth})`);
    cur = cur.parentElement;
  }
  return `body > ${parts.join(" > ")}`;
}

/** the fallback target: the clicked element itself if it's a container, else its
 *  nearest container ancestor — so the highlight/comment wraps the visual box. */
export function fallbackContainer(el: Element): Element {
  let cur: Element | null = el;
  while (cur && cur.tagName !== "BODY") {
    if (FALLBACK_CONTAINERS.has(cur.tagName)) return cur;
    cur = cur.parentElement;
  }
  return el;
}

const fallbackLabel = (el: Element): string => {
  const text = (el.textContent ?? "").trim().replace(/\s+/g, " ");
  return text ? (text.length > 48 ? `${text.slice(0, 48)}…` : text) : `<${el.tagName.toLowerCase()}>`;
};
const flash = (el: HTMLElement, color: string) => { const prev = el.style.outline; el.style.transition = "outline .15s"; el.style.outline = `2px solid ${color}`; el.style.outlineOffset = "2px"; setTimeout(() => { el.style.outline = prev; }, 1100); };
const ago = (t: number) => { const s = Math.floor((Date.now() - t) / 1000); if (s < 60) return "just now"; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return `${Math.floor(s / 86400)}d ago`; };

/** 0.12.1 — the intro meteor: a DELIBERATE streak from the upper-left sky to
 *  the pill's heart, with a tapering glow trail and a strike burst. Pure CSS
 *  motion-path animation; deterministic (no randomness — it AIMS). */
function IntroMeteor({ target, accent }: { target: { x: number; y: number }; accent: string }): JSX.Element {
  const w = typeof window !== "undefined" ? window.innerWidth : 1200;
  const start = { x: -140, y: Math.round((typeof window !== "undefined" ? window.innerHeight : 800) * 0.06) };
  // one gentle arc: control point above the direct line for a falling feel
  const cp = { x: Math.round((start.x + target.x) / 2 + w * 0.06), y: Math.max(-40, Math.round(Math.min(start.y, target.y) - 120)) };
  const path = `M ${start.x} ${start.y} Q ${cp.x} ${cp.y} ${target.x} ${target.y}`;
  const anim = `
@keyframes rs-meteor-fly { 0% { offset-distance: 0%; opacity: 0; } 8% { opacity: 1; } 88% { opacity: 1; } 100% { offset-distance: 100%; opacity: 0; } }
@keyframes rs-meteor-trail { 0% { stroke-dashoffset: 1000; opacity: 0; } 10% { opacity: .9; } 70% { opacity: .55; } 100% { stroke-dashoffset: 0; opacity: 0; } }
@keyframes rs-strike-ring { 0% { transform: translate(-50%,-50%) scale(.2); opacity: .95; } 100% { transform: translate(-50%,-50%) scale(3.4); opacity: 0; } }
@keyframes rs-strike-glow { 0% { opacity: 0; } 12% { opacity: .9; } 100% { opacity: 0; } }`;
  return (
    <div aria-hidden style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: Z + 8, overflow: "hidden" }}>
      <style>{anim}</style>
      <svg width="100%" height="100%" style={{ position: "absolute", inset: 0 }}>
        <defs>
          <linearGradient id="rs-meteor-grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={accent} stopOpacity="0" />
            <stop offset="70%" stopColor={accent} stopOpacity="0.55" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0.95" />
          </linearGradient>
        </defs>
        <path d={path} fill="none" stroke="url(#rs-meteor-grad)" strokeWidth={3.5} strokeLinecap="round"
          strokeDasharray="1000" style={{ animation: "rs-meteor-trail 1.05s cubic-bezier(.5,0,.9,.6) forwards" }} />
      </svg>
      {/* the head — a hot core with a coral halo, riding the same path */}
      <div style={{
        position: "absolute", width: 14, height: 14, borderRadius: 999, background: "#fff",
        boxShadow: `0 0 10px 3px #fff, 0 0 26px 12px ${accent}, 0 0 70px 30px ${accent}55`,
        offsetPath: `path('${path}')`, offsetRotate: "0deg",
        animation: "rs-meteor-fly 1.05s cubic-bezier(.5,0,.9,.6) forwards",
      } as CSSProperties} />
      {/* the strike: an expanding ring + a brief glow where it lands */}
      <div style={{ position: "absolute", left: target.x, top: target.y, width: 56, height: 56, borderRadius: 999, border: `2.5px solid ${accent}`, transform: "translate(-50%,-50%) scale(.2)", opacity: 0, animation: "rs-strike-ring .75s ease-out 1s forwards" } as CSSProperties} />
      <div style={{ position: "absolute", left: target.x, top: target.y, width: 120, height: 120, borderRadius: 999, transform: "translate(-50%,-50%)", background: `radial-gradient(circle, ${accent}66 0%, transparent 70%)`, opacity: 0, animation: "rs-strike-glow .9s ease-out 1s forwards" } as CSSProperties} />
    </div>
  );
}

export function ReviewShell(props: ReviewShellProps): JSX.Element | null {
  const {
    enabled = true, requireTargets = true, anchorFallback = false, title = "Refine", accent = DASH_CORAL, icon = "✎",
    onComment, onReply, meta, renderCommentExtra, sidebarFooter, intro,
    store = localStorageStore("review-shell-comments"),
    corner = "bottom-left", toggleLabels = ["Read", "Comment"],
    anchorAttribute = "data-review-node", labelAttribute = "data-review-label",
    author = "PM", accessory,
  } = props;
  const pillRef = useRef<HTMLDivElement | null>(null);
  const dark = usePrefersDark();
  const S = sheetTheme(dark);
  const [comments, setComments] = useState<ReviewComment[]>(() => (typeof window !== "undefined" ? store.load() : []));
  const persist = (next: ReviewComment[]) => { setComments(next); store.save(next); };
  const [mode, setMode] = useState<"read" | "comment">("read");
  const [listOpen, setListOpen] = useState(false);
  const [hover, setHover] = useState<{ rect: DOMRect; label: string; draft?: boolean } | null>(null);
  const [composer, setComposer] = useState<{ node: string; label: string; x: number; y: number } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [, setTick] = useState(0);
  // 0.14.0 — the anchored thread popover (a marker click reopens the box at its
  // anchor instead of dumping the reviewer into the sidebar).
  const [thread, setThread] = useState<string | null>(null);
  // 0.14.0 — optimistic replies (shown until the host's meta reconciles them).
  const [pendingReplies, setPendingReplies] = useState<Record<string, { author: string; text: string }[]>>({});
  // 0.14.0 — unread signal: per-comment signature of external state (status +
  // reply count) vs the last-seen signature, persisted so "what changed since I
  // last looked" survives reloads. GitHub can't notify a reviewer of activity
  // performed with their own credential — the shell has to.
  const seenKey = "review-shell-seen";
  const [seen, setSeen] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem(seenKey) ?? "{}") as Record<string, string>; } catch { return {}; }
  });
  const sig = (c: ReviewComment): string => {
    const m = meta?.[c.id];
    return `${m?.status ?? ""}|${(m?.replies?.length ?? 0)}`;
  };
  const hasExternal = (c: ReviewComment): boolean => {
    const m = meta?.[c.id];
    return !!m && (!!m.status || (m.replies?.length ?? 0) > 0);
  };
  const unread = comments.filter((c) => hasExternal(c) && seen[c.id] !== sig(c));
  const markSeen = (ids: string[]) => {
    if (!ids.length) return;
    setSeen((prev) => {
      const next = { ...prev };
      for (const id of ids) { const c = comments.find((x) => x.id === id); if (c) next[id] = sig(c); }
      try { localStorage.setItem(seenKey, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };
  // 0.14.0 — applied threads hide by default (parity with the LCR overlay):
  // the reviewer focuses on what's open; a toggle reveals the archive. Unread
  // activity overrides hiding — an applied thread with news still surfaces.
  const [showApplied, setShowApplied] = useState(false);
  // 0.14.0 — hovering a sidebar comment draws ONE dashed connector to its
  // anchor (all-at-once lines were considered and rejected: spaghetti, and
  // off-screen anchors make permanent lines meaningless).
  const [sideHover, setSideHover] = useState<{ node: string; y: number } | null>(null);
  const isApplied = (c: ReviewComment) => meta?.[c.id]?.status === "applied";
  const addReply = (c: ReviewComment, text: string) => {
    if (!onReply || !text.trim()) return;
    setPendingReplies((p) => ({ ...p, [c.id]: [...(p[c.id] ?? []), { author, text: text.trim() }] }));
    void Promise.resolve(onReply(c, text.trim())).catch(() => { /* best-effort; the optimistic reply stays visible */ });
  };
  /** replies to show = host meta ∪ optimistic-pending (deduped by text). */
  const repliesFor = (c: ReviewComment): { author: string; text: string }[] => {
    const remote = meta?.[c.id]?.replies ?? [];
    const pending = (pendingReplies[c.id] ?? []).filter((p) => !remote.some((r) => r.text === p.text));
    return [...remote, ...pending];
  };

  // 0.12.1 first-appearance intro: idle → staged (center) → strike (meteor) → settling → done
  const introKey = intro?.storageKey ?? "review-shell-intro-seen";
  const reduceMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const wantsIntro = !!intro && !reduceMotion && (() => { try { return !localStorage.getItem(introKey); } catch { return false; } })();
  const [introPhase, setIntroPhase] = useState<"idle" | "staged" | "strike" | "settling" | "done">(wantsIntro ? "staged" : "done");
  const finishIntro = () => {
    try { localStorage.setItem(introKey, String(Date.now())); } catch { /* ignore */ }
    setIntroPhase("done");
  };

  const sel = `[${anchorAttribute}]`;
  const isSelf = (el: Element | null) => !!el?.closest?.("[data-review-widget]");

  useEffect(() => { installBreadcrumbRecorder(); }, []);
  // Initial pill position: center-stage during the intro, else the chosen corner.
  useEffect(() => {
    if (pos || typeof window === "undefined") return;
    const m = 16, w = 250, h = 44;
    if (introPhase === "staged") {
      setPos({ x: Math.round(window.innerWidth / 2 - w / 2), y: Math.round(window.innerHeight / 2 - h / 2) });
      return;
    }
    const x = corner.includes("left") ? m : window.innerWidth - w - m;
    const y = corner.includes("top") ? m : window.innerHeight - h - m;
    setPos({ x, y });
  }, [corner, pos, introPhase]);

  // intro choreography: 1s on stage → the meteor strikes (1.05s flight) →
  // a beat to admire → settle to the corner.
  useEffect(() => {
    if (introPhase === "staged") { const t = setTimeout(() => setIntroPhase("strike"), 1000); return () => clearTimeout(t); }
    if (introPhase === "strike") { const t = setTimeout(() => setIntroPhase("settling"), 2400); return () => clearTimeout(t); }
    if (introPhase === "settling") {
      const m = 16, w = 250, h = 44;
      const x = corner.includes("left") ? m : window.innerWidth - w - m;
      const y = corner.includes("top") ? m : window.innerHeight - h - m;
      setPos({ x, y });
      const t = setTimeout(() => finishIntro(), 800);
      return () => clearTimeout(t);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [introPhase, corner]);

  // Keep the pill on-screen if the window resizes smaller (0.10.1).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setPos((p) => (p ? clampToViewport(p) : p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Comment-mode interactions: hover-highlight a node, click to open the composer.
  // With anchorFallback, an element with no anchored ancestor still resolves — to
  // its visual container, with a synthesized `dom:` node — so a comment can land
  // ANYWHERE on the page (the bug-reporter contract).
  useEffect(() => {
    if (!enabled || mode !== "comment") { setHover(null); return; }
    const resolve = (target: Element | null): { el: HTMLElement; node: string; label: string } | null => {
      if (!target) return null;
      const anchored = target.closest?.(sel) as HTMLElement | null;
      if (anchored) return { el: anchored, node: anchored.getAttribute(anchorAttribute)!, label: anchored.getAttribute(labelAttribute) || anchored.getAttribute(anchorAttribute)! };
      if (!anchorFallback) return null;
      const box = fallbackContainer(target) as HTMLElement;
      return { el: box, node: `dom:${domPath(box)}`, label: fallbackLabel(box) };
    };
    const move = (e: PointerEvent) => {
      if (isSelf(e.target as Element)) { setHover(null); return; }
      const t = resolve(e.target as Element);
      setHover(t ? { rect: t.el.getBoundingClientRect(), label: t.label, draft: !!draftFor(t.node) } : null);
    };
    const click = (e: MouseEvent) => {
      if (isSelf(e.target as Element)) return;
      const t = resolve(e.target as Element);
      if (!t) return;
      e.preventDefault(); e.stopPropagation();
      setComposer({ node: t.node, label: t.label, x: e.clientX, y: e.clientY });
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("click", click, true);
    return () => { document.removeEventListener("pointermove", move, true); document.removeEventListener("click", click, true); };
  }, [enabled, mode, sel, anchorAttribute, labelAttribute, anchorFallback]);

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
  // Gate (b): nothing to review on this page → don't show the pill. (Recomputed on
  // the marker-scan tick, so it follows SPA navigation.)
  if (requireTargets && !document.querySelector(sel)) return null;

  // node → element: semantic anchors by attribute; `dom:` fallbacks by path.
  const findNodeEl = (node: string): HTMLElement | null => {
    try {
      return document.querySelector(node.startsWith("dom:") ? node.slice(4) : attrSel(anchorAttribute, node)) as HTMLElement | null;
    } catch { return null; }
  };

  // Live marker rects (recomputed each render; `setTick` drives re-render).
  // 0.14.0 — anchors can legitimately DISAPPEAR (a resolved card removed from a
  // shrinking document while its thread is still open). Those comments must not
  // vanish: they collect as orphans, surfaced on the pill and in the sidebar.
  const markers: { node: string; count: number; x: number; y: number }[] = [];
  const orphanNodes: string[] = [];
  byNode.forEach((list, node) => {
    const el = findNodeEl(node);
    if (!el) { orphanNodes.push(node); return; }
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    markers.push({ node, count: list.length, x: r.right - 7, y: r.top + 7 });
  });
  void orphanNodes; // orphans surface in the sidebar as anchorless — no extra pill chrome (Amin)

  const addComment = (text: string) => {
    if (!composer || !text.trim()) return;
    const c: ReviewComment = { id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, node: composer.node, label: composer.label, text: text.trim(), author, createdAt: Date.now() };
    persist([c, ...comments]);
    setComposer(null);
    if (onComment) {
      void Promise.resolve(onComment(c)).then((ref) => {
        if (ref && (ref.url || ref.remoteId !== undefined)) {
          setComments((cur) => { const next = cur.map((x) => x.id === c.id ? { ...x, url: ref.url, remoteId: ref.remoteId } : x); store.save(next); return next; });
        }
      }).catch(() => { /* transport is best-effort; the comment stays local */ });
    }
  };
  const gotoNode = (node: string) => {
    const el = findNodeEl(node);
    if (el) { el.scrollIntoView({ block: "center", behavior: "smooth" }); flash(el, accent); }
  };

  const seg = (active: boolean): CSSProperties => ({ padding: "3px 10px", borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: "pointer", background: active ? accent : "transparent", color: active ? "#1a1a1a" : S.fgDim });

  return createPortal(
    <div data-review-widget="" style={{ position: "fixed", inset: 0, zIndex: Z, pointerEvents: "none" }}>
      {introPhase === "strike" && pos && (
        <IntroMeteor target={{ x: pos.x + 125, y: pos.y + 22 }} accent={accent} />
      )}
      {/* hover highlight (comment mode) */}
      {mode === "comment" && hover && (
        <div style={{ position: "fixed", left: hover.rect.left - 3, top: hover.rect.top - 3, width: hover.rect.width + 6, height: hover.rect.height + 6, border: `2px solid ${accent}`, borderRadius: 6, background: `${accent}14`, pointerEvents: "none", zIndex: Z + 1 }}>
          <span style={{ position: "absolute", top: -20, left: 0, fontSize: 10, fontWeight: 700, color: "#1a1a1a", background: accent, borderRadius: 4, padding: "1px 6px", whiteSpace: "nowrap" }}>💬 {hover.label}{hover.draft ? " · ✎ draft saved" : ""}</span>
        </div>
      )}

      {/* anchored markers — click reopens the thread AT its anchor (0.14.0);
          a halo marks threads with unseen activity */}
      {markers.map((m) => {
        const list = byNode.get(m.node) ?? [];
        const ids = list.map((c) => c.id);
        const hot = unread.some((c) => ids.includes(c.id));
        if (!showApplied && !hot && list.length > 0 && list.every(isApplied)) return null;
        return (
          <button key={m.node} onClick={() => { gotoNode(m.node); setThread(m.node); markSeen(ids); }}
            style={{ position: "fixed", left: m.x, top: m.y, transform: "translate(-50%, -50%)", minWidth: 18, height: 18, padding: "0 5px", borderRadius: 999, background: accent, color: "#fff", border: "1.5px solid #fff", fontSize: 9.5, fontWeight: 800, cursor: "pointer", pointerEvents: "auto", zIndex: Z + 1, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: hot ? `0 0 0 3px ${accent}66, 0 2px 6px rgba(0,0,0,.35)` : "0 2px 6px rgba(0,0,0,.35)", whiteSpace: "nowrap" }}
            title={`${m.count} comment${m.count > 1 ? "s" : ""}${hot ? " · new activity" : ""} — click to open the thread`}>{m.count === 1 && typeof list[0]?.remoteId === "number" ? `#${list[0].remoteId}` : m.count}</button>
        );
      })}

      {/* the floating pill */}
      {pos && (
        <div ref={pillRef} style={{ position: "fixed", left: pos.x, top: pos.y, display: "flex", alignItems: "center", gap: 8, padding: "6px 8px 6px 10px", borderRadius: 999, background: S.sheet, border: `1px solid ${S.border}`,
          boxShadow: introPhase === "strike" ? `0 6px 20px rgba(0,0,0,.35), 0 0 34px 6px ${accent}88` : "0 6px 20px rgba(0,0,0,.35)",
          pointerEvents: "auto", zIndex: Z + 9, fontFamily: "system-ui, sans-serif", userSelect: "none",
          transform: introPhase === "staged" || introPhase === "strike" ? "scale(1.25)" : "scale(1)",
          transition: introPhase === "settling" ? "left .8s cubic-bezier(.22,.8,.36,1), top .8s cubic-bezier(.22,.8,.36,1), transform .8s cubic-bezier(.22,.8,.36,1), box-shadow .8s ease" : introPhase === "strike" ? "box-shadow .25s ease 1s, transform .3s cubic-bezier(.34,1.56,.64,1) 1s" : undefined,
        }} onPointerDownCapture={() => { if (introPhase !== "done") finishIntro(); }}>
          <CometSheen pillRef={pillRef} radius={999} />
          <span onPointerDown={(e) => startDrag(e, pos, setPos)} title="Drag to move" style={{ display: "flex", alignItems: "center", gap: 6, cursor: "grab", color: S.fg }}>
            <span style={{ width: 18, height: 18, borderRadius: 999, background: accent, color: "#1a1a1a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800 }}>{icon}</span>
            <span style={{ fontSize: 12.5, fontWeight: 800 }}>{title}</span>
          </span>
          <span style={{ display: "flex", gap: 2, background: dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)", borderRadius: 9, padding: 2 }}>
            <button onClick={() => setMode("read")} style={seg(mode === "read")}>{toggleLabels[0]}</button>
            <button onClick={() => setMode("comment")} style={seg(mode === "comment")}>{toggleLabels[1]}</button>
          </span>
          <button onClick={() => { setListOpen((o) => !o); markSeen(unread.map((c) => c.id)); }} title={unread.length ? `${unread.length} update${unread.length > 1 ? "s" : ""} since you last looked` : `${comments.filter((c) => !isApplied(c)).length} open · ${comments.filter(isApplied).length} applied`}
            style={{ position: "relative", display: "flex", alignItems: "center", gap: 4, background: "transparent", border: `1px solid ${S.border}`, borderRadius: 8, color: S.fgDim, cursor: "pointer", fontSize: 12, padding: "3px 8px" }}>
            🗨 {comments.filter((c) => !isApplied(c)).length}
            {unread.length > 0 && (
              <span style={{ position: "absolute", top: -7, right: -7, minWidth: 16, height: 16, borderRadius: 999, background: accent, color: "#fff", fontSize: 9.5, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 4px", border: "1.5px solid #fff", boxShadow: `0 0 8px ${accent}aa` }}>{unread.length}</span>
            )}
          </button>
          {accessory}
        </div>
      )}

      {/* composer popover — drafts survive closing (0.14.0) */}
      {composer && <Composer label={composer.label} draftKey={composer.node} at={{ x: composer.x, y: composer.y }} S={S} accent={accent} onSubmit={addComment} onCancel={() => setComposer(null)} />}

      {/* 0.14.0 — the anchored thread popover */}
      {thread && (() => {
        const list = byNode.get(thread) ?? [];
        if (!list.length) return null;
        return (
          <ThreadPopover label={list[0]!.label} comments={list} S={S} accent={accent} meta={meta}
            repliesFor={repliesFor} onReply={onReply ? addReply : undefined}
            onAddAnother={() => {
              const el = findNodeEl(thread);
              const r = el?.getBoundingClientRect();
              setComposer({ node: thread, label: list[0]!.label, x: r ? r.left + Math.min(80, r.width / 2) : window.innerWidth / 2, y: r ? r.top + r.height / 2 : window.innerHeight / 2 });
              setThread(null);
            }}
            onClose={() => setThread(null)} />
        );
      })()}

      {/* 0.14.0 — the hover connector: sidebar comment ⇢ its anchor */}
      {listOpen && sideHover && (() => {
        const el = findNodeEl(sideHover.node);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const sbLeft = window.innerWidth - Math.min(340, window.innerWidth * 0.9);
        const offTop = r.bottom < 0, offBottom = r.top > window.innerHeight;
        const y2 = offTop ? 10 : offBottom ? window.innerHeight - 10 : r.top + r.height / 2;
        const x2 = offTop || offBottom ? sbLeft - 60 : Math.min(r.right, sbLeft - 8);
        return (
          <>
            {!offTop && !offBottom && (
              <div style={{ position: "fixed", left: r.left - 3, top: r.top - 3, width: r.width + 6, height: r.height + 6, border: `2px dashed ${accent}`, opacity: 0.6, borderRadius: 6, pointerEvents: "none", zIndex: Z + 2 }} />
            )}
            <svg style={{ position: "fixed", inset: 0, width: "100%", height: "100%", pointerEvents: "none", zIndex: Z + 2 }}>
              <line x1={sbLeft} y1={sideHover.y} x2={x2} y2={y2} stroke={accent} strokeWidth={1.5} strokeDasharray="5 4" opacity={0.55} />
              {(offTop || offBottom) && (
                <path d={offTop ? `M${x2 - 5},${y2 + 8} L${x2},${y2} L${x2 + 5},${y2 + 8}` : `M${x2 - 5},${y2 - 8} L${x2},${y2} L${x2 + 5},${y2 - 8}`} stroke={accent} strokeWidth={1.5} fill="none" opacity={0.7} />
              )}
            </svg>
          </>
        );
      })()}

      {/* sidebar list */}
      {listOpen && <Sidebar comments={comments} title={title} S={S} accent={accent} onClose={() => setListOpen(false)} onDelete={(id) => persist(comments.filter((c) => c.id !== id))} onGoto={gotoNode} meta={meta} renderExtra={renderCommentExtra} footer={sidebarFooter} repliesFor={repliesFor} onReply={onReply ? addReply : undefined} isApplied={isApplied} showApplied={showApplied} onToggleApplied={() => setShowApplied((v) => !v)} onHoverComment={(node, y) => setSideHover(node ? { node, y } : null)} nodeExists={(n) => !!findNodeEl(n)} />}
    </div>,
    document.body,
  );
}

// 0.10.1 — keep a pill inside the viewport. A fixed pill dragged (or left by a
// resize) off-screen is unreachable — you can't scroll to fixed chrome. Clamp so a
// sliver always stays visible and grabbable.
function clampToViewport(p: { x: number; y: number }): { x: number; y: number } {
  if (typeof window === "undefined") return p;
  const { left, top } = clampPillPosition(p.x, p.y, window.innerWidth, window.innerHeight);
  return { x: left, y: top };
}

function startDrag(e: ReactPointerEvent, pos: { x: number; y: number }, setPos: (p: { x: number; y: number }) => void) {
  e.preventDefault();
  const sx = e.clientX, sy = e.clientY, ox = pos.x, oy = pos.y;
  const move = (ev: PointerEvent) => setPos(clampToViewport({ x: ox + ev.clientX - sx, y: oy + ev.clientY - sy }));
  const up = () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); };
  document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
}

function Composer({ label, draftKey, at, S, accent, onSubmit, onCancel }: { label: string; draftKey: string; at: { x: number; y: number }; S: ReturnType<typeof sheetTheme>; accent: string; onSubmit: (t: string) => void; onCancel: () => void }): JSX.Element {
  const [text, setTextRaw] = useState(() => draftFor(draftKey));
  const restored = useRef(!!draftFor(draftKey));
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // focus with the cursor at the END of a restored draft, not the start
  useEffect(() => {
    const ta = taRef.current;
    if (ta) { ta.focus(); const n = ta.value.length; ta.setSelectionRange(n, n); }
  }, []);
  const setText = (t: string) => { setTextRaw(t); saveDraft(draftKey, t); };
  const submit = (t: string) => { saveDraft(draftKey, ""); onSubmit(t); };
  // delete = discard the draft AND close; keeping (with the draft) is the
  // backdrop click — the only two exits, both explicit about the draft's fate.
  const deleteDraft = () => { saveDraft(draftKey, ""); onCancel(); };
  // 0.14.0 — the composer opens WHERE the reviewer clicked (Figma-style), not
  // center-screen; clamped to the viewport, flipping above when near the bottom.
  const W = 300, H = 120;
  const left = Math.max(8, Math.min(at.x, (typeof window !== "undefined" ? window.innerWidth : W) - W - 8));
  const below = at.y + 10;
  const top = typeof window !== "undefined" && below + H > window.innerHeight ? Math.max(8, at.y - H - 10) : below;
  return (
    <div style={{ position: "fixed", inset: 0, background: "transparent", pointerEvents: "auto", zIndex: Z + 5 }} onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} style={{ position: "fixed", left, top, width: W, maxWidth: "92vw", background: S.sheet, color: S.fg, border: `1px solid ${S.border}`, borderRadius: 16, padding: 6, boxShadow: "0 14px 44px rgba(0,0,0,.45)", fontFamily: "system-ui, sans-serif" }}>
        <div style={{ fontSize: 9.5, fontWeight: 700, color: accent, margin: "2px 6px 4px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={label}>{label}{restored.current ? <span style={{ color: S.fgDim, fontWeight: 500 }}> · draft</span> : null}</div>
        <div style={{ position: "relative" }}>
          <textarea ref={taRef} value={text} rows={1} placeholder="Add a comment"
            onChange={(e) => { setText(e.target.value); const t = taRef.current; if (t) { t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 140)}px`; } }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (text.trim()) submit(text); } }}
            style={{ width: "100%", boxSizing: "border-box", fontSize: 12.5, lineHeight: 1.5, padding: "7px 58px 7px 12px", borderRadius: 14, border: `1px solid ${S.inputBorder}`, background: S.input, color: S.fg, fontFamily: "inherit", resize: "none", overflowY: "auto", maxHeight: 140, display: "block" }} />
          <div style={{ position: "absolute", right: 6, bottom: 5, display: "flex", gap: 4 }}>
            {text.trim() && (
              <button onClick={deleteDraft} title="Delete draft & close (click outside keeps it)"
                style={{ width: 22, height: 22, borderRadius: 999, border: "none", background: "transparent", color: S.fgDim, cursor: "pointer", fontSize: 12, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
            )}
            <button onClick={() => submit(text)} disabled={!text.trim()} title="Comment (Enter)"
              style={{ width: 22, height: 22, borderRadius: 999, border: "none", background: text.trim() ? accent : S.inputBorder, color: "#fff", cursor: text.trim() ? "pointer" : "default", fontSize: 12, fontWeight: 800, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>↑</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// 0.14.0 — a small inline reply box (sidebar + thread popover).
function ReplyBox({ S, accent, onSend, draftKey }: { S: ReturnType<typeof sheetTheme>; accent: string; onSend: (t: string) => void; draftKey: string }): JSX.Element {
  const [text, setTextRaw] = useState(() => draftFor(draftKey));
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // grow with content (capped) — a long reply must never scroll out of a
  // single-line box. Enter sends; Shift+Enter makes a new line.
  const autosize = () => {
    const t = taRef.current;
    if (t) { t.style.height = "auto"; t.style.height = `${Math.min(t.scrollHeight, 130)}px`; }
  };
  useEffect(autosize, []);
  const setText = (t: string) => { setTextRaw(t); saveDraft(draftKey, t); };
  const send = () => {
    if (!text.trim()) return;
    onSend(text); setText("");
    const t = taRef.current; if (t) { t.value = ""; t.style.height = "auto"; }
  };
  return (
    <div style={{ position: "relative", marginTop: 6 }}>
      <textarea ref={taRef} value={text} rows={1} placeholder="Reply"
        onChange={(e) => { setText(e.target.value); autosize(); }}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        style={{ width: "100%", boxSizing: "border-box", fontSize: 12, lineHeight: 1.5, padding: "5px 30px 5px 10px", borderRadius: 12, border: `1px solid ${S.inputBorder}`, background: S.input, color: S.fg, fontFamily: "inherit", resize: "none", overflowY: "auto", maxHeight: 130, display: "block" }} />
      <button onClick={send} disabled={!text.trim()} title="Reply (Enter)"
        style={{ position: "absolute", right: 5, bottom: 4, width: 20, height: 20, borderRadius: 999, border: "none", background: text.trim() ? accent : S.inputBorder, color: "#fff", cursor: text.trim() ? "pointer" : "default", fontSize: 11, fontWeight: 800, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>↑</button>
    </div>
  );
}

// 0.14.0 — the anchored thread popover: a marker click reopens the conversation
// for that anchor (comments, status, replies, reply box) instead of routing the
// reviewer to the sidebar.
function ThreadPopover({ label, comments, S, accent, meta, repliesFor, onReply, onAddAnother, onClose }: {
  label: string; comments: ReviewComment[]; S: ReturnType<typeof sheetTheme>; accent: string;
  meta?: Record<string, ReviewCommentMeta>;
  repliesFor: (c: ReviewComment) => { author: string; text: string }[];
  onReply?: (c: ReviewComment, text: string) => void;
  onAddAnother: () => void; onClose: () => void;
}): JSX.Element {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "auto", zIndex: Z + 5 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 400, maxWidth: "92vw", maxHeight: "80vh", overflow: "auto", background: S.sheet, color: S.fg, border: `1px solid ${S.border}`, borderRadius: 9, padding: 9, boxShadow: "0 14px 44px rgba(0,0,0,.45)", fontFamily: "system-ui, sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: accent }}>📍 {label}</span>
          <button onClick={onClose} aria-label="Close thread" style={{ background: "transparent", border: "none", color: S.fgDim, cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
        </div>
        {comments.map((c) => {
          const m = meta?.[c.id];
          return (
            <div key={c.id} style={{ border: `1px solid ${S.border}`, borderRadius: 7, padding: 7, marginBottom: 6 }}>
              <div style={{ fontSize: 13, lineHeight: 1.45 }}><MdLite text={c.text} /></div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 5 }}>
                <span style={{ fontSize: 10, color: S.fgDim }}>@{c.author} · {ago(c.createdAt)}</span>
                {m?.status && <span style={{ fontSize: 9.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.4, padding: "1px 7px", borderRadius: 999, background: m.status === "applied" ? "#1f6f3f" : "rgba(127,127,127,.2)", color: m.status === "applied" ? "#c6f0d4" : S.fgDim }}>{m.status}</span>}
                {(m?.url ?? c.url) && <a href={m?.url ?? c.url} target="_blank" rel="noreferrer" style={{ fontSize: 10.5, color: accent, textDecoration: "none" }}>{typeof c.remoteId === "number" ? `#${c.remoteId} ↗` : "thread ↗"}</a>}
              </div>
              {repliesFor(c).map((r, i) => (
                <div key={i} style={{ borderLeft: `2px solid ${accent}55`, paddingLeft: 8, marginTop: 6, fontSize: 12, lineHeight: 1.45 }}>
                  <span style={{ fontSize: 10, color: S.fgDim }}>@{r.author}</span>
                  <MdLite text={r.text} />
                </div>
              ))}
              {onReply && <ReplyBox S={S} accent={accent} onSend={(t) => onReply(c, t)} draftKey={`reply:${c.id}`} />}
            </div>
          );
        })}
        <button onClick={onAddAnother} style={{ width: "100%", padding: "4px 0", borderRadius: 6, border: `1px dashed ${S.border}`, background: "transparent", color: S.fgDim, cursor: "pointer", fontSize: 11, fontWeight: 600 }}>+ add another</button>
      </div>
    </div>
  );
}

function Sidebar({ comments, title, S, accent, onClose, onDelete, onGoto, meta, renderExtra, footer, repliesFor, onReply, isApplied, showApplied, onToggleApplied, onHoverComment, nodeExists }: { comments: ReviewComment[]; title: string; S: ReturnType<typeof sheetTheme>; accent: string; onClose: () => void; onDelete: (id: string) => void; onGoto: (node: string) => void; meta?: Record<string, ReviewCommentMeta>; renderExtra?: (c: ReviewComment) => ReactNode; footer?: ReactNode; repliesFor: (c: ReviewComment) => { author: string; text: string }[]; onReply?: (c: ReviewComment, text: string) => void; isApplied: (c: ReviewComment) => boolean; showApplied: boolean; onToggleApplied: () => void; onHoverComment?: (node: string | null, y: number) => void; nodeExists?: (node: string) => boolean }): JSX.Element {
  const open = comments.filter((c) => !isApplied(c));
  const applied = comments.filter(isApplied);
  const visible = showApplied ? [...open, ...applied] : open;
  return (
    <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 340, maxWidth: "90vw", background: S.sheet, color: S.fg, borderLeft: `1px solid ${S.border}`, boxShadow: "-12px 0 40px rgba(0,0,0,.4)", pointerEvents: "auto", zIndex: Z + 4, display: "flex", flexDirection: "column", fontFamily: "system-ui, sans-serif", fontSize: 13 }}>
      <div style={{ padding: "13px 16px", borderBottom: `1px solid ${S.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontWeight: 700 }}>{title} comments ({open.length} open{applied.length ? ` · ${applied.length} applied` : ""})</span>
        <button onClick={onClose} aria-label="Close" style={{ background: "transparent", border: "none", color: S.fgDim, cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
      </div>
      <div style={{ overflow: "auto", flex: 1, padding: 10 }}>
        {comments.length === 0 ? (
          <div style={{ padding: 16, opacity: 0.6, textAlign: "center", fontSize: 12 }}>No comments yet. Switch to <b style={{ color: accent }}>Comment</b> and click a labelled part of the page.</div>
        ) : visible.length === 0 ? (
          <div style={{ padding: 16, opacity: 0.6, textAlign: "center", fontSize: 12 }}>All {applied.length} comments applied — nothing open. 🎉</div>
        ) : visible.map((c) => (
          <div key={c.id}
            onMouseEnter={(e) => { if (!nodeExists || nodeExists(c.node)) onHoverComment?.(c.node, (e.currentTarget as HTMLElement).getBoundingClientRect().top + 14); }}
            onMouseLeave={() => onHoverComment?.(null, 0)}
            style={{ background: "rgba(127,127,127,0.06)", border: `1px solid ${S.border}`, borderRadius: 8, padding: 10, marginBottom: 8 }}>
            {nodeExists && !nodeExists(c.node) ? (
              <div title="no element on the page carries this comment's anchor (removed in a later round, or filed page-level) — the thread stays active here" style={{ color: S.fgDim, fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 4 }}>{c.label} <span style={{ fontWeight: 500, textTransform: "none", letterSpacing: 0 }}>· anchorless</span></div>
            ) : (
              <button onClick={() => onGoto(c.node)} style={{ display: "block", textAlign: "left", width: "100%", background: "transparent", border: "none", cursor: "pointer", color: accent, fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3, padding: 0, marginBottom: 4 }}>📍 {c.label}</button>
            )}
            <div style={{ fontSize: 13, color: S.fg, lineHeight: 1.4 }}><MdLite text={c.text} /></div>
            {(() => {
              const m = meta?.[c.id];
              if (!m && !c.url && repliesFor(c).length === 0) return null;
              return (
                <div style={{ marginTop: 6 }}>
                  {(m?.status || c.url || m?.url) && (
                    <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                      {m?.status && <span style={{ fontSize: 9.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.4, padding: "1px 7px", borderRadius: 999, background: m.status === "applied" ? "#1f6f3f" : "rgba(127,127,127,.2)", color: m.status === "applied" ? "#c6f0d4" : S.fgDim }}>{m.status}</span>}
                      {(m?.url ?? c.url) && <a href={m?.url ?? c.url} target="_blank" rel="noreferrer" style={{ fontSize: 10.5, color: accent, textDecoration: "none" }}>{typeof c.remoteId === "number" ? `#${c.remoteId} ↗` : "thread ↗"}</a>}
                    </div>
                  )}
                  {repliesFor(c).map((r, i) => (
                    <div key={i} style={{ borderLeft: `2px solid ${accent}55`, paddingLeft: 8, marginBottom: 5, fontSize: 12, lineHeight: 1.45, color: S.fg }}>
                      <span style={{ fontSize: 10, color: S.fgDim }}>@{r.author}</span>
                      <MdLite text={r.text} />
                    </div>
                  ))}
                </div>
              );
            })()}
            {onReply && <ReplyBox S={S} accent={accent} onSend={(t) => onReply(c, t)} draftKey={`reply:${c.id}`} />}
            {renderExtra?.(c)}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
              <span style={{ fontSize: 10.5, color: S.fgDim }}>@{c.author} · {ago(c.createdAt)}</span>
              <button onClick={() => onDelete(c.id)} style={{ background: "transparent", border: "none", color: S.fgDim, cursor: "pointer", fontSize: 11 }}>Delete</button>
            </div>
          </div>
        ))}
      </div>
      {applied.length > 0 && (
        <button onClick={onToggleApplied}
          style={{ margin: "0 10px 10px", padding: "7px 0", borderRadius: 8, border: `1px dashed ${S.border}`, background: "transparent", color: S.fgDim, cursor: "pointer", fontSize: 11.5, fontWeight: 600 }}>
          {showApplied ? "Hide applied" : `Show ${applied.length} applied`}
        </button>
      )}
      {footer && <div style={{ padding: 12, borderTop: `1px solid ${S.border}` }}>{footer}</div>}
    </div>
  );
}
