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
  /** Extra space (px) reserved below the pill's resting spot — for hosts
   *  with their own fixed bottom chrome (tab bars, docks). Default 0. */
  bottomInset?: number;
  /** What a WHOLE-PAGE comment is called here (dash passes the walk id).
   *  Defaults to the document title. */
  pageLabel?: string;
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
  /** 0.18.0 — a compact SECOND ROW inside the pill (small font, full width).
   *  Keeps the main row narrow on phones; typically a clickable status that
   *  opens a host-rendered palette (the classic pill's EPSS line). */
  statusRow?: ReactNode;
  /** 0.12.0 — transport hook: called when a comment is posted. May return a
   *  remote id/url (e.g. a GitHub issue) merged into the stored comment. */
  onComment?: (c: ReviewComment) => void | Promise<void | { url?: string; remoteId?: string | number }>;
  /** 0.14.0 — reply transport: when provided, every comment (sidebar + the
   *  anchored thread popover) grows a reply box. Replies render optimistically;
   *  the host's transport (e.g. a GitHub issue comment) reconciles via `meta`. */
  onReply?: (c: ReviewComment, text: string) => void | Promise<void>;
  /** 0.14.0 — REMOTE HYDRATION: localStorage is a cache, not the record. When
   *  provided, the shell calls this on mount and every 60s; the returned list
   *  (e.g. parsed from GitHub issues) REPLACES posted comments — so history
   *  survives new browsers/sessions and other reviewers' comments appear
   *  (multi-user review). Local comments not yet posted are preserved. */
  hydrate?: () => Promise<ReviewComment[] | null>;
  /** 0.14.0 — bump to trigger an immediate hydration pull (e.g. on a push
   *  event from a webhook relay); the 60s interval remains the fallback. */
  hydrateKey?: number;
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

/** The slowcook pot — the shell's default pill mark. Monochrome via
 *  currentColor so it follows the pill's theme (day/night) automatically. */
export function SlowcookMark({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-label="slowcook" style={{ display: "block", flexShrink: 0 }}>
      <path d="M8 3 Q9 4 8 5.5 Q7 7 8 8.5 M12 2 Q13 3.5 12 5 Q11 6.5 12 8 M16 3 Q17 4 16 5.5 Q15 7 16 8.5"
        stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none" opacity="0.85" />
      <rect x="4" y="9.5" width="16" height="2.2" rx="1.1" />
      <rect x="11" y="8.4" width="2" height="1.4" rx="0.4" />
      <path d="M5 12.2 H19 V18.5 a2.5 2.5 0 0 1 -2.5 2.5 H7.5 a2.5 2.5 0 0 1 -2.5 -2.5 Z" />
      <rect x="2" y="13.5" width="2.5" height="3" rx="0.6" />
      <rect x="19.5" y="13.5" width="2.5" height="3" rx="0.6" />
    </svg>
  );
}
const Z = 2147483000;
// iOS Safari zooms the page when a focused input's font-size is under 16px
const IOS = typeof navigator !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent);
// touch targets grow on coarse pointers (phones/tablets) — desktop stays compact
const COARSE = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
// ── the status visual language (Amin's review): ONE colour system shared by
// anchors and the sidebar. Local drafts are grey and dashed; applied is
// green; waiting-* is amber; working SWIRLS slowly through colour (never a
// size pulse); filed keeps the accent. Text stays theme-fg — the colour
// rides on borders, dots, and tints, so both day and night stay readable.
const ST_GREEN = "#2e9e5b", ST_AMBER = "#c8871f", ST_GREY = "#8a8a92";
type StatusCue = { color: string; swirl?: boolean; dashed?: boolean; name: string };
function statusCue(status: string | undefined, accent: string, hasRemote: boolean): StatusCue {
  if (!hasRemote) return { color: ST_GREY, dashed: true, name: "local draft" };
  const s = (status ?? "filed").toLowerCase();
  if (s === "applied") return { color: ST_GREEN, name: "applied" };
  if (s === "working") return { color: accent, swirl: true, name: "working" };
  if (s.startsWith("waiting")) return { color: ST_AMBER, name: s };
  if (s === "local only" || s === "not posted") return { color: ST_GREY, dashed: true, name: s };
  return { color: accent, name: s };
}

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
    enabled = true, requireTargets = true, anchorFallback = false, title = "Refine", accent = DASH_CORAL, icon,
    onComment, onReply, hydrate, hydrateKey, meta, renderCommentExtra, sidebarFooter, intro, pageLabel,
    store = localStorageStore("review-shell-comments"),
    corner = "bottom-left", bottomInset = 0, toggleLabels = ["Read", "Comment"],
    anchorAttribute = "data-review-node", labelAttribute = "data-review-label",
    author = "PM", accessory, statusRow,
  } = props;
  const pillRef = useRef<HTMLDivElement | null>(null);
  const dark = usePrefersDark();
  const S = sheetTheme(dark);
  const [comments, setComments] = useState<ReviewComment[]>(() => (typeof window !== "undefined" ? store.load() : []));
  const persist = (next: ReviewComment[]) => { setComments(next); store.save(next); };
  const [mode, setMode] = useState<"read" | "comment">("read");
  const [listOpen, setListOpen] = useState(false);
  const [hover, setHover] = useState<{ rect: DOMRect; label: string; draft?: boolean } | null>(null);
  const [composer, setComposer] = useState<{ node: string; label: string; x: number; y: number; rect?: DOMRect } | null>(null);
  const COMPOSER_KEY = "review-shell-open-composer";
  useEffect(() => {
    try {
      if (composer) sessionStorage.setItem(COMPOSER_KEY, JSON.stringify({ node: composer.node, label: composer.label }));
      else sessionStorage.removeItem(COMPOSER_KEY);
    } catch { /* ignore */ }
  }, [composer]);
  const savedComposer = useRef<{ node: string; label: string } | null>(null);
  if (savedComposer.current === null && typeof sessionStorage !== "undefined") {
    try { savedComposer.current = JSON.parse(sessionStorage.getItem(COMPOSER_KEY) ?? "null") ?? { node: "", label: "" }; } catch { savedComposer.current = { node: "", label: "" }; }
  }
  useEffect(() => {
    const saved = savedComposer.current && savedComposer.current.node ? savedComposer.current : null;
    if (!saved) return;
    let tries = 0;
    const iv = setInterval(() => {
      tries += 1;
      const el = findNodeEl(saved!.node);
      if (el) {
        clearInterval(iv);
        const r = el.getBoundingClientRect();
        setComposer({ node: saved!.node, label: saved!.label, x: r.left + Math.min(80, r.width / 2), y: r.top + r.height / 2, rect: r });
      } else if (tries > 12) clearInterval(iv); // the anchor may be gone for real
    }, 700);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [pagePress, setPagePress] = useState(false);
  const pagePressRef = useRef(false);
  useEffect(() => { pagePressRef.current = pagePress; }, [pagePress]);
  const [tipSeen, setTipSeen] = useState(() => { try { return !!localStorage.getItem("review-shell-tip-seen"); } catch { return true; } });
  // minimise-to-logo (Amin): grip + mark only, mark tinted accent while shrunk
  const [minimized, setMinimized] = useState(false);
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

  // a comment on the WHOLE PAGE (the walk): its node is the location, not
  // an element — it has no marker, and lists in the sidebar by its label.
  const pageNode = () => `page:${typeof location !== "undefined" ? location.pathname + location.hash : "/"}`;
  const openPageComposer = () => {
    setHover(null);
    setComposer({
      node: pageNode(),
      label: pageLabel ?? (typeof document !== "undefined" ? document.title : "the page"),
      x: typeof window !== "undefined" ? window.innerWidth / 2 : 0,
      y: typeof window !== "undefined" ? Math.min(220, window.innerHeight / 3) : 0,
    });
  };

  const sel = `[${anchorAttribute}]`;
  // the shell's own portal AND any host-declared review chrome (dash's EPSS
  // spotlight): comment mode must never eat a click meant for the tooling
  // that opened on top of the page.
  const isSelf = (el: Element | null) => !!el?.closest?.("[data-review-widget],[data-review-chrome]");

  useEffect(() => { installBreadcrumbRecorder(); }, []);
  // Initial pill position: center-stage during the intro, else the chosen corner.
  useEffect(() => {
    if (pos || typeof window === "undefined") return;
    const m = 16, w = 250, h = statusRow ? 74 : 44;
    if (introPhase === "staged") {
      setPos({ x: Math.round(window.innerWidth / 2 - w / 2), y: Math.round(window.innerHeight / 2 - h / 2) });
      return;
    }
    const x = corner.includes("left") ? m : window.innerWidth - w - m;
    const y = corner.includes("top") ? m : window.innerHeight - h - m - bottomInset;
    setPos({ x, y });
  }, [corner, pos, introPhase, bottomInset]);

  // intro choreography: 1s on stage → the meteor strikes (1.05s flight) →
  // a beat to admire → settle to the corner.
  useEffect(() => {
    if (introPhase === "staged") { const t = setTimeout(() => setIntroPhase("strike"), 1000); return () => clearTimeout(t); }
    if (introPhase === "strike") { const t = setTimeout(() => setIntroPhase("settling"), 2400); return () => clearTimeout(t); }
    if (introPhase === "settling") {
      const m = 16, w = 250, h = statusRow ? 74 : 44;
      const x = corner.includes("left") ? m : window.innerWidth - w - m;
      const y = corner.includes("top") ? m : window.innerHeight - h - m - bottomInset;
      setPos({ x, y });
      const t = setTimeout(() => finishIntro(), 800);
      return () => clearTimeout(t);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [introPhase, corner]);

  // Mount-settle clamp (devtools mobile emulation, slow URL-bar viewports):
  // the corner position is computed from a viewport that may still be
  // changing size, and if it settles without firing resize the pill can be
  // born off-screen with nothing to rescue it. Re-clamp shortly after the
  // first position lands.
  const hasPos = pos !== null;
  useEffect(() => {
    if (!hasPos || typeof window === "undefined") return;
    const t1 = setTimeout(() => setPos((p) => (p ? clampToViewport(p) : p)), 350);
    const t2 = setTimeout(() => setPos((p) => (p ? clampToViewport(p) : p)), 1500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPos]);

  // Keep the pill on-screen when the viewport changes (0.10.1; hardened for
  // mobile — rotation and the visual viewport (URL bar, keyboard) don't always
  // fire window.resize, and a pill parked near an edge could end up outside
  // the visible area).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setPos((p) => (p ? clampToViewport(p) : p));
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
    };
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
      const anchoredHit = anchored
        ? { el: anchored, node: anchored.getAttribute(anchorAttribute)!, label: anchored.getAttribute(labelAttribute) || anchored.getAttribute(anchorAttribute)! }
        : null;
      if (!anchorFallback) return anchoredHit;
      // 0.17.0 — PRECISION over containment (Amin: "why can't I point at
      // internal elements?"): with the fallback on, a click INSIDE an
      // anchored zone pins the precise element (a zone-contextualized dom:
      // path); the zone itself only wins when you click its own chrome
      // (header/padding). Semantic pins stay one click away — the zone
      // header is always the zone.
      if (anchoredHit && target !== anchoredHit.el) {
        const box = fallbackContainer(target) as HTMLElement;
        if (box !== anchoredHit.el && anchoredHit.el.contains(box)) {
          return { el: box, node: `dom:${domPath(box)}`, label: `${anchoredHit.label} · ${fallbackLabel(box)}` };
        }
      }
      if (anchoredHit) return anchoredHit;
      const box = fallbackContainer(target) as HTMLElement;
      return { el: box, node: `dom:${domPath(box)}`, label: fallbackLabel(box) };
    };
    // touch anchoring is a PRESS gesture (Amin): a 400ms hold highlights;
    // a moving finger is a SCROLL and must never light components up.
    let pressTimer: number | null = null;
    let pageTimer: number | null = null;
    let pressStart: { x: number; y: number } | null = null;
    const cancelPress = () => {
      if (pressTimer !== null) { clearTimeout(pressTimer); pressTimer = null; }
      if (pageTimer !== null) { clearTimeout(pageTimer); pageTimer = null; }
      pressStart = null;
    };
    const move = (e: PointerEvent) => {
      if (pressStart && (Math.abs(e.clientX - pressStart.x) > 10 || Math.abs(e.clientY - pressStart.y) > 10)) {
        cancelPress();
        if (e.pointerType === "touch") setHover(null);
        setPagePress(false);
      }
      if (e.pointerType === "touch") return; // touch never hover-highlights from movement
      if (isSelf(e.target as Element)) { setHover(null); return; }
      const t = resolve(e.target as Element);
      setHover(t ? { rect: t.el.getBoundingClientRect(), label: t.label, draft: !!draftFor(t.node) } : null);
    };
    const down = (e: PointerEvent) => {
      if (isSelf(e.target as Element)) return;
      if (e.pointerType !== "touch") {
        // a mouse HOLD means the same thing a thumb's hold means
        pressStart = { x: e.clientX, y: e.clientY };
        pageTimer = window.setTimeout(() => { pageTimer = null; setHover(null); setPagePress(true); }, 1000);
        return;
      }
      const target = e.target as Element;
      pressStart = { x: e.clientX, y: e.clientY };
      pressTimer = window.setTimeout(() => {
        pressTimer = null;
        const t = resolve(target);
        setHover(t ? { rect: t.el.getBoundingClientRect(), label: t.label, draft: !!draftFor(t.node) } : null);
      }, 400);
      // held past a second: the press is about the WHOLE PAGE (the walk)
      pageTimer = window.setTimeout(() => {
        pageTimer = null;
        setHover(null);
        setPagePress(true);
      }, 1000);
    };
    const up = () => {
      if (pressTimer !== null) { clearTimeout(pressTimer); pressTimer = null; }
      if (pageTimer !== null) { clearTimeout(pageTimer); pageTimer = null; }
      pressStart = null;
    };
    const click = (e: MouseEvent) => {
      if (isSelf(e.target as Element)) return;
      const t = resolve(e.target as Element);
      if (!t) return;
      e.preventDefault(); e.stopPropagation();
      setHover(null); // one highlight at a time — the composer's rect takes over
      if (pagePressRef.current) { pagePressRef.current = false; setPagePress(false); openPageComposer(); return; }
      // THE MARGIN: what the pointer found is the page, not a thing on it —
      // body/html/#root, or a shell container filling the viewport (every
      // real component is smaller than the whole page).
      const tag = t.el.tagName;
      const r0 = t.el.getBoundingClientRect();
      const fillsPage = r0.width >= window.innerWidth * 0.92 && r0.height >= window.innerHeight * 0.85;
      if (tag === "BODY" || tag === "HTML" || t.el.id === "root" || fillsPage) { openPageComposer(); return; }
      setComposer({ node: t.node, label: t.label, x: e.clientX, y: e.clientY, rect: t.el.getBoundingClientRect() });
    };
    document.addEventListener("pointermove", move, true);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    document.addEventListener("click", click, true);
    return () => { cancelPress(); document.removeEventListener("pointermove", move, true); document.removeEventListener("pointerdown", down, true); document.removeEventListener("pointerup", up, true); document.removeEventListener("pointercancel", up, true); document.removeEventListener("click", click, true); };
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

  // 0.14.0 — unposted comments retry automatically. A comment filed before
  // sign-in (transport had no credential) must never be lost or re-typed:
  // on mount and every 45s, any comment without a remoteId re-runs the host
  // transport; successes patch the store. An in-flight guard prevents
  // double-posting if a retry overlaps a slow first attempt.
  const inflight = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!onComment) return;
    const retry = () => {
      for (const c of store.load()) {
        if (c.remoteId !== undefined || inflight.current.has(c.id)) continue;
        inflight.current.add(c.id);
        void Promise.resolve(onComment(c)).then((ref) => {
          if (ref && (ref.url || ref.remoteId !== undefined)) {
            const next = store.load().map((x) => (x.id === c.id ? { ...x, url: ref.url, remoteId: ref.remoteId } : x));
            store.save(next);
            setComments(next);
          }
        }).catch(() => { /* stays unposted; next tick retries */ }).finally(() => inflight.current.delete(c.id));
      }
    };
    const t = setTimeout(retry, 1500); // after mount settles
    const iv = setInterval(retry, 45_000);
    return () => { clearTimeout(t); clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 0.14.0 — hydrate from the durable store (multi-user, cross-session).
  useEffect(() => {
    if (!hydrate) return;
    let dead = false;
    const pull = async () => {
      const remote = await hydrate().catch(() => null);
      if (!remote || dead) return;
      const local = store.load();
      // GitHub's LIST endpoint is eventually consistent: a just-filed issue
      // can be absent for a minute. Never drop a posted local comment the
      // lagging list hasn't caught up with — union, not replacement.
      const localPostedMissing = local.filter((c) => c.remoteId !== undefined && !remote.some((r) => r.remoteId === c.remoteId));
      const localUnposted = local.filter((c) => c.remoteId === undefined && !remote.some((r) => r.id === c.id));
      const merged = [...remote, ...localPostedMissing, ...localUnposted];
      store.save(merged);
      setComments(merged);
    };
    void pull();
    const iv = setInterval(pull, 60_000);
    return () => { dead = true; clearInterval(iv); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrateKey]);


  // 0.14.0 — keyboard: C toggles comment mode (mnemonic, Gmail/GitHub
  // tradition); Escape peels ONE layer at a time — composer (draft kept) →
  // thread → sidebar → back to read. Letters never fire while typing.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (e.key === "Escape") {
        if (composer) { setComposer(null); return; }           // draft already saved per keystroke
        if (thread) { setThread(null); return; }
        if (listOpen) { setListOpen(false); return; }
        if (mode === "comment") { setMode("read"); return; }
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "c" || e.key === "C") { setMode((m) => (m === "comment" ? "read" : "comment")); }

    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled, mode, composer, thread, listOpen]);


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

  // composer DRAFTS (typed, never sent) are real work — they get their own
  // hollow ✎ anchor and a sidebar section (Amin: drafts must be seen).
  const draftEntries = Object.entries(loadDrafts()).filter(([, txt]) => txt.trim());
  const sidebarDrafts = draftEntries.filter(([node]) => !node.startsWith("reply:")).map(([node, txt]) => {
    const el = findNodeEl(node);
    return { node, text: txt, label: byNode.get(node)?.[0]?.label ?? (el ? fallbackLabel(el) : node) };
  });
  const draftMarkers: { node: string; text: string; x: number; y: number; label: string }[] = [];
  for (const [node, txt] of draftEntries) {
    if (node.startsWith("reply:")) continue; // reply drafts live in their thread
    if (byNode.has(node)) continue; // the node's comment marker already stands
    const el = findNodeEl(node);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    draftMarkers.push({ node, text: txt, x: r.right - 7, y: r.top + 7, label: fallbackLabel(el) });
  }

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

  return createPortal(
    <div data-review-widget="" style={{ position: "fixed", inset: 0, zIndex: Z, pointerEvents: "none" }}>
      <style>{`@keyframes rs-swirl { 0% { filter: hue-rotate(0deg) saturate(1.15); } 50% { filter: hue-rotate(180deg) saturate(1.5); } 100% { filter: hue-rotate(360deg) saturate(1.15); } }`}</style>
      {introPhase === "strike" && pos && (
        <IntroMeteor target={{ x: pos.x + 125, y: pos.y + 22 }} accent={accent} />
      )}
      {/* the CHOSEN anchor stays highlighted while the composer is open */}
      {composer?.rect && (
        <div style={{ position: "fixed", left: composer.rect.left - 3, top: composer.rect.top - 3, width: composer.rect.width + 6, height: composer.rect.height + 6, border: `2px solid ${accent}`, borderRadius: 6, background: `${accent}1f`, pointerEvents: "none", zIndex: Z + 1 }} />
      )}
      {/* the WHOLE-PAGE press: the viewport itself is the anchor */}
      {pagePress && !composer && (
        <div style={{ position: "fixed", inset: 6, border: `2px dashed ${accent}`, borderRadius: 12, background: `${accent}0d`, pointerEvents: "none", zIndex: Z + 1 }}>
          <span style={{ position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)", fontSize: 10, fontWeight: 800, color: "#1a1a1a", background: accent, borderRadius: 4, padding: "2px 8px", whiteSpace: "nowrap" }}>
            💬 the whole page{pageLabel ? ` · ${pageLabel}` : ""}
          </span>
        </div>
      )}
      {/* hover highlight (comment mode) */}
      {mode === "comment" && hover && !composer && (
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
        // no-silent-machine: an anchor whose thread an agent is actively
        // working pulses (status 'working' via meta) — the founder sees the
        // machine moving right where they commented.
        const working = list.some((c) => meta?.[c.id]?.status === "working");
        // APPLIED IS DONE (Amin): an applied anchor leaves the page — no
        // unread-activity exception; "show applied" in the sidebar is the
        // only way it returns. A thread the machine is still working stays.
        if (!showApplied && !working && list.length > 0 && list.every(isApplied)) return null;
        // the anchor's dominant cue: working > waiting > filed > draft > applied
        const cues = list.map((c) => statusCue(meta?.[c.id]?.status, accent, typeof c.remoteId === "number"));
        const cue = cues.find((x) => x.swirl) ?? cues.find((x) => x.color === ST_AMBER) ?? cues.find((x) => !x.dashed && x.color === accent) ?? cues.find((x) => x.dashed) ?? cues[0]!;
        return (
          <button key={m.node} onClick={() => { gotoNode(m.node); setThread(m.node); markSeen(ids); }}
            style={{ position: "fixed", left: m.x, top: m.y, transform: "translate(-50%, -50%)", minWidth: 18, height: 18, padding: "0 5px", borderRadius: 999, background: cue.color, color: "#fff", border: cue.dashed ? "1.5px dashed #fff" : "1.5px solid #fff", fontSize: 9.5, fontWeight: 800, cursor: "pointer", pointerEvents: "auto", zIndex: Z + 1, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: hot ? `0 0 0 3px ${cue.color}66, 0 2px 6px rgba(0,0,0,.35)` : "0 2px 6px rgba(0,0,0,.35)", whiteSpace: "nowrap", animation: cue.swirl ? "rs-swirl 6s linear infinite" : undefined }}
            title={`${m.count} comment${m.count > 1 ? "s" : ""}${hot ? " · new activity" : ""} — click to open the thread`}>{m.count === 1 && typeof list[0]?.remoteId === "number" ? `#${list[0].remoteId}` : m.count}</button>
        );
      })}

      {/* hollow ✎ anchors — composer drafts, typed but never sent */}
      {draftMarkers.map((d) => (
        <button key={`draft-${d.node}`} onClick={() => { gotoNode(d.node); const el = findNodeEl(d.node); const r = el?.getBoundingClientRect(); setComposer({ node: d.node, label: d.label, x: r ? r.left + Math.min(80, r.width / 2) : window.innerWidth / 2, y: r ? r.top + r.height / 2 : window.innerHeight / 2, rect: r ?? undefined }); }}
          title={`draft — typed, not sent: "${d.text.slice(0, 60)}" — click to continue`}
          style={{ position: "fixed", left: d.x, top: d.y, transform: "translate(-50%, -50%)", width: 20, height: 20, borderRadius: 999, background: S.sheet, color: ST_GREY, border: `1.5px dashed ${ST_GREY}`, fontSize: 10, cursor: "pointer", pointerEvents: "auto", zIndex: Z + 1, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 2px 6px rgba(0,0,0,.25)" }}>✎</button>
      ))}
      {/* first time in comment mode: how this works, once, per device */}
      {mode === "comment" && !tipSeen && !composer && (
        <div style={{ position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: COARSE ? 96 : 84, maxWidth: "min(92vw, 420px)", background: S.sheet, color: S.fg, border: `1px solid ${S.border}`, borderRadius: 14, boxShadow: "0 14px 40px rgba(0,0,0,.35)", padding: "10px 12px", zIndex: Z + 6, pointerEvents: "auto", fontFamily: "system-ui, sans-serif", display: "flex", gap: 10, alignItems: "flex-start" }}>
          <span style={{ fontSize: 12.5, lineHeight: 1.5, flex: 1 }}>
            {COARSE ? (
              <>Tap a component to comment on it. Press longer (over a second) to comment on the whole page.</>
            ) : (
              <>Click a component to comment on it. Hold the press, or click the page margin, to comment on the whole page. <b>Esc</b> goes back to read; <b>C</b> toggles comment mode.</>
            )}
          </span>
          <button onClick={() => { setTipSeen(true); try { localStorage.setItem("review-shell-tip-seen", "1"); } catch { /* ignore */ } }}
            aria-label="got it" title="got it"
            style={{ background: accent, color: "#fff", border: "none", borderRadius: 999, padding: COARSE ? "8px 14px" : "4px 10px", fontSize: 11, fontWeight: 800, cursor: "pointer", flexShrink: 0 }}>got it</button>
        </div>
      )}
      {/* the floating pill */}
      {pos && (
        <div ref={pillRef} style={{ position: "fixed", left: pos.x, top: pos.y, display: "flex", flexDirection: "column", padding: "6px 8px 6px 10px", borderRadius: statusRow && !minimized ? 18 : 999, background: S.sheet, border: `1px solid ${S.border}`,
          width: "max-content", maxWidth: "calc(100vw - 24px)",
          boxShadow: introPhase === "strike" ? `0 6px 20px rgba(0,0,0,.35), 0 0 34px 6px ${accent}88` : "0 6px 20px rgba(0,0,0,.35)",
          pointerEvents: "auto", zIndex: Z + 3, fontFamily: "system-ui, sans-serif", userSelect: "none",
          transform: introPhase === "staged" || introPhase === "strike" ? "scale(1.25)" : "scale(1)",
          transition: introPhase === "settling" ? "left .8s cubic-bezier(.22,.8,.36,1), top .8s cubic-bezier(.22,.8,.36,1), transform .8s cubic-bezier(.22,.8,.36,1), box-shadow .8s ease" : introPhase === "strike" ? "box-shadow .25s ease 1s, transform .3s cubic-bezier(.34,1.56,.64,1) 1s" : undefined,
        }} onPointerDownCapture={() => { if (introPhase !== "done") finishIntro(); }}>
          <CometSheen pillRef={pillRef} radius={999} />
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* The overlay pill's dot-grip, ported (Amin: dragging the shell on a
              phone was near-impossible — the title was the only handle). Full
              pill height, tiled dots, touchAction none so a finger drag pans
              the pill instead of the page. */}
          <span
            role="button"
            aria-label="Drag to move"
            title="Drag to move"
            onPointerDown={(e) => startDrag(e, pos, setPos)}
            style={{
              width: 11,
              alignSelf: "stretch",
              minHeight: 22,
              cursor: "grab",
              opacity: 0.5,
              touchAction: "none",
              flexShrink: 0,
              borderRadius: 7,
              color: S.fg,
              backgroundImage: "radial-gradient(currentColor 1.05px, transparent 1.15px)",
              backgroundSize: "5px 5px",
              backgroundPosition: "center",
            }}
          />
          <span onPointerDown={(e) => startDrag(e, pos, setPos)} title="Drag to move" style={{ display: "flex", alignItems: "center", gap: 6, cursor: "grab", color: S.fg }}>
            {/* the slowcook pot is the default mark (Amin: no anonymous red
                dot); a custom icon still gets the accent disc. Clicking the
                mark minimises the pill to grip+logo (logo tinted accent);
                clicking again restores — pointerdown is swallowed so the
                toggle never starts a drag. */}
            <span
              role="button"
              aria-label={minimized ? "Restore the pill" : "Minimise the pill"}
              title={minimized ? "Restore" : "Minimise"}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setMinimized((v) => !v)}
              style={{ cursor: "pointer", display: "flex", alignItems: "center", color: minimized ? accent : undefined }}>
              {icon
                ? <span style={{ width: 18, height: 18, borderRadius: 999, background: accent, color: "#1a1a1a", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800 }}>{icon}</span>
                : <SlowcookMark size={18} />}
            </span>
            {!minimized && <span style={{ fontSize: 12.5, fontWeight: 800 }}>{title}</span>}
          </span>
          {!minimized && <>
          {/* ONE mode button (Amin): shows the CURRENT mode, click to flip.
              Fixed width (sized to the longer label) so the pill never
              resizes; neutral in read, accent-filled in comment. */}
          <button
            onClick={() => setMode(mode === "read" ? "comment" : "read")}
            title={mode === "read" ? `${toggleLabels[1]} mode — C` : `${toggleLabels[0]} mode — Esc`}
            style={{
              width: `calc(${Math.max(...toggleLabels.map((l) => l.length))}ch + 30px)`,
              padding: "4px 10px", borderRadius: 9, fontSize: 12, fontWeight: 700, cursor: "pointer",
              textAlign: "center",
              border: `1px solid ${mode === "comment" ? accent : S.border}`,
              background: mode === "comment" ? accent : (dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.05)"),
              color: mode === "comment" ? "#fff" : S.fgDim,
              transition: "background .12s, color .12s, border-color .12s",
            }}>
            {mode === "read" ? toggleLabels[0] : toggleLabels[1]}
          </button>
          <button onClick={() => { setListOpen((o) => !o); markSeen(unread.map((c) => c.id)); }} title={unread.length ? `${unread.length} update${unread.length > 1 ? "s" : ""} since you last looked` : `${comments.filter((c) => !isApplied(c)).length} open · ${comments.filter(isApplied).length} applied`}
            style={{ position: "relative", display: "flex", alignItems: "center", gap: 4, background: "transparent", border: `1px solid ${S.border}`, borderRadius: 8, color: S.fgDim, cursor: "pointer", fontSize: 12, padding: "3px 8px" }}>
            🗨 {comments.filter((c) => !isApplied(c)).length}
            {unread.length > 0 && (
              <span style={{ position: "absolute", top: -7, right: -7, minWidth: 16, height: 16, borderRadius: 999, background: accent, color: "#fff", fontSize: 9.5, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 4px", border: "1.5px solid #fff", boxShadow: `0 0 8px ${accent}aa` }}>{unread.length}</span>
            )}
          </button>
          {accessory}
          </>}
          </div>
          {statusRow && !minimized && (
            <div style={{ marginTop: 2, paddingTop: 4, borderTop: `1px solid ${S.border}`, fontSize: 10, color: S.fgDim, display: "flex", justifyContent: "center", minWidth: 0, overflow: "hidden" }}>
              {statusRow}
            </div>
          )}
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
              setComposer({ node: thread, label: list[0]!.label, x: r ? r.left + Math.min(80, r.width / 2) : window.innerWidth / 2, y: r ? r.top + r.height / 2 : window.innerHeight / 2, rect: r ?? undefined });
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
      {listOpen && <Sidebar comments={comments} title={title} S={S} accent={accent} onClose={() => setListOpen(false)} drafts={sidebarDrafts} onContinueDraft={(node, label) => { setListOpen(false); gotoNode(node); const el = findNodeEl(node); const r = el?.getBoundingClientRect(); setComposer({ node, label, x: r ? r.left + Math.min(80, r.width / 2) : window.innerWidth / 2, y: r ? r.top + r.height / 2 : window.innerHeight / 2, rect: r ?? undefined }); }} onDeleteDraft={(node) => { saveDraft(node, ""); setTick((n) => n + 1); }} onDelete={(id) => persist(comments.filter((c) => c.id !== id))} onGoto={gotoNode} meta={meta} renderExtra={renderCommentExtra} footer={sidebarFooter} repliesFor={repliesFor} onReply={onReply ? addReply : undefined} isApplied={isApplied} showApplied={showApplied} onToggleApplied={() => setShowApplied((v) => !v)} onHoverComment={(node, y) => setSideHover(node ? { node, y } : null)} nodeExists={(n) => !!findNodeEl(n)} />}
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
  const up = () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); document.removeEventListener("pointercancel", up); };
  document.addEventListener("pointermove", move); document.addEventListener("pointerup", up); document.addEventListener("pointercancel", up);
}

function Composer({ label, draftKey, at, S, accent, onSubmit, onCancel }: { label: string; draftKey: string; at: { x: number; y: number }; S: ReturnType<typeof sheetTheme>; accent: string; onSubmit: (t: string) => void; onCancel: () => void }): JSX.Element {
  const [text, setTextRaw] = useState(() => draftFor(draftKey));
  const restored = useRef(!!draftFor(draftKey));
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // focus with the cursor at the END of a restored draft, not the start
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    // a restored multi-line draft must open FULL-SIZE with the cursor visibly
    // at the end — autosize + scroll-to-bottom + selection, together.
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
    ta.focus();
    const n = ta.value.length;
    ta.setSelectionRange(n, n);
    ta.scrollTop = ta.scrollHeight;
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
            style={{ width: "100%", boxSizing: "border-box", fontSize: IOS ? 16 : 12.5, lineHeight: 1.5, padding: COARSE ? "9px 12px 46px 12px" : "7px 12px 30px 12px", borderRadius: 14, border: `1px solid ${S.inputBorder}`, background: S.input, color: S.fg, fontFamily: "inherit", resize: "none", overflowY: "auto", maxHeight: 180, display: "block" }} />
          <div style={{ position: "absolute", right: 6, bottom: 5, display: "flex", gap: COARSE ? 14 : 4 }}>
            {text.trim() && (
              <button onClick={deleteDraft} title="Delete draft & close (click outside keeps it)"
                style={{ width: COARSE ? 36 : 22, height: COARSE ? 36 : 22, borderRadius: 999, border: "none", background: "transparent", color: S.fgDim, cursor: "pointer", fontSize: COARSE ? 15 : 12, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>✕</button>
            )}
            <button onClick={() => submit(text)} disabled={!text.trim()} title="Comment (Enter)"
              style={{ width: COARSE ? 36 : 22, height: COARSE ? 36 : 22, borderRadius: 999, border: "none", background: text.trim() ? accent : S.inputBorder, color: "#fff", cursor: text.trim() ? "pointer" : "default", fontSize: COARSE ? 15 : 12, fontWeight: 800, lineHeight: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>↑</button>
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
  useEffect(() => {
    autosize();
    const t = taRef.current;
    if (t && t.value) { const n = t.value.length; t.setSelectionRange(n, n); t.scrollTop = t.scrollHeight; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
        style={{ width: "100%", boxSizing: "border-box", fontSize: IOS ? 16 : 12, lineHeight: 1.5, padding: COARSE ? "5px 10px 40px 10px" : "5px 10px 26px 10px", borderRadius: 12, border: `1px solid ${S.inputBorder}`, background: S.input, color: S.fg, fontFamily: "inherit", resize: "none", overflowY: "auto", maxHeight: 160, display: "block" }} />
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

function Sidebar({ comments, title, S, accent, onClose, onDelete, onGoto, meta, renderExtra, footer, repliesFor, onReply, isApplied, showApplied, onToggleApplied, onHoverComment, nodeExists, drafts, onContinueDraft, onDeleteDraft }: { comments: ReviewComment[]; title: string; S: ReturnType<typeof sheetTheme>; accent: string; onClose: () => void; onDelete: (id: string) => void; onGoto: (node: string) => void; meta?: Record<string, ReviewCommentMeta>; renderExtra?: (c: ReviewComment) => ReactNode; footer?: ReactNode; repliesFor: (c: ReviewComment) => { author: string; text: string }[]; onReply?: (c: ReviewComment, text: string) => void; isApplied: (c: ReviewComment) => boolean; showApplied: boolean; onToggleApplied: () => void; onHoverComment?: (node: string | null, y: number) => void; nodeExists?: (node: string) => boolean; drafts?: { node: string; label: string; text: string }[]; onContinueDraft?: (node: string, label: string) => void; onDeleteDraft?: (node: string) => void }): JSX.Element {
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
            style={(() => { const cue = statusCue(meta?.[c.id]?.status, accent, typeof c.remoteId === "number"); return { background: "rgba(127,127,127,0.06)", border: `1px solid ${S.border}`, borderLeft: `3px ${cue.dashed ? "dashed" : "solid"} ${cue.color}`, borderRadius: 8, padding: 10, marginBottom: 8 }; })()}>
            {nodeExists && !nodeExists(c.node) ? (
              <div title="no element on the page carries this comment's anchor (removed in a later round, or filed page-level) — the thread stays active here" style={{ color: S.fgDim, fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 4 }}>{c.label} <span style={{ fontWeight: 500, textTransform: "none", letterSpacing: 0 }}>· anchorless</span></div>
            ) : (
              <button onClick={() => onGoto(c.node)} style={{ display: "block", textAlign: "left", width: "100%", background: "transparent", border: "none", cursor: "pointer", color: accent, fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3, padding: 0, marginBottom: 4 }}>📍 {c.label}</button>
            )}
            <div style={{ fontSize: 13, color: S.fg, lineHeight: 1.4 }}><MdLite text={c.text} /></div>
            {c.remoteId === undefined && !meta?.[c.id]?.status && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, marginTop: 6, fontSize: 9.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.4, padding: "1px 8px", borderRadius: 999, background: `${ST_GREY}26`, color: S.fg }}>
                <span style={{ width: 7, height: 7, borderRadius: 999, background: ST_GREY }} />local draft
              </span>
            )}
            {(() => {
              const m = meta?.[c.id];
              if (!m && !c.url && repliesFor(c).length === 0) return null;
              return (
                <div style={{ marginTop: 6 }}>
                  {(m?.status || c.url || m?.url) && (
                    <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                      {m?.status && (() => { const cue = statusCue(m.status, accent, typeof c.remoteId === "number"); return (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 9.5, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.4, padding: "1px 8px", borderRadius: 999, background: `${cue.color}26`, color: S.fg }}>
                          <span style={{ width: 7, height: 7, borderRadius: 999, background: cue.color, animation: cue.swirl ? "rs-swirl 6s linear infinite" : undefined }} />{cue.name}
                        </span>
                      ); })()}
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
              {c.remoteId === undefined && <button onClick={() => onDelete(c.id)} style={{ background: "transparent", border: `1px solid ${S.border}`, borderRadius: 8, color: S.fgDim, cursor: "pointer", fontSize: 11, padding: COARSE ? "8px 16px" : "2px 8px", marginLeft: COARSE ? 12 : 6 }}>Delete</button>}
            </div>
          </div>
        ))}
      </div>
      {drafts && drafts.length > 0 && (
        <div style={{ padding: "0 10px 8px" }}>
          <div style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.4, color: S.fgDim, margin: "2px 0 6px" }}>Drafts — typed, not sent</div>
          {drafts.map((d) => (
            <div key={d.node} style={{ background: "rgba(127,127,127,0.06)", border: `1px dashed ${ST_GREY}`, borderLeft: `3px dashed ${ST_GREY}`, borderRadius: 8, padding: 8, marginBottom: 6 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3, color: S.fgDim, marginBottom: 3 }}>✎ {d.label}</div>
              <div style={{ fontSize: 12, color: S.fg, fontStyle: "italic", opacity: 0.85, lineHeight: 1.4, marginBottom: 5 }}>{d.text.slice(0, 120)}{d.text.length > 120 ? "…" : ""}</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => onContinueDraft?.(d.node, d.label)} style={{ background: "transparent", border: `1px solid ${S.border}`, borderRadius: 8, color: accent, cursor: "pointer", fontSize: 11, padding: COARSE ? "8px 16px" : "2px 8px" }}>Continue</button>
                <button onClick={() => onDeleteDraft?.(d.node)} style={{ background: "transparent", border: `1px solid ${S.border}`, borderRadius: 8, color: S.fgDim, cursor: "pointer", fontSize: 11, padding: COARSE ? "8px 16px" : "2px 8px" }}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
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
