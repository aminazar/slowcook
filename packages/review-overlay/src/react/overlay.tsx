/**
 * <SlowcookReviewOverlay /> — 0.16.0-α.6.
 *
 * Mounted into the consumer's mock-app root layout. Renders a floating
 * mode toggle (review / approve). 0.8.0 — in a review session the page
 * navigates freely; the reviewer arms a single element-pick ("📍 Pin a
 * comment") and the next click captures a selector + bbox + viewport
 * metadata; the user types prose and submits to the mockup PR via PAT.
 *
 * Bundle weight is paid only when consumers mount it. The mock app
 * scaffolded by `slowcook init mock` includes a code-comment placeholder
 * but does NOT mount the overlay; consumers opt in by editing
 * mock/src/app/layout.tsx after installing this package.
 *
 * Architecture:
 *  - Pure-React inline UI (no portal needed; the overlay's own
 *    fixed-position root sits above body)
 *  - Selector + comment-format + github logic lives in the framework-
 *    free modules in this package; the React shell wires events
 *  - Tailwind-style classes inlined — but every visible style is also
 *    set via `style={...}` so the overlay renders even without
 *    Tailwind in the host app
 */

"use client";

import { useEffect, useState, useRef, useCallback, createElement, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { extractSelector, resolveAnchor, isPillOffViewport, clampPillPosition } from "../selector.js";
import { CometSheen } from "./comet.js";
import {
  buildPayload,
  formatReviewComment,
  formatLcrIssue,
  type ViewportInfo,
  type ReviewCommentPayload,
  type SurfaceContext,
} from "../comment-format.js";
import {
  loadPat,
  savePat,
  submitComment,
  createIssue,
  fetchOverlayComments,
  fetchLcrIssues,
  loadCachedComments,
  saveCachedComments,
  fetchPrLabels,
  addLabelsToPr,
  submitPrApproval,
  fetchDocFile,
  commitDocFile,
  APPROVED_LABEL,
  type RepoCoord,
  type OverlayCommentRecord,
  type DocFile,
} from "../github.js";
import { renderMarkdown } from "./markdown.js";
import { usePrefersDark, detectPageDark, pillTheme, sheetTheme, type PillTheme, type SheetTheme } from "./theme.js";
import {
  loadReviewerToken,
  loadReviewerIdentity,
  saveReviewerToken,
  saveReviewerIdentity,
  clearReviewerSession,
  runDeviceLogin,
  identifyReviewer,
  checkRepoWriteAccess,
  type StoredReviewerIdentity,
} from "../reviewer-session.js";
import { isResolvedStatus } from "../comment-format.js";
import { readCurrentStory } from "./use-story-marker.js";
import { loadManifest, applySelection, getSelection, liveSurfaceLabel, activeHint, type Manifest } from "../testing-surfaces.js";

/**
 * Collect the full review CONTEXT so EVERY comment — element-anchored or
 * page-level (general) — carries the EPSS state + crumb and the UI language.
 * colorScheme (dark/light) + viewport size (mobile/desktop) ride along in
 * `viewport`. Lets plate act without guessing the conditions.
 */
function collectReviewContext(manifest: Manifest | null): { surface: SurfaceContext | null; lang: string | undefined } {
  const s = getSelection();
  const surface: SurfaceContext | null = s
    ? { epicId: s.epicId, contextId: s.contextId, scenarioId: s.scenarioId, stateId: s.stateId, crumb: liveSurfaceLabel(manifest, s, window.location.pathname) ?? "" }
    : null;
  const lang = (typeof document !== "undefined" && document.documentElement.lang) || undefined;
  return { surface, lang };
}

export interface SlowcookReviewOverlayProps {
  /**
   * GitHub owner. Optional — falls back to
   * `process.env.NEXT_PUBLIC_SLOWCOOK_OWNER`. Set explicitly when
   * mounting the overlay outside of `slowcook run-mock`.
   */
  owner?: string;
  /** GitHub repo. Falls back to `NEXT_PUBLIC_SLOWCOOK_REPO`. */
  repo?: string;
  /**
   * Pull-request number for the mockup PR. Falls back to
   * `parseInt(NEXT_PUBLIC_SLOWCOOK_PR_NUMBER)`.
   */
  prNumber?: number;
  /** Story id; falls back to `NEXT_PUBLIC_SLOWCOOK_STORY_ID`. */
  storyId?: string | null;
  /**
   * Render only when truthy. Falls back to
   * `NEXT_PUBLIC_SLOWCOOK_REVIEW === "1"` so production builds
   * tree-shake the overlay out cleanly.
   */
  enabled?: boolean;
  /**
   * 0.6.0 — review surface shape. Falls back to
   * `NEXT_PUBLIC_SLOWCOOK_REVIEW_MODE` (default `"scenarios"`).
   *
   *  - `"scenarios"` (legacy): the mock is a scenario picker at `/`; the
   *    overlay hides on the `/` route (commenting there is noise).
   *  - `"lcr"`: the mock is a full navigable Living Coded Requirement
   *    with its own router. The overlay shows on EVERY route (incl. `/`)
   *    so the reviewer can roam the whole app and comment anywhere; each
   *    comment captures its route so plate can amend per-page.
   */
  reviewMode?: "scenarios" | "lcr";
  /**
   * 0.6.0 — base URL of the box-hosted reviewer auth-helper (run-mock's
   * device-flow endpoints). Falls back to `NEXT_PUBLIC_SLOWCOOK_AUTH_BASE`.
   * Only used in `lcr` mode; enables per-reviewer "Sign in with GitHub".
   */
  authBase?: string;
  /**
   * 0.16.0 — Ask co-pilot: base URL of the Claude-agent chat backend (an SSE
   * endpoint that streams a per-reviewer agent session). Falls back to
   * `NEXT_PUBLIC_SLOWCOOK_ASK_BASE`. Empty hides the Ask tab. The panel reuses
   * the reviewer's device-flow token as the Bearer credential, so the backend
   * gates on GitHub identity.
   */
  askBase?: string;
  /** Overlay package version, included in the JSON payload. */
  overlayVersion?: string;
  /**
   * 0.7.0 — docs studio: the spine markdown docs a reviewer can read + edit as
   * the "textual" half of review. Falls back to `NEXT_PUBLIC_SLOWCOOK_DOC_PATHS`
   * (comma-separated). Default: the common GUCDI docs. Empty disables Docs mode.
   */
  docPaths?: string[];
  /**
   * 0.7.0 — the working branch a doc "scope change" commits to (where the PR
   * lives). Falls back to `NEXT_PUBLIC_SLOWCOOK_BRANCH`, then the repo default.
   */
  branch?: string;
  /**
   * 0.7.1 — review surfaces: named entry points (personas/sections) the mock
   * exposes, so the floating pane can offer a "Viewing as" switcher to roam
   * them. This is a REVIEW affordance — a real user is one role; only a reviewer
   * hops between surfaces — so it lives here, not in the product mock. Falls back
   * to `NEXT_PUBLIC_SLOWCOOK_SURFACES` (JSON). Empty hides the switcher.
   */
  surfaces?: ReviewSurface[];
  /**
   * 0.9.0 — URL of a `testing-surfaces.json` manifest (epic ▸ context ▸ scenario
   * ▸ state). When set, the pill grows an EPSS router IN review mode (a 2×2
   * dropdown) and shows a tiny PSS breadcrumb in nav mode. Picking a state writes
   * the resolved selection to localStorage (`slowcook_test_surface`) for the
   * mock's data-adaptor + navigates. Falls back to `NEXT_PUBLIC_SLOWCOOK_SURFACES_URL`.
   * Empty disables the router.
   */
  testingSurfacesUrl?: string;
  /**
   * Pill extension slot — arbitrary consumer-provided content rendered INSIDE the
   * floating pill, always visible (both nav + comment modes). The overlay stays
   * generic: it owns the pill chrome; the consumer owns what goes in the slot. dash
   * uses it for the premium work-session timer, so there's a single pill rather than
   * a second floating control. Keep slot content compact (it shares the pill's row).
   */
  accessory?: ReactNode;
}

export interface ReviewSurface {
  label: string;
  home: string; // route to navigate to
  icon?: string;
  blurb?: string;
}

type Mode = "nav" | "comment" | "approve";

const ACCENT = "#FF6B6B";
const APPROVED_GREEN = "#22c55e";

// 0.7.3 — the in-shadow-root CSS firewall. `all: initial` on :host severs
// every inherited property the host page would otherwise leak in (font,
// color, letter-spacing, text-transform…), then we re-establish a neutral
// base. `direction`/`unicode-bidi` are the two properties `all` deliberately
// skips, so they're set explicitly — this is what un-mirrors the toolbar on
// RTL hosts. Selector-based host rules (the `*{}` reset, `button{}` styles)
// can't cross the shadow boundary at all, so box-sizing/margin/padding are
// already safe without listing them here.
const SHADOW_RESET_CSS =
  `:host{all:initial;direction:ltr;unicode-bidi:isolate;` +
  `font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;` +
  `font-size:14px;line-height:1.4;color:#1a1a1a;}` +
  `:host *,:host *::before,:host *::after{box-sizing:border-box;}`;

/**
 * Safe NEXT_PUBLIC_* reader. Props are the PRIMARY config; these env vars are an
 * optional fallback for Next.js consumers (which inline NEXT_PUBLIC_* at build).
 * The overlay is framework-agnostic — Vite/React/plain-browser mocks have no
 * `process`, so the read is guarded (never throws "process is not defined"); they
 * pass config via props instead. 0.9.6.
 */
function env(key: string): string | undefined {
  try {
    return typeof process !== "undefined" && process.env ? process.env[key] : undefined;
  } catch {
    return undefined;
  }
}

export function SlowcookReviewOverlay(props: SlowcookReviewOverlayProps): JSX.Element | null {
  // 0.5.1 — optional auto-detect from NEXT_PUBLIC_SLOWCOOK_* (Next.js consumers).
  // Framework-agnostic via env() (0.9.6); non-Next mocks pass props explicitly.
  const owner = props.owner ?? env("NEXT_PUBLIC_SLOWCOOK_OWNER") ?? "";
  const repo = props.repo ?? env("NEXT_PUBLIC_SLOWCOOK_REPO") ?? "";
  const prNumber = props.prNumber ?? parseInt(env("NEXT_PUBLIC_SLOWCOOK_PR_NUMBER") ?? "0", 10);
  const storyId = props.storyId ?? env("NEXT_PUBLIC_SLOWCOOK_STORY_ID") ?? null;
  const enabled = props.enabled ?? (env("NEXT_PUBLIC_SLOWCOOK_REVIEW") === "1");
  const reviewMode: "scenarios" | "lcr" =
    props.reviewMode ??
    (env("NEXT_PUBLIC_SLOWCOOK_REVIEW_MODE") === "lcr" ? "lcr" : "scenarios");
  // 0.6.0 — LCR multi-person review: box-hosted device-flow helper base URL.
  const authBase = props.authBase ?? env("NEXT_PUBLIC_SLOWCOOK_AUTH_BASE") ?? "";
  const askBase = props.askBase ?? env("NEXT_PUBLIC_SLOWCOOK_ASK_BASE") ?? "";
  const overlayVersion = props.overlayVersion ?? "0.6.0";
  const repoCoord: RepoCoord = { owner, repo };
  // 0.7.0 — docs studio config.
  const docPaths: string[] = props.docPaths ??
    (env("NEXT_PUBLIC_SLOWCOOK_DOC_PATHS")?.split(",").map((s) => s.trim()).filter(Boolean)) ??
    ["docs/PRD.md", "docs/ROADMAP.md", "docs/USER_STORIES.md", "docs/ARCHITECTURE.md"];
  const branchProp = props.branch ?? env("NEXT_PUBLIC_SLOWCOOK_BRANCH") ?? "";
  // 0.7.1 — review surfaces (persona switcher lives in the pane, not the mock).
  const surfaces: ReviewSurface[] = props.surfaces ?? (() => {
    try { const raw = env("NEXT_PUBLIC_SLOWCOOK_SURFACES"); return raw ? (JSON.parse(raw) as ReviewSurface[]) : []; }
    catch { return []; }
  })();
  // 0.9.0 — EPSS testing-surface router manifest.
  const testingSurfacesUrl: string =
    props.testingSurfacesUrl ?? env("NEXT_PUBLIC_SLOWCOOK_SURFACES_URL") ?? "";
  const [surfaceManifest, setSurfaceManifest] = useState<Manifest | null>(null);
  useEffect(() => {
    if (testingSurfacesUrl) loadManifest(testingSurfacesUrl).then(setSurfaceManifest).catch(() => { /* ignore */ });
  }, [testingSurfacesUrl]);

  // 0.5.1 — hydration-mismatch fix. The overlay can't render during
  // SSR (no localStorage, no window.matchMedia, no DOM), so it returns
  // null. But on first client render it would normally render the
  // pill — and React's hydrator complains the server (null) and
  // client (overlay) HTML don't match.
  // Standard fix: gate on a `mounted` flag set in useEffect. First
  // client render returns null too (matching server), then a
  // re-render after mount shows the overlay. Removes the dev-tools
  // "1 issue" warning consumers were seeing.
  const [mounted, setMounted] = useState<boolean>(false);
  useEffect(() => { setMounted(true); }, []);

  // 0.7.3 — Shadow-DOM style firewall. The overlay used to render straight
  // into the host's DOM, so the host's *global* CSS bled in: a universal
  // reset (`*{box-sizing;margin:0;padding:0}`) collapsed the disk's geometry,
  // and an RTL host (`body{direction:rtl}`, e.g. a Persian app) mirrored the
  // toolbar + inverted the grip's right-anchored drag math — the disk "lost
  // its shape" and couldn't be grabbed. We now mount the whole UI inside a
  // shadow root on a body-level host element, so selector-based host CSS
  // (resets, button styles) physically can't reach in. Inherited properties
  // (direction/font/color) still cross the boundary, so the in-root reset
  // (SHADOW_RESET_CSS) re-establishes them — note `all: initial` does NOT
  // cover `direction`/`unicode-bidi`, hence the explicit `direction: ltr`.
  // The host element carries no transform/filter, so position:fixed children
  // still resolve to the viewport. Comment-mode still queries the host
  // document directly — the shadow only encapsulates the overlay's own UI.
  const [shadowRoot, setShadowRoot] = useState<ShadowRoot | null>(null);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const host = document.createElement("div");
    host.setAttribute("data-slowcook-overlay-host", "");
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    setShadowRoot(root);
    return () => { host.remove(); };
  }, []);

  // Hooks must run unconditionally — render the null AFTER all hooks
  // are declared. Bails early during SSR via the typeof window check.
  const [mode, setMode] = useState<Mode>("nav");
  const [target, setTarget] = useState<Element | null>(null);
  // 0.6.5 — element under the cursor in comment mode (green hover preview).
  const [hoverEl, setHoverEl] = useState<Element | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  // 0.8.0 — free-nav: in comment mode the page navigates normally. The reviewer
  // ARMS a single element-pick ("📍 Pin a comment"); only while armed does the
  // overlay intercept the next click. After the pick (or cancel) it disarms, so
  // navigation is never trapped — and there's an on-screen cancel for mobile
  // (no Escape key). See the capture effect below.
  const [armed, setArmed] = useState<boolean>(false);
  // 0.5.0 — comments-list panel state. Opened by the "📋" button in
  // the pill OR by clicking the count badge on the Comment toggle.
  // Surfaces ALL comments — including ones whose anchor element is
  // hidden in the current view + general (no-anchor) ones.
  const [listPanelOpen, setListPanelOpen] = useState<boolean>(false);
  // 0.5.0 — general comment composer. Distinct from the element-
  // anchored composer (which needs a target element + bbox).
  const [generalComposerOpen, setGeneralComposerOpen] = useState<boolean>(false);
  // When set, scroll the corresponding pin into view + flash it.
  const [flashCommentId, setFlashCommentId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [approveConfirmOpen, setApproveConfirmOpen] = useState(false);
  // 0.6.0 — LCR multi-person review: who's signed in (this browser) + the
  // device-flow login dialog state. Comments post as this reviewer.
  const [reviewerIdentity, setReviewerIdentity] = useState<StoredReviewerIdentity | null>(null);
  const [login, setLogin] = useState<{ open: boolean; userCode?: string; verificationUri?: string; status: string; error?: string }>({ open: false, status: "" });
  const loginAbort = useRef(false);
  // 0.6.0 — "show already-applied" toggle for the comments list. Resolved
  // comments (applied/declined/noop) hide by default; needs-clarification +
  // unresolved always show.
  const [showApplied, setShowApplied] = useState<boolean>(false);
  // 0.7.0 — docs studio (textual review): panel open + the resolved working
  // branch a scope-change commits to.
  const [docsPanelOpen, setDocsPanelOpen] = useState<boolean>(false);
  const [resolvedBranch, setResolvedBranch] = useState<string>(branchProp);
  // 0.16.0 — Ask co-pilot chat panel open state.
  const [askPanelOpen, setAskPanelOpen] = useState<boolean>(false);
  // 0.2.0 — track viewport width for the icon-only mobile collapse + the
  // picker-route hide. Updates on resize + initial mount.
  const [isMobile, setIsMobile] = useState<boolean>(false);
  const [isPickerRoute, setIsPickerRoute] = useState<boolean>(false);
  const composerRef = useRef<HTMLDivElement | null>(null);
  // 0.3.0 — comment pins. Existing comments fetched from the PR + their
  // plate replies. Cached in localStorage so the layer renders fast on
  // refresh; background-refresh on focus.
  const [comments, setComments] = useState<OverlayCommentRecord[]>([]);
  const [openCommentId, setOpenCommentId] = useState<number | null>(null);
  // 0.6.8 — "new activity" badge: track which comment states the reviewer has
  // already seen, so new replies / newly-applied resolutions ping the Comment
  // button with a green count. Signature = id + reply status + reply length.
  const seenKey = `slowcook.review-overlay.seen.${owner}/${repo}`;
  const [seenSigs, setSeenSigs] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(window.localStorage.getItem(seenKey) ?? "[]") as string[]); }
    catch { return new Set(); }
  });
  const sigOf = (r: OverlayCommentRecord) =>
    `${r.commentId}:${r.plateReply?.status ?? ""}:${(r.plateReply?.summary ?? "").length}`;
  // 0.6.10 — only an AGENT action is an "event": a reply comment (plateCommentUrl)
  // or a resolution (applied). A reviewer's own freshly-filed comment (open issue,
  // no reply) is NOT an event — it shouldn't ping their own badge.
  const isAgentEvent = (r: OverlayCommentRecord) =>
    r.plateReply != null && (r.plateReply.status === "applied" || !!r.plateCommentUrl);
  const newCount = comments.filter((r) => isAgentEvent(r) && !seenSigs.has(sigOf(r))).length;
  const markAllSeen = useCallback(() => {
    const sigs = comments.map(sigOf);
    setSeenSigs(new Set(sigs));
    try { window.localStorage.setItem(seenKey, JSON.stringify(sigs)); } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comments]);
  // 0.4.2 — approved state. True when the PR carries the
  // slowcook-mockup-approved label; pill renders green-tinted +
  // hides the Approve button. Nav + Comment still work for follow-up
  // discussion (plate refuses to amend either way).
  const [isApproved, setIsApproved] = useState<boolean>(false);

  // Lock page scroll while a composer or thread popover is open. Those boxes
  // (and the element highlight) are positioned once at open time, so a scroll
  // would leave them behind — easy to lose on mobile. Freezing the page keeps
  // the box and its highlight together until the reviewer is done.
  useEffect(() => {
    const locked = composerOpen || generalComposerOpen || openCommentId !== null;
    if (!locked || typeof document === "undefined") return;
    const body = document.body;
    const prevOverflow = body.style.overflow;
    const prevTouch = body.style.touchAction;
    body.style.overflow = "hidden";
    body.style.touchAction = "none";
    return () => { body.style.overflow = prevOverflow; body.style.touchAction = prevTouch; };
  }, [composerOpen, generalComposerOpen, openCommentId]);

  // 0.7.0 — resolve the working branch for doc scope-changes. Prefer the
  // configured branch; else the head branch of the open mockup PR; else the
  // repo default. Runs once in lcr mode when no branch was provided.
  useEffect(() => {
    if (typeof window === "undefined" || reviewMode !== "lcr" || branchProp || !owner || !repo) return;
    let alive = true;
    (async () => {
      const base = getProxyApiBase() ?? "https://api.github.com";
      try {
        const r = await fetch(`${base}/repos/${owner}/${repo}`, { headers: { Accept: "application/vnd.github+json" } });
        if (r.ok && alive) { const j = (await r.json()) as { default_branch?: string }; if (j.default_branch) setResolvedBranch(j.default_branch); }
      } catch { /* offline / rate-limited — Docs read falls back to default ref */ }
    })();
    return () => { alive = false; };
  }, [reviewMode, branchProp, owner, repo]);

  // Mount-time + on-focus fetch of overlay comments / LCR issues.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!enabled || !owner || !repo) return;

    // 0.6.4 — lcr mode: comments are `lcr-review` ISSUES, retrieved with the
    // signed-in reviewer's token. Closed issues = applied (hidden behind the
    // "show already-applied" toggle); open = shown. Without a token (not signed
    // in yet) there's nothing to read on a private repo — refetches after login
    // via the reviewerIdentity dep.
    if (reviewMode === "lcr") {
      const cached = loadCachedComments(window.localStorage, { owner, repo }, 0);
      if (cached) setComments(cached);
      const refresh = () => {
        const token = loadReviewerToken(window.localStorage, { owner, repo });
        if (!token) return;
        void fetchLcrIssues({ owner, repo, token })
          .then((records) => {
            setComments(records);
            saveCachedComments(window.localStorage, { owner, repo }, 0, records);
          })
          .catch(() => { /* silent — cached state still renders */ });
      };
      refresh();
      const onFocus = () => refresh();
      window.addEventListener("focus", onFocus);
      return () => window.removeEventListener("focus", onFocus);
    }

    // scenarios mode — the pin layer reads PR comments (needs a PR).
    if (!prNumber) return;
    const cached = loadCachedComments(window.localStorage, { owner, repo }, prNumber);
    if (cached) setComments(cached);
    const refresh = () => {
      const proxy = getProxyApiBase();
      const pat = proxy ? PROXY_PAT_SENTINEL : loadPat(window.localStorage, { owner, repo });
      if (!pat) return;
      const apiBase = proxy ?? undefined;
      void fetchOverlayComments({ owner, repo, pr: prNumber, pat, apiBase })
        .then((records) => {
          setComments(records);
          saveCachedComments(window.localStorage, { owner, repo }, prNumber, records);
        })
        .catch(() => { /* silent — cached state still renders */ });
      // 0.4.2 — fetch labels too so we can render the approved state.
      void fetchPrLabels({ owner, repo, pr: prNumber, pat, apiBase })
        .then((labels) => setIsApproved(labels.includes(APPROVED_LABEL)))
        .catch(() => { /* silent */ });
    };
    refresh();
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, owner, repo, prNumber, reviewMode, reviewerIdentity]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(max-width: 640px)");
    const apply = () => setIsMobile(mql.matches);
    apply();
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, []);

  // 0.6.0 — restore a prior reviewer session (lcr mode).
  useEffect(() => {
    if (typeof window === "undefined" || reviewMode !== "lcr") return;
    setReviewerIdentity(loadReviewerIdentity(window.localStorage, { owner, repo }));
  }, [reviewMode, owner, repo]);

  // 0.8.1 — open the sign-in dialog. It always offers the classic-PAT path
  // (deterministic auth instructions live there), plus device-flow when an
  // authBase helper is configured. `error` shows a contextual reason (e.g. a
  // 403 from an org's OAuth-App restriction) above the instructions.
  const openLogin = useCallback((error?: string) => {
    setLogin({ open: true, status: "", error });
  }, []);

  // 0.8.1 — classic-PAT sign-in. The reliable path for PRIVATE repos and orgs
  // that restrict OAuth Apps: a classic PAT is not an OAuth App, so the org's
  // "OAuth App access restrictions" don't block it, and the `repo` scope covers
  // private repos (the device-flow app only gets public_repo). Validates the
  // token, derives identity + write-access tier, stores it like a device token.
  const signInWithPat = useCallback(async (tokenRaw: string) => {
    const token = tokenRaw.trim();
    if (!token) return;
    setLogin((l) => ({ ...l, status: "Checking token…", error: undefined }));
    try {
      const base = await identifyReviewer(token);
      const canApply = await checkRepoWriteAccess(token, { owner, repo });
      const id = { ...base, canApply };
      saveReviewerToken(window.localStorage, { owner, repo }, token);
      saveReviewerIdentity(window.localStorage, { owner, repo }, id);
      setReviewerIdentity(id);
      setLogin({ open: false, status: "" });
      setFeedback(canApply
        ? `Signed in as @${id.login} — your comments are applied.`
        : `Signed in as @${id.login} — your feedback goes to the team for review.`);
    } catch (e) {
      setLogin((l) => ({ ...l, status: "", error: `That token didn't work (${e instanceof Error ? e.message : String(e)}). Use a CLASSIC token with the \`repo\` scope.` }));
    }
  }, [owner, repo]);

  // 0.8.1 — a write failure that's really an auth problem (401/403/404 — bad
  // token, org OAuth-App restriction, or a private repo the token can't see)
  // routes to the sign-in dialog with a deterministic explanation, instead of a
  // dead-end toast. Other failures still toast.
  // The shared reviewer token (used by BOTH comments and the Docs studio) is dead.
  // Clear the whole session — token AND the cached identity — so the overlay shows
  // "signed out" CONSISTENTLY everywhere (not signed-in in the pill but rejected in
  // Docs), then open the login dialog. One re-sign-in restores everything.
  const expireSession = useCallback((reason?: string) => {
    if (typeof window !== "undefined") clearReviewerSession(window.localStorage, { owner, repo });
    setReviewerIdentity(null);
    openLogin(reason ?? "Your GitHub session expired — sign in again.");
  }, [owner, repo, openLogin]);

  const reportFailure = useCallback((status: number | undefined, message: string | undefined, prefix: string) => {
    // 401 "Bad credentials" = the token itself is invalid (expired) → expire the
    // shared session. 403/404 can be OAuth-restriction / private-repo, not a dead
    // token — route to sign-in without clearing.
    if (status === 401) expireSession(describeAuthError(status, message, { owner, repo }));
    else if (status === 403 || status === 404) openLogin(describeAuthError(status, message, { owner, repo }));
    else setFeedback(`${prefix}: ${status ?? "?"} ${message ?? ""}`);
  }, [openLogin, owner, repo, expireSession]);

  const startDeviceLogin = useCallback(async () => {
    if (!authBase) return;
    loginAbort.current = false;
    setLogin({ open: true, status: "Requesting a code…" });
    const token = await runDeviceLogin({
      authBase,
      shouldStop: () => loginAbort.current,
      onEvent: (e) => {
        if (e.type === "code") {
          setLogin({ open: true, userCode: e.grant.userCode, verificationUri: e.grant.verificationUri, status: "Waiting for you to authorize on GitHub…" });
        } else if (e.type === "denied") setLogin({ open: true, status: "Authorization was denied." });
        else if (e.type === "expired") setLogin({ open: true, status: "The code expired — try again." });
        else if (e.type === "error") setLogin({ open: true, status: `Sign-in error: ${e.message}` });
      },
    });
    if (!token) return;
    try {
      const base = await identifyReviewer(token);
      // Derive the apply tier from repo write access (push/maintain/admin).
      const canApply = await checkRepoWriteAccess(token, { owner, repo });
      const id = { ...base, canApply };
      saveReviewerToken(window.localStorage, { owner, repo }, token);
      saveReviewerIdentity(window.localStorage, { owner, repo }, id);
      setReviewerIdentity(id);
      setLogin({ open: false, status: "" });
      setFeedback(canApply
        ? `Signed in as @${id.login} — your comments are applied.`
        : `Signed in as @${id.login} — your feedback goes to the team for review.`);
    } catch (e) {
      setLogin({ open: true, status: `Could not read your GitHub identity: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, [authBase, owner, repo]);

  const signOut = useCallback(() => {
    if (typeof window !== "undefined") clearReviewerSession(window.localStorage, { owner, repo });
    setReviewerIdentity(null);
    setFeedback("Signed out.");
  }, [owner, repo]);

  // 0.6.0 — where a comment lands depends on context:
  //  - scenarios mode → a comment on the mockup PR (vibe applies it).
  //  - lcr mode → a standalone [LCR] issue tagged with the route's story +
  //    the `vibe` label, since an LCR note is about a requirement, not a PR.
  const postPayload = useCallback(
    async (payload: ReviewCommentPayload, pat: string) => {
      if (reviewMode === "lcr") {
        // Only write-access reviewers get the `vibe` (auto-apply) label; others
        // are labelled `community-review` and held for the team to triage.
        const issue = formatLcrIssue({ payload, canApply: reviewerIdentity?.canApply === true });
        const res = await createIssue({
          owner: repoCoord.owner, repo: repoCoord.repo, pat,
          title: issue.title, body: issue.body, labels: issue.labels,
          apiBase: getProxyApiBase() ?? undefined,
        });
        return { res, kind: "issue" as const };
      }
      const res = await submitComment({
        owner: repoCoord.owner, repo: repoCoord.repo, pr: prNumber, pat,
        body: formatReviewComment({ payload }),
        apiBase: getProxyApiBase() ?? undefined,
      });
      return { res, kind: "comment" as const };
    },
    [reviewMode, repoCoord, prNumber, reviewerIdentity],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    // 0.2.0 — hide on the picker route (homepage). The picker is for
    // navigation, not for review; commenting affordances would be noise.
    // 0.6.0 — only in scenarios mode. In LCR mode `/` is the app home, a
    // first-class surface to review, so we never route-hide.
    if (reviewMode === "lcr") {
      setIsPickerRoute(false);
      return;
    }
    // Re-evaluate on pop/push via a polling tick (Next App Router doesn't
    // emit a usable event for this without a router hook).
    const apply = () => setIsPickerRoute(window.location.pathname === "/");
    apply();
    const interval = setInterval(apply, 500);
    window.addEventListener("popstate", apply);
    return () => {
      clearInterval(interval);
      window.removeEventListener("popstate", apply);
    };
  }, [reviewMode]);

  // ESC steps back one layer at a time (graduated, 0.8.0): an open composer
  // closes first, then an armed pick disarms, then comment/approve mode exits to
  // nav. Mobile has no Escape — each of these layers also has an on-screen exit
  // (composer Cancel, the armed banner, the toolbar toggle).
  useEffect(() => {
    if (typeof window === "undefined") return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (composerOpen) { setComposerOpen(false); setTarget(null); setArmed(false); return; }
      if (armed) { setArmed(false); return; }
      if (mode !== "nav") setMode("nav");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [composerOpen, armed, mode]);

  // Capture clicks at the document level ONLY while a pick is live:
  //  - comment mode → only when the reviewer armed a pick (else clicks navigate);
  //  - approve mode → the next click confirms approval (one-shot).
  // 0.8.0 — this gate is the whole free-nav feature: when not capturing, page
  // links/buttons work normally and the reviewer is never trapped.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const capturing = mode === "approve" || (mode === "comment" && armed);
    if (!capturing) { setHoverEl(null); return; }
    const isOwnUi = (el: Element | null) =>
      !el ||
      (composerRef.current && composerRef.current.contains(el)) ||
      !!(el as HTMLElement).closest('[data-slowcook-overlay-ui="1"]');
    function onClick(e: MouseEvent) {
      const el = e.target as Element | null;
      if (!el || isOwnUi(el)) return;
      e.preventDefault();
      e.stopPropagation();
      if (mode === "comment") {
        setTarget(el);
        setHoverEl(null);
        setComposerOpen(true);
        setArmed(false); // one-shot — disarm so the page is navigable again
      } else if (mode === "approve") {
        void submitApproval();
      }
    }
    // 0.6.5 — live hover preview in comment mode: green-outline the element that
    // would be selected on click, so the reviewer isn't minesweeping. (The red
    // outline marks the element already chosen for the open composer.)
    function onMove(e: MouseEvent) {
      if (mode !== "comment") return;
      const el = e.target as Element | null;
      setHoverEl(el && !isOwnUi(el) ? el : null);
    }
    // 0.6.15 — native controls (a <select>, <input>, link, button) activate on
    // mousedown/pointerdown, BEFORE click — so without this they'd open their
    // dropdown / focus / navigate instead of letting the click attach a comment.
    // Swallow the down-press on the page (not the overlay's own UI) in
    // comment/approve mode; the click still fires and opens the composer.
    function onDown(e: Event) {
      const el = e.target as Element | null;
      if (!el || isOwnUi(el)) return;
      e.preventDefault();
      e.stopPropagation();
    }
    document.addEventListener("click", onClick, { capture: true });
    document.addEventListener("mouseover", onMove, { capture: true });
    document.addEventListener("mousedown", onDown, { capture: true });
    document.addEventListener("pointerdown", onDown, { capture: true });
    return () => {
      document.removeEventListener("click", onClick, { capture: true });
      document.removeEventListener("mouseover", onMove, { capture: true });
      document.removeEventListener("mousedown", onDown, { capture: true });
      document.removeEventListener("pointerdown", onDown, { capture: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, armed]);

  // 0.6.6 — entering Nav clears the whole comment surface: any open composer,
  // the comments-list panel, a general-note composer, an open pin popover, the
  // approve confirm, the hover preview. Nav = "done reviewing, clean slate".
  useEffect(() => {
    if (mode !== "nav") return;
    setComposerOpen(false);
    setTarget(null);
    setArmed(false);
    setGeneralComposerOpen(false);
    setListPanelOpen(false);
    setOpenCommentId(null);
    setApproveConfirmOpen(false);
    setHoverEl(null);
  }, [mode]);

  const onApproveClicked = useCallback(() => {
    // 0.2.0 — two-step confirm; protects against fat-finger approval.
    setMode("approve");
    setApproveConfirmOpen(true);
  }, []);

  const submitApproval = useCallback(async () => {
    setSubmitting(true);
    setFeedback(null);
    try {
      const pat = ensurePat(repoCoord, reviewMode === "lcr");
      if (!pat) {
        if (reviewMode === "lcr") { openLogin(); }
        else setFeedback("Approval cancelled — no PAT.");
        return;
      }
      // 0.5.2 — three things land on approve, in order:
      //   1. Label add (the load-bearing signal plate reads)
      //   2. PR review with event=APPROVE (so GitHub's PR header
      //      shows the green ✓ approval — what the PM expects when
      //      they click an "Approve" button on a PR)
      //   3. Audit-trail comment summarizing what fired + what didn't
      //
      // Each step degrades independently (label add can fail without
      // blocking the PR review; PR-review self-approval can fail
      // without blocking the label). The comment names which fired.
      const apiBase = getProxyApiBase() ?? undefined;
      const labelOk = await addLabelsToPr({
        owner: repoCoord.owner,
        repo: repoCoord.repo,
        pr: prNumber,
        pat,
        labels: [APPROVED_LABEL],
        apiBase,
      });
      const reviewResult = await submitPrApproval({
        owner: repoCoord.owner,
        repo: repoCoord.repo,
        pr: prNumber,
        pat,
        body: `Mockup approved via slowcook review overlay (\`${overlayVersion}\`). Plate will refuse further amendments while \`${APPROVED_LABEL}\` is set.`,
        apiBase,
      });
      const reviewOk = reviewResult.ok;
      const reviewNote = reviewOk
        ? `PR review submitted with event=APPROVE.`
        : `⚠️ PR review (event=APPROVE) failed: ${reviewResult.status ?? "?"} ${reviewResult.message ?? ""}` +
          ` (GitHub forbids approving your own PR; if this is your PR, the label + comment still mark intent.)`;
      const labelNote = labelOk
        ? `Label \`${APPROVED_LABEL}\` applied; plate will refuse further amendments.`
        : `⚠️ Could NOT auto-apply \`${APPROVED_LABEL}\` (PAT may lack write scope OR label may not exist on the repo). Please apply it manually.`;
      const body = `### ✅ Mockup approved\n\nPM approved the mockup via the review overlay (\`${overlayVersion}\`).\n\n${labelNote}\n\n${reviewNote}`;
      const result = await submitComment({
        owner: repoCoord.owner,
        repo: repoCoord.repo,
        pr: prNumber,
        pat,
        body,
        apiBase,
      });
      if (result.ok) {
        const parts: string[] = [];
        if (labelOk) parts.push("label applied");
        if (reviewOk) parts.push("PR approved");
        parts.push(`comment #${result.commentId}`);
        setFeedback(`Approved · ${parts.join(" · ")}.`);
        setMode("nav");
        if (labelOk) setIsApproved(true); // optimistic; focus-refresh confirms
      } else {
        reportFailure(result.status, result.message, "Approval failed");
      }
    } finally {
      setSubmitting(false);
    }
  }, [overlayVersion, prNumber, repoCoord]);

  const submitFromComposer = useCallback(
    async (prose: string) => {
      if (!target) return;
      setSubmitting(true);
      setFeedback(null);
      try {
        const pat = ensurePat(repoCoord, reviewMode === "lcr");
        if (!pat) {
          if (reviewMode === "lcr") { openLogin(); }
          else setFeedback("Cancelled — no PAT.");
          return;
        }
        const sel = extractSelector(target);
        const rect = target.getBoundingClientRect();
        const viewport: ViewportInfo = {
          width: window.innerWidth,
          height: window.innerHeight,
          colorScheme: window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light",
          dpr: window.devicePixelRatio || 1,
        };
        const ctx = collectReviewContext(surfaceManifest);
        const payload = buildPayload({
          overlayVersion,
          storyId,
          url: window.location.href,
          pathname: window.location.pathname,
          routeQuery: window.location.search,
          routeStory: readCurrentStory(),
          prose,
          selector: sel,
          bbox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
          viewport,
          userAgent: navigator.userAgent,
          surface: ctx.surface,
          lang: ctx.lang,
        });
        const { res: result, kind } = await postPayload(payload, pat);
        if (result.ok) {
          setFeedback(kind === "issue" ? `LCR issue filed (#${result.commentId}).` : `Comment posted (#${result.commentId}).`);
          setComposerOpen(false);
          setTarget(null);
          // 0.4.1 — push the just-submitted comment into the local pin
          // layer immediately so the pin appears without a refresh +
          // tab-switch dance. Background-refresh on next focus catches
          // up with the canonical state (incl. plate's eventual reply).
          const optimisticRecord = {
            commentId: result.commentId,
            author: "you",
            createdAt: new Date().toISOString(),
            htmlUrl: result.htmlUrl,
            payload,
            plateReply: null,
          };
          setComments((prev) => {
            const next = [...prev, optimisticRecord];
            try {
              saveCachedComments(window.localStorage, repoCoord, prNumber, next);
            } catch { /* ignore */ }
            return next;
          });
        } else {
          reportFailure(result.status, result.message, "Failed");
        }
      } finally {
        setSubmitting(false);
      }
    },
    [overlayVersion, prNumber, repoCoord, storyId, target]
  );

  /**
   * 0.5.0 — submit a general (no-anchor) comment. Same path as
   * submitFromComposer but skips the element-extraction step.
   */
  const submitGeneralComment = useCallback(
    async (prose: string) => {
      setSubmitting(true);
      setFeedback(null);
      try {
        const pat = ensurePat(repoCoord, reviewMode === "lcr");
        if (!pat) {
          if (reviewMode === "lcr") { openLogin(); }
          else setFeedback("Cancelled — no PAT.");
          return;
        }
        const viewport: ViewportInfo = {
          width: window.innerWidth,
          height: window.innerHeight,
          colorScheme: window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light",
          dpr: window.devicePixelRatio || 1,
        };
        const ctx = collectReviewContext(surfaceManifest);
        const payload = buildPayload({
          overlayVersion,
          storyId,
          url: window.location.href,
          pathname: window.location.pathname,
          routeQuery: window.location.search,
          routeStory: readCurrentStory(),
          prose,
          viewport,
          userAgent: navigator.userAgent,
          // No selector + no bbox → general (page-level) comment — still carries
          // the full surface + lang context.
          surface: ctx.surface,
          lang: ctx.lang,
        });
        const { res: result, kind } = await postPayload(payload, pat);
        if (result.ok) {
          setFeedback(kind === "issue" ? `LCR issue filed (#${result.commentId}).` : `Note posted (#${result.commentId}).`);
          setGeneralComposerOpen(false);
          const optimisticRecord = {
            commentId: result.commentId,
            author: "you",
            createdAt: new Date().toISOString(),
            htmlUrl: result.htmlUrl,
            payload,
            plateReply: null,
          };
          setComments((prev) => {
            const next = [...prev, optimisticRecord];
            try {
              saveCachedComments(window.localStorage, repoCoord, prNumber, next);
            } catch { /* ignore */ }
            return next;
          });
        } else {
          reportFailure(result.status, result.message, "Failed");
        }
      } finally {
        setSubmitting(false);
      }
    },
    [overlayVersion, prNumber, repoCoord, storyId]
  );

  if (!mounted) return null;
  if (!enabled) return null;
  if (typeof window === "undefined") return null;
  if (isPickerRoute) return null;
  // 0.5.1 — auto-detect path: skip when env vars + props together
  // don't supply a real owner/repo. Avoids "submit comment" failing
  // silently because the API call goes nowhere.
  // 0.6.1 — lcr mode files ISSUES (not PR comments), so it needs no PR;
  // only scenarios mode requires a prNumber.
  if (!owner || !repo) return null;
  if (reviewMode !== "lcr" && !prNumber) return null;
  if (!shadowRoot) return null; // 0.7.3 — wait for the shadow host to mount

  return createPortal(
    <>
      <style dangerouslySetInnerHTML={{ __html: SHADOW_RESET_CSS }} />
    <div
      data-slowcook-overlay-ui="1"
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 2147483000,
      }}
    >
      {/* Style isolation — the overlay renders into the host's DOM, so the
          host's global form rules (e.g. a `[data-theme="dark"] textarea {…}`
          dark-mode override) bleed onto the overlay's own inputs and turn the
          comment box dark. These scoped !important rules pin every overlay
          form control to its intended light surface regardless of host theme. */}
      <style dangerouslySetInnerHTML={{ __html:
        `[data-slowcook-overlay-ui] textarea,[data-slowcook-overlay-ui] input,[data-slowcook-overlay-ui] select{` +
        `color:#1a1a1a !important;background-color:#fff !important;` +
        `-webkit-text-fill-color:#1a1a1a !important;border-color:rgba(0,0,0,0.15) !important;caret-color:#1a1a1a !important;}` +
        `[data-slowcook-overlay-ui] textarea::placeholder,[data-slowcook-overlay-ui] input::placeholder{` +
        `color:rgba(0,0,0,0.4) !important;-webkit-text-fill-color:rgba(0,0,0,0.4) !important;}` +
        // 0.7.2 — the compact pane select. Higher specificity (attr + class +
        // element) so the host's `select{font-size:16px !important}` (iOS-zoom
        // guard) can't bloat it; keep it small + dark to match the pane.
        `[data-slowcook-overlay-ui] select.sc-ovl-pane-select{` +
        `font-size:11px !important;padding:4px 7px !important;line-height:1.15 !important;` +
        `color:#1a1a1a !important;background-color:#fff !important;font-weight:700 !important;}`
      }} />
      {/* 0.8.0 — tint the page only while a pick is live (armed comment, or
          approve). Free-nav comment mode with no armed pick stays untinted —
          you're just navigating. */}
      {(armed || mode === "approve") && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundColor:
              mode === "approve"
                ? "rgba(74, 222, 128, 0.05)"
                : "rgba(255, 107, 107, 0.05)",
            pointerEvents: "none",
          }}
          aria-hidden="true"
        />
      )}
      {/* 0.6.5 — green hover preview of the click target in comment mode. */}
      {mode === "comment" && armed && !composerOpen && hoverEl && <HoverHighlight el={hoverEl} />}
      {/* 0.8.0 — armed banner: the on-screen, mobile-safe cancel for a live pick.
          Tap it (or Esc) to disarm and go back to navigating. */}
      {mode === "comment" && armed && !composerOpen && (
        <button
          type="button"
          data-slowcook-overlay-ui="1"
          onClick={() => setArmed(false)}
          style={{
            position: "fixed",
            top: 12,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 2147483647,
            pointerEvents: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            maxWidth: "92vw",
            padding: "8px 14px",
            border: "1px solid rgba(255,255,255,0.16)",
            borderRadius: 999,
            background: "rgba(15, 15, 24, 0.94)",
            color: "white",
            font: "600 13px system-ui, -apple-system, sans-serif",
            cursor: "pointer",
            boxShadow: "0 4px 14px rgba(0,0,0,0.35)",
          }}
        >
          📍 Tap an element to comment on it
          <span style={{ opacity: 0.7, fontWeight: 400 }}>· tap here / Esc to cancel</span>
        </button>
      )}
      <ModeToggle
        mode={mode}
        armed={armed}
        onArm={() => setArmed(true)}
        onCancelArm={() => setArmed(false)}
        onChange={(m) => (m === "approve" ? onApproveClicked() : setMode(m))}
        disabled={submitting}
        isMobile={isMobile}
        isApproved={isApproved}
        commentCount={comments.length}
        newCount={newCount}
        onListClick={() => { setListPanelOpen(true); markAllSeen(); }}
        docsEnabled={reviewMode === "lcr" && docPaths.length > 0}
        onDocsClick={() => setDocsPanelOpen(true)}
        askEnabled={Boolean(askBase)}
        onAskClick={() => setAskPanelOpen(true)}
        surfaces={reviewMode === "lcr" ? surfaces : []}
        surfaceManifest={surfaceManifest}
        onNavigate={(home) => {
          if (typeof window === "undefined") return;
          // Router-agnostic SPA nav: pushState + popstate so react-router (or any
          // history listener) updates without a full reload.
          window.history.pushState({}, "", home);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }}
        reviewMode={reviewMode}
        identity={reviewerIdentity}
        onSignIn={() => openLogin()}
        onSignOut={signOut}
        accessory={props.accessory}
      />
      {/* 0.3.0 — Figma-style pin layer for previously-left comments.
          Only visible in Comment mode (Nav stays clean). 0.5.0 —
          general (no-anchor) comments are skipped here; they show
          only in the list panel. */}
      {mode === "comment" && comments.length > 0 && (
        <CommentPins
          records={comments.filter((c) => c.payload.element !== null)}
          showApplied={showApplied}
          openCommentId={openCommentId}
          onOpen={(id) => setOpenCommentId(id)}
          onClose={() => setOpenCommentId(null)}
          flashCommentId={flashCommentId}
        />
      )}
      {/* 0.5.0 — comments-list panel (always reachable from the pill). */}
      {listPanelOpen && (
        <CommentsListPanel
          records={comments}
          showApplied={showApplied}
          onToggleApplied={() => setShowApplied((v) => !v)}
          onClose={() => setListPanelOpen(false)}
          onOpenComment={(id) => {
            setListPanelOpen(false);
            setMode("comment");
            setOpenCommentId(id);
            setFlashCommentId(id);
            setTimeout(() => setFlashCommentId((cur) => (cur === id ? null : cur)), 1500);
          }}
          onAddGeneral={() => {
            setListPanelOpen(false);
            setGeneralComposerOpen(true);
          }}
          onApprove={() => { setListPanelOpen(false); onApproveClicked(); }}
          isApproved={isApproved}
        />
      )}
      {/* 0.7.0 — docs studio: the textual half of review. */}
      {docsPanelOpen && (
        <DocsPanel
          repo={repoCoord}
          docPaths={docPaths}
          branch={resolvedBranch}
          identity={reviewerIdentity}
          getToken={() => (typeof window !== "undefined" ? loadReviewerToken(window.localStorage, repoCoord) : null)}
          onSignIn={() => openLogin()}
          onSessionExpired={() => expireSession(`Your GitHub session expired — sign in again to read the docs.`)}
          apiBase={getProxyApiBase() ?? undefined}
          onClose={() => setDocsPanelOpen(false)}
          onFeedback={(t) => setFeedback(t)}
        />
      )}
      {/* 0.16.0 — Ask co-pilot: two-way chat with a repo-aware Claude agent. */}
      {askPanelOpen && (
        <AskPanel
          repo={repoCoord}
          askBase={askBase}
          identity={reviewerIdentity}
          getToken={() => (typeof window !== "undefined" ? loadReviewerToken(window.localStorage, repoCoord) : null)}
          onSignIn={() => openLogin()}
          onSessionExpired={() => expireSession(`Your GitHub session expired — sign in again to chat.`)}
          surfaceManifest={surfaceManifest}
          onClose={() => setAskPanelOpen(false)}
        />
      )}
      {generalComposerOpen && (
        <GeneralComposer
          onCancel={() => setGeneralComposerOpen(false)}
          onSubmit={submitGeneralComment}
          submitting={submitting}
        />
      )}
      {composerOpen && target && (
        <Composer
          target={target}
          onCancel={() => {
            setComposerOpen(false);
            setTarget(null);
          }}
          onSubmit={submitFromComposer}
          submitting={submitting}
          composerRef={composerRef}
        />
      )}
      {approveConfirmOpen && (
        <ApproveConfirm
          onCancel={() => {
            setApproveConfirmOpen(false);
            setMode("nav");
          }}
          onConfirm={async () => {
            setApproveConfirmOpen(false);
            await submitApproval();
          }}
          submitting={submitting}
        />
      )}
      {login.open && (
        <ReviewerLoginDialog
          owner={repoCoord.owner}
          repo={repoCoord.repo}
          userCode={login.userCode}
          verificationUri={login.verificationUri}
          status={login.status}
          error={login.error}
          hasAuthBase={Boolean(authBase)}
          onSubmitPat={(tok) => void signInWithPat(tok)}
          onStartDevice={() => void startDeviceLogin()}
          onClose={() => { loginAbort.current = true; setLogin({ open: false, status: "" }); }}
        />
      )}
      {feedback && <FeedbackToast text={feedback} onDismiss={() => setFeedback(null)} />}
    </div>
    </>,
    shadowRoot
  );
}

/**
 * 0.6.5 — green hover preview in comment mode. Outlines the element the cursor
 * is over (the one a click would attach the comment to) so the reviewer can see
 * the target before committing — no minesweeping. Distinct from the red outline,
 * which marks the element already chosen for the open composer.
 */
function HoverHighlight({ el }: { el: Element }): JSX.Element {
  const r = el.getBoundingClientRect();
  return (
    <div
      data-slowcook-overlay-ui="1"
      aria-hidden="true"
      style={{
        position: "fixed",
        top: r.top, left: r.left, width: r.width, height: r.height,
        border: "2px solid #22c55e",
        background: "rgba(34, 197, 94, 0.12)",
        borderRadius: 4,
        boxShadow: "0 0 0 1px rgba(34,197,94,0.35)",
        pointerEvents: "none",
        zIndex: 2147483200,
      }}
    />
  );
}

/**
 * 0.8.1 — deterministic, in-code explanation of a write/auth failure. No LLM,
 * no agent: the overlay itself tells the reviewer exactly why GitHub rejected
 * the post and what to do (use a classic PAT with the `repo` scope), keyed off
 * the HTTP status + GitHub's own message. Surfaced on every repo the overlay is
 * mounted on.
 */
export function describeAuthError(status: number | undefined, message: string | undefined, repo: RepoCoord): string {
  const m = (message ?? "").toLowerCase();
  if (status === 403 && m.includes("oauth app access restrictions")) {
    return `Your "${repo.owner}" organization restricts third-party OAuth Apps, so the GitHub sign-in app is blocked from posting here — even though you're signed in. Use a classic personal access token with the \`repo\` scope instead: a PAT isn't an OAuth App, so the restriction doesn't apply.`;
  }
  if (status === 403) {
    return `GitHub returned 403 (forbidden) for ${repo.owner}/${repo.repo}. If it's a private repo, or your org restricts OAuth Apps, sign in with a classic token that has the \`repo\` scope.`;
  }
  if (status === 401) {
    return `GitHub rejected the token (401) — it's likely expired or missing scope. Sign in again with a classic token that has the \`repo\` scope.`;
  }
  if (status === 404) {
    return `${repo.owner}/${repo.repo} wasn't found for this token — it's probably private and your token lacks the \`repo\` scope. Sign in with a classic token that has \`repo\`.`;
  }
  return message ?? "Sign-in needed to post your comment.";
}

/**
 * 0.6.0 → 0.8.1 — sign-in dialog. Always offers a classic-PAT path with baked-in
 * instructions (the reliable route for private repos + orgs that restrict OAuth
 * Apps), plus device-flow login when an authBase helper is configured. `error`
 * shows the deterministic reason a write was just rejected.
 */
function ReviewerLoginDialog({
  owner, repo, userCode, verificationUri, status, error, hasAuthBase, onSubmitPat, onStartDevice, onClose,
}: {
  owner: string; repo: string;
  userCode?: string; verificationUri?: string; status: string; error?: string;
  hasAuthBase: boolean;
  onSubmitPat: (token: string) => void;
  onStartDevice: () => void;
  onClose: () => void;
}): JSX.Element {
  const [pat, setPat] = useState("");
  const tokenUrl = `https://github.com/settings/tokens/new?scopes=repo&description=${encodeURIComponent(`slowcook review ${owner}/${repo}`)}`;
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "auto", zIndex: 2147483647, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ background: "#fff", borderRadius: 14, padding: 22, width: 400, maxWidth: "92vw", maxHeight: "88vh", overflow: "auto", boxShadow: "0 12px 40px rgba(0,0,0,0.3)" }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 2, color: "#111" }}>Sign in to review</div>
        <div style={{ fontSize: 12, color: "#666", marginBottom: 12, fontFamily: "ui-monospace, monospace" }}>{owner}/{repo}</div>

        {error && (
          <div style={{ background: "#fff1f0", border: "1px solid #ffccc7", color: "#a8071a", borderRadius: 8, padding: "10px 12px", fontSize: 12.5, lineHeight: 1.5, marginBottom: 14 }}>
            {error}
          </div>
        )}

        {/* Classic-PAT path — the reliable route (deterministic instructions). */}
        <div style={{ fontSize: 13.5, fontWeight: 700, color: "#111", marginBottom: 4 }}>Personal access token{!hasAuthBase && " (recommended)"}</div>
        <p style={{ fontSize: 12.5, color: "#555", margin: "0 0 10px", lineHeight: 1.5 }}>
          Works for <strong>private repos</strong> and orgs that restrict OAuth Apps. Create a <strong>classic</strong> token with the <code style={{ background: "#f3f4f6", padding: "1px 4px", borderRadius: 4 }}>repo</code> scope, then paste it below.
        </p>
        <a href={tokenUrl} target="_blank" rel="noreferrer"
           style={{ display: "block", textAlign: "center", background: "#1f2328", color: "#fff", borderRadius: 8, padding: "8px 0", textDecoration: "none", fontWeight: 600, fontSize: 13, marginBottom: 10 }}>
          ① Create a classic token (repo scope) ↗
        </a>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="password"
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && pat.trim()) onSubmitPat(pat); }}
            placeholder="② Paste token (ghp_… / github_pat_…)"
            autoComplete="off"
            style={{ flex: 1, minWidth: 0, padding: "8px 10px", border: "1px solid #d0d7de", borderRadius: 8, fontSize: 14, color: "#111", background: "#fff" }}
          />
          <button
            type="button"
            disabled={pat.trim() === ""}
            onClick={() => onSubmitPat(pat)}
            style={{ background: pat.trim() ? "#2da44e" : "#94d3a2", color: "#fff", border: "none", borderRadius: 8, padding: "8px 14px", fontWeight: 700, fontSize: 13, cursor: pat.trim() ? "pointer" : "not-allowed", whiteSpace: "nowrap" }}
          >
            Save
          </button>
        </div>
        <p style={{ fontSize: 11, color: "#888", margin: "8px 0 0", lineHeight: 1.5 }}>
          Stored only in this browser, scoped to {owner}/{repo}. {status && <span style={{ color: "#555", fontWeight: 600 }}>· {status}</span>}
        </p>

        {/* Device-flow path — only when an auth helper (authBase) is configured. */}
        {hasAuthBase && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "16px 0 12px", color: "#999", fontSize: 11 }}>
              <span style={{ flex: 1, height: 1, background: "#eaeaea" }} /> OR <span style={{ flex: 1, height: 1, background: "#eaeaea" }} />
            </div>
            {userCode ? (
              <>
                <p style={{ fontSize: 12.5, color: "#555", margin: "0 0 10px" }}>Open GitHub and enter this code:</p>
                <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: "0.18em", textAlign: "center", background: "#f3f4f6", borderRadius: 10, padding: "10px 0", color: "#111", fontFamily: "ui-monospace, monospace" }}>{userCode}</div>
                <a href={verificationUri} target="_blank" rel="noreferrer"
                   style={{ display: "block", textAlign: "center", marginTop: 12, background: "#2da44e", color: "#fff", borderRadius: 999, padding: "9px 0", textDecoration: "none", fontWeight: 600, fontSize: 14 }}>
                  Open {verificationUri?.replace(/^https?:\/\//, "")}
                </a>
              </>
            ) : (
              <button type="button" onClick={onStartDevice}
                style={{ width: "100%", background: "#fff", color: "#1f2328", border: "1px solid #d0d7de", borderRadius: 8, padding: "9px 0", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
                Sign in with GitHub device login
              </button>
            )}
          </>
        )}

        <button onClick={onClose} style={{ marginTop: 16, width: "100%", border: "1px solid rgba(0,0,0,0.12)", background: "#fff", borderRadius: 999, padding: "8px 0", cursor: "pointer", fontSize: 13, color: "#444" }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * 0.2.0 — draggable toggle pill with grip handle, slowcook logo,
 * and a visible border. Position persists in localStorage so PMs
 * can park it where it doesn't overlap the UI they're reviewing.
 *
 * Keys it on the active document's origin so different repos /
 * preview deploys don't share placement.
 */
// 0.9.0 — LEFT-anchored (was right): the grip + logo + nav/rev pin to the left
// edge and the EPSS status grows the pill rightward. Bumped key suffix so old
// right-based saved positions don't mis-place the new left-anchored pill.
// Detect the scheme to render overlay artifacts in. The overlay is mounted INSIDE a
// consumer app that has its OWN theme (e.g. dash forces dark via data-theme="dark"),
// which may differ from the OS. Following prefers-color-scheme rendered a LIGHT panel
// over a dark app (bright, low-contrast). So follow the PAGE: an explicit
// data-theme/color-scheme wins, else the page background's luminance, else the OS.
// 0.9.5 — track the live pathname so the EPSS status reflects where the reviewer
// ACTUALLY is, reactively. react-router (and most SPA routers) navigate via
// history.pushState without firing popstate, so patch it to notify us; popstate +
// a low-freq poll are belt-and-braces.
function useCurrentPath(): string {
  const [path, setPath] = useState<string>(() => { try { return window.location.pathname; } catch { return "/"; } });
  useEffect(() => {
    const update = () => { try { setPath(window.location.pathname); } catch { /* ssr */ } };
    window.addEventListener("popstate", update);
    window.addEventListener("hashchange", update);
    const origPush = history.pushState; const origReplace = history.replaceState;
    try {
      history.pushState = function (this: History, ...a: Parameters<History["pushState"]>) { const r = origPush.apply(this, a); update(); return r; };
      history.replaceState = function (this: History, ...a: Parameters<History["replaceState"]>) { const r = origReplace.apply(this, a); update(); return r; };
    } catch { /* history not patchable */ }
    const iv = setInterval(update, 700);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("hashchange", update);
      try { history.pushState = origPush; history.replaceState = origReplace; } catch { /* */ }
      clearInterval(iv);
    };
  }, []);
  return path;
}

const TOGGLE_POSITION_STORAGE_KEY = "slowcook.review-overlay.toggle-pos.v2";

interface TogglePosition {
  /** Absolute top in CSS px from viewport top. */
  top: number;
  /** Absolute left in CSS px from viewport left. */
  left: number;
}

function loadTogglePosition(): TogglePosition {
  const fallback: TogglePosition = { top: 12, left: 12 };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(TOGGLE_POSITION_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<TogglePosition>;
    if (typeof parsed.top !== "number" || typeof parsed.left !== "number") return fallback;
    return { top: parsed.top, left: parsed.left };
  } catch {
    return fallback;
  }
}

function saveTogglePosition(p: TogglePosition): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TOGGLE_POSITION_STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* ignore quota / private-mode errors */
  }
}

// 0.10.1 — a persisted position can fall outside the viewport (the window was
// resized smaller, or the pill was dragged to an edge). Because the pill is
// fixed/absolute chrome, an off-screen position is UNREACHABLE — you can't scroll
// to it. So whenever we restore or the window resizes, snap a stranded pill back
// to the top-left where it's always grabbable. `margin` keeps a sliver on-screen so
// a position that's merely flush to an edge still counts as visible.
function ensureOnScreen(p: TogglePosition): TogglePosition {
  if (typeof window === "undefined") return p;
  return isPillOffViewport(p.left, p.top, window.innerWidth, window.innerHeight) ? { top: 12, left: 12 } : p;
}

function ModeToggle(props: {
  mode: Mode;
  armed: boolean;
  onArm: () => void;
  onCancelArm: () => void;
  onChange: (m: Mode) => void;
  disabled: boolean;
  isMobile: boolean;
  isApproved: boolean;
  commentCount: number;
  newCount: number;
  onListClick: () => void;
  docsEnabled: boolean;
  onDocsClick: () => void;
  askEnabled: boolean;
  onAskClick: () => void;
  surfaces: ReviewSurface[];
  surfaceManifest: Manifest | null;
  onNavigate: (home: string) => void;
  // 0.6.2 — LCR sign-in lives IN the floating disk (self-styled, theme-proof),
  // not a separate fixed badge.
  reviewMode: "scenarios" | "lcr";
  identity: StoredReviewerIdentity | null;
  onSignIn: () => void;
  onSignOut: () => void;
  accessory?: ReactNode;
}): JSX.Element {
  const { mode, armed, onArm, onCancelArm, onChange, disabled, isMobile, isApproved, commentCount, newCount, onListClick, docsEnabled, onDocsClick, askEnabled, onAskClick, surfaces, surfaceManifest, onNavigate, reviewMode, identity, onSignIn, onSignOut, accessory } = props;
  // 0.5.1 — initialise with the default; load saved position from
  // localStorage AFTER mount. Eliminates a hydration mismatch where
  // SSR/first-client render disagreed on the position value.
  const [pos, setPos] = useState<TogglePosition>({ top: 12, left: 12 });
  // Restore the saved position after mount (avoids an SSR hydration mismatch), but
  // never restore it off-screen — snap a stranded pill back into view (0.10.1).
  useEffect(() => { setPos(ensureOnScreen(loadTogglePosition())); }, []);
  // If the window resizes such that the pill ends up outside the viewport, bring it
  // back (a fixed pill can't be scrolled to).
  useEffect(() => {
    const onResize = () => setPos((p) => {
      const next = ensureOnScreen(p);
      if (next !== p) saveTogglePosition(next);
      return next;
    });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const dragRef = useRef<{ startX: number; startY: number; startTop: number; startLeft: number } | null>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);

  // 0.9.0 — EPSS jump palette open state. The tappable status (right of the
  // pill) opens it; it lists matching states to jump to.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // 0.9.0 — follow the system colour scheme.
  const dark = usePrefersDark();
  const T = pillTheme(dark);
  // 0.9.5 — live pathname so the EPSS status tracks navigation.
  const currentPath = useCurrentPath();

  // 0.6.3 — sign-out is a two-step confirm: the disk floats, so a single
  // mis-click shouldn't log you out. First click/tap on the identity chip arms
  // confirmation (the chip turns into "Sign out?"); a second click/tap within a
  // few seconds confirms. ANY other action (mode toggle, list, drag) cancels.
  const [confirmLogout, setConfirmLogout] = useState(false);
  const cancelLogout = useCallback(() => setConfirmLogout(false), []);
  useEffect(() => {
    if (!confirmLogout) return;
    const t = setTimeout(() => setConfirmLogout(false), 3500);
    return () => clearTimeout(t);
  }, [confirmLogout]);
  const onChangeSafe = useCallback((m: Mode) => { setConfirmLogout(false); onChange(m); }, [onChange]);
  const onListSafe = useCallback(() => { setConfirmLogout(false); onListClick(); }, [onListClick]);

  // Drag handlers — pointer events for unified mouse + touch.
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Only drag from the grip itself; clicks on toggle buttons must stay clicks.
    setConfirmLogout(false); // dragging cancels a pending sign-out confirm
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startTop: pos.top,
      startLeft: pos.left,
    };
  }, [pos]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    e.preventDefault();
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    // 0.10.1 — clamp into the viewport while dragging so the grip can never be
    // pushed off-screen (it's left-anchored now, so a negative left hides it).
    const { left, top } = clampPillPosition(dragRef.current.startLeft + dx, dragRef.current.startTop + dy, window.innerWidth, window.innerHeight);
    setPos({ top, left });
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    dragRef.current = null;
    saveTogglePosition(pos);
  }, [pos]);

  return (
    <div
      ref={pillRef}
      data-slowcook-overlay-ui="1"
      title={isApproved ? "Mockup approved — comments still allowed; plate refuses to amend" : undefined}
      style={{
        position: "absolute",
        top: pos.top,
        left: pos.left,
        pointerEvents: "auto",
        // 0.9.1 — row: a FULL-HEIGHT grip on the left, then a content column
        // (button row + EPSS location line). alignItems:stretch makes the grip
        // span the whole left border (not just the first row). Compact: a long
        // EPSS status WRAPS onto more lines rather than widening the pill right.
        display: "flex",
        flexDirection: "row",
        alignItems: "stretch",
        // 0.9.5 — cap at the viewport, not a fixed 300px: the content column is
        // min-content (= button-row width), so the pill is already only as wide
        // as its buttons; a hard 300px cap clipped the signed-in identity chip
        // OUTSIDE the pill border. 94vw keeps a wide (signed-in) row inside the
        // pill; on a truly tiny viewport the grip still pans it left.
        maxWidth: "min(600px, 94vw)",
        gap: 4,
        // 0.4.2 — green-tinted when approved; else follows the system theme.
        background: isApproved ? (dark ? "rgba(20, 83, 45, 0.92)" : "rgba(220, 245, 228, 0.96)") : T.bg,
        // 0.16.1 — Refine-pill visual language: capsule + soft drop shadow.
        padding: "6px 10px 6px 7px",
        borderRadius: 999,
        border: isApproved ? `1px solid rgba(34, 197, 94, 0.55)` : `1px solid ${T.border}`,
        boxShadow: isApproved
          ? `0 6px 20px rgba(34, 197, 94, 0.30), inset 0 1px 0 rgba(255,255,255,0.06)`
          : `0 6px 20px rgba(0,0,0,.35)`,
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: 13,
        color: T.fg,
        userSelect: "none",
      }}
    >
      <CometSheen pillRef={pillRef} radius={999} />
      {/* 0.9.1 — Grip on the LEFTMOST edge, FULL height: alignSelf stretch +
          a tiled dot texture so it visually covers the ENTIRE left border,
          however many lines the status wraps to. Drag to move; if a long status
          grows the pill, the grip stays put so you can pan it left. */}
      <div
        role="button"
        aria-label="Drag overlay toggle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        title="Drag to move"
        style={{
          width: 11,
          alignSelf: "stretch",
          minHeight: 22,
          cursor: dragRef.current ? "grabbing" : "grab",
          opacity: 0.5,
          touchAction: "none",
          flexShrink: 0,
          borderRadius: 7,
          backgroundImage: "radial-gradient(currentColor 1.05px, transparent 1.15px)",
          backgroundSize: "5px 5px",
          backgroundPosition: "center",
        }}
        aria-hidden="false"
      />
      {/* Content column — the button row on top, the EPSS location line below.
          alignItems:flex-start keeps each row content-width; flex:1 + minWidth:0
          lets the status wrap within the (capped) pill width. */}
      {/* 0.9.3 — the content column is `min-content` wide so the pill is exactly
          as wide as the BUTTON ROW; the EPSS status then WRAPS within that width
          instead of stretching the pill rightward. */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3, width: "min-content", maxWidth: "100%", minWidth: 0 }}>
      {/* Top row — buttons on a single non-wrapping line; this row's width is what
          the column (and pill) sizes to. */}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "nowrap", whiteSpace: "nowrap", gap: 4 }}>
      {/* Slowcook logo — pinned to the left of the button row. */}
      <SlowcookLogo />
      {/* 0.8.0 — single Review/exit toggle. Off = overlay idle. On (accent) =
          a review session: the page still navigates freely; you arm a pick with
          the "📍 Pin a comment" button below. (Was "Commenting" — but comment
          mode no longer traps clicks, so it now reads "Reviewing".) */}
      {/* 0.16.1 — Refine-style segmented toggle (was the single rev/nav disk). */}
      <div style={{ display: "inline-flex", alignItems: "center", background: T.sub, borderRadius: 9, padding: 2, gap: 1 }}>
        {([["nav", "Nav"], ["comment", "Review"]] as const).map(([m, lbl]) => (
          <button
            key={m}
            type="button"
            disabled={disabled}
            onClick={() => onChangeSafe(m)}
            title={m === "comment"
              ? (newCount ? `Review — pin comments (${newCount} new update(s))` : "Review — pin comments + the testing-surface router")
              : "Browse without reviewing"}
            style={{
              position: "relative", padding: "3px 10px", borderRadius: 7, border: "none",
              fontSize: 12, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer",
              background: mode === m ? ACCENT : "transparent",
              color: mode === m ? "#1a1a1a" : T.fgDim,
              font: "inherit",
            }}
          >
            {lbl}
            {m === "comment" && newCount > 0 && mode !== "comment" ? (
              <span style={{ position: "absolute", top: -4, right: -4, minWidth: 14, height: 14, borderRadius: 999, background: ACCENT, color: "#1a1a1a", fontSize: 9, fontWeight: 800, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 3px", border: `1.5px solid ${T.bg}` }}>{newCount}</span>
            ) : null}
          </button>
        ))}
      </div>
      {/* 0.8.0 — arm a single element-pick. While armed the next page tap selects
          an element to comment on (then auto-disarms); tap again to cancel. */}
      {mode === "comment" && (
        <button
          type="button"
          onClick={() => (armed ? onCancelArm() : onArm())}
          disabled={disabled}
          aria-label={armed ? "Cancel pick" : "Comment on an element"}
          title={armed ? "Cancel — tap an element, or cancel the pick" : "Comment on an element"}
          style={{
            background: armed ? ACCENT : T.sub,
            color: armed ? "white" : T.fg,
            border: armed ? `1px solid ${ACCENT}` : "1px solid transparent",
            padding: "5px 10px",
            borderRadius: 999,
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.6 : 1,
            font: "inherit",
            fontSize: 12,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
          }}
        >
          {armed ? "✕ Cancel" : "📍 Pin"}
        </button>
      )}
      {/* 0.6.8 — Approve moved into the Comments panel (under "+ Add note").
          The disk only shows the approved state now, never the action. */}
      {isApproved && (
        <span
          data-slowcook-overlay-ui="1"
          title="Mockup approved — comment thread stays open for follow-up; plate refuses to amend"
          style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            padding: "6px 12px", borderRadius: 999, background: APPROVED_GREEN,
            color: "white", fontWeight: 700, fontSize: 13,
          }}
        >
          ✓ Approved
        </span>
      )}
      {/* 0.6.11 — comments-list toggle + sign-in only show in Comment mode;
          Nav mode stays minimal (just the toggle). */}
      {mode === "comment" && (
      <button
        type="button"
        onClick={onListSafe}
        disabled={disabled}
        title={`See all comments (${commentCount})`}
        style={{
          background: T.sub,
          color: T.fg,
          border: "none",
          padding: "5px 10px",
          borderRadius: 999,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.6 : 1,
          font: "inherit",
          fontSize: 12,
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
        }}
      >
        💬 Comments {commentCount > 0 && (
          <span style={{
            background: ACCENT,
            color: "white",
            borderRadius: 999,
            padding: "0 6px",
            fontSize: 10,
            fontWeight: 700,
            minWidth: 14,
            textAlign: "center",
          }}>{commentCount}</span>
        )}
      </button>
      )}
      {/* 0.7.1 — persona picker ("Viewing as") — a primary review control; row 1.
          Review mode only (nav shows just the switch). */}
      {mode === "comment" && surfaces.length > 0 && <SurfaceSwitcher surfaces={surfaces} onNavigate={onNavigate} disabled={disabled} />}
      </div>{/* /row 1 */}

      {/* Row 2 — secondary controls, review mode only: Docs · identity · timer.
          Nav mode renders none of these, so the pill is as narrow as the switch. */}
      {mode === "comment" && (docsEnabled || askEnabled || reviewMode === "lcr" || accessory != null) && (
      <div style={{ display: "flex", alignItems: "center", flexWrap: "nowrap", whiteSpace: "nowrap", gap: 4 }}>
        {/* 0.16.0 — Ask: two-way chat with a repo-aware Claude agent. */}
        {askEnabled && (
          <button
            type="button"
            onClick={() => { setConfirmLogout(false); onAskClick(); }}
            disabled={disabled}
            title="Ask the QA co-pilot — a repo-aware Claude agent (explain code, record a decision, open a PR)"
            style={{
              background: T.sub, color: T.fg, border: "none", padding: "5px 10px", borderRadius: 999,
              cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1,
              font: "inherit", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5,
            }}
          >
            💬 Ask
          </button>
        )}
        {/* 0.7.0 — Docs (textual review): read + edit the spec docs. */}
        {docsEnabled && (
          <button
            type="button"
            onClick={() => { setConfirmLogout(false); onDocsClick(); }}
            disabled={disabled}
            title="Review & edit the spec docs (textual review)"
            style={{
              background: T.sub, color: T.fg, border: "none", padding: "5px 10px", borderRadius: 999,
              cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1,
              font: "inherit", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5,
            }}
          >
            📄 Docs
          </button>
        )}
        {/* 0.6.2 — LCR per-reviewer sign-in / identity. */}
        {reviewMode === "lcr" && (
          identity ? (
            <span
              title={confirmLogout
                ? "Click again to sign out (or click anything else to cancel)"
                : identity.canApply
                ? `Signed in as @${identity.login} — you have write access, so your comments are applied`
                : `Signed in as @${identity.login} — no write access, so your feedback is gathered for the team to review (not auto-applied)`}
              onClick={() => { if (confirmLogout) { setConfirmLogout(false); onSignOut(); } else { setConfirmLogout(true); } }}
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "4px 10px 4px 4px", borderRadius: 999, cursor: "pointer",
                background: confirmLogout ? "rgba(255,107,107,0.25)" : T.sub,
                border: confirmLogout ? "1px solid rgba(255,107,107,0.7)" : "1px solid transparent",
                color: confirmLogout ? (dark ? "white" : "#a8071a") : T.fg, fontSize: 12, fontWeight: 600,
              }}
            >
              {confirmLogout ? (
                <><span aria-hidden>🚪</span> Sign out?</>
              ) : (
                <>
                  {identity.avatarUrl
                    ? <img src={identity.avatarUrl} alt="" width={20} height={20} style={{ borderRadius: "50%" }} />
                    : <span aria-hidden style={{ width: 20, height: 20, borderRadius: "50%", background: "rgba(255,255,255,0.2)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11 }}>👤</span>}
                  @{identity.login}
                </>
              )}
            </span>
          ) : (
            <button
              type="button"
              onClick={onSignIn}
              disabled={disabled}
              title="Sign in with GitHub to comment as yourself"
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "6px 12px", borderRadius: 999, border: "none",
                background: T.ghBg, color: T.ghFg, cursor: disabled ? "not-allowed" : "pointer",
                font: "inherit", fontSize: 12, fontWeight: 700,
              }}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill={T.ghFg} aria-hidden="true">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
              </svg>
              Sign in
            </button>
          )
        )}
        {accessory}
      </div>
      )}

      {/* 0.9.1/0.9.5 — EPSS current location: always shown, small font, both
          modes. 0.9.5 — it's now LIVE: reflects the surface the reviewer is
          actually on (reactive to navigation), not just the last pick. Tapping
          it opens the jump palette. Wraps instead of widening the pill. */}
      {surfaceManifest && surfaceManifest.epics.length > 0 && (() => {
        const sel = getSelection();
        const crumb = liveSurfaceLabel(surfaceManifest, sel, currentPath);
        const hint = activeHint(surfaceManifest, sel, currentPath);
        return (
          <>
            <button
              type="button"
              data-slowcook-overlay-ui="1"
              data-testid="epss-status"
              onClick={() => setPaletteOpen(true)}
              title={crumb ? `${crumb} — tap to jump` : "No surface selected — tap to jump"}
              style={{
                width: "100%", maxWidth: "100%", display: "block", textAlign: "start",
                padding: "0 2px 1px", margin: 0, border: "none", background: "transparent",
                color: T.fgDim, cursor: "pointer", font: "inherit", fontSize: 9.5, lineHeight: 1.25,
                whiteSpace: "normal", overflowWrap: "anywhere", wordBreak: "break-word",
              }}
            >
              {crumb ?? "no surface selected"}
            </button>
            {/* 0.9.5 — on an anonymous (login/OTP) surface, a distinct-colour hint
                telling the reviewer HOW to enter (test OTP / email / masterkey). */}
            {hint && (
              <div
                data-slowcook-overlay-ui="1"
                data-testid="epss-hint"
                style={{
                  width: "100%", maxWidth: "100%", padding: "1px 2px 0", margin: 0,
                  color: dark ? "#ffd27a" : "#a8660a", font: "inherit", fontSize: 9.5,
                  lineHeight: 1.25, whiteSpace: "normal", overflowWrap: "anywhere", wordBreak: "break-word",
                }}
              >
                🔑 {hint}
              </div>
            )}
          </>
        );
      })()}
      </div>{/* /content column */}
      {paletteOpen && surfaceManifest && (
        <SurfacePalette
          manifest={surfaceManifest}
          onClose={() => setPaletteOpen(false)}
          onPick={(epicId, contextId, scenarioId, stateId) => {
            const url = applySelection(surfaceManifest, epicId, contextId, scenarioId, stateId);
            setPaletteOpen(false);
            if (url && typeof window !== "undefined") window.location.assign(url);
          }}
        />
      )}
    </div>
  );
}

/**
 * 0.9.0 — centered "jump" palette (browse-first: the full grouped list shows
 * Spotlight-style: a floating search bar that only reveals results once you've
 * typed ≥ 3 characters (no big upfront list). Follows the system colour scheme.
 * Tapping a result jumps there (the caller's onPick resolves becomes/anonymous + nav).
 */
const PALETTE_MIN_CHARS = 3;
function SurfacePalette(props: {
  manifest: Manifest;
  onClose: () => void;
  onPick: (epicId: string, contextId: string, scenarioId: string, stateId: string) => void;
}): JSX.Element {
  const { manifest, onClose, onPick } = props;
  const dark = usePrefersDark();
  const S = sheetTheme(dark);
  const [q, setQ] = useState("");
  // 0.9.7 — "list all" affordance: the ☰ button reveals the full grouped list
  // without the ≥3-char spotlight gate (an empty query matches every row).
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sel = getSelection();
  interface Row { epicId: string; contextId: string; scenarioId: string; stateId: string; epicLabel: string; ctxLabel: string; scnLabel: string; stLabel: string; hard?: boolean; becomes?: boolean; q: string }
  const query = q.trim();
  // Spotlight: results after ≥3 chars — OR show everything when "list all" is on.
  const show = showAll || query.length >= PALETTE_MIN_CHARS;
  const groups: { key: string; rows: Row[] }[] = [];
  let count = 0;
  if (show) {
    const rows: Row[] = [];
    for (const epic of manifest.epics)
      for (const ctx of epic.contexts)
        for (const scn of ctx.scenarios)
          for (const st of scn.states)
            rows.push({ epicId: epic.id, contextId: ctx.id, scenarioId: scn.id, stateId: st.id, epicLabel: epic.label, ctxLabel: ctx.label, scnLabel: scn.label, stLabel: st.label, hard: st.hard, becomes: !!st.becomes, q: `${epic.label} ${ctx.label} ${scn.label} ${st.label}`.toLowerCase() });
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matched = rows.filter((r) => terms.every((t) => r.q.includes(t)));
    count = matched.length;
    for (const r of matched) {
      const key = `${r.epicLabel} · ${r.ctxLabel}`;
      let g = groups.find((x) => x.key === key);
      if (!g) { g = { key, rows: [] }; groups.push(g); }
      g.rows.push(r);
    }
  }

  return (
    <div data-slowcook-overlay-ui="1" onClick={onClose}
      style={{ position: "fixed", inset: 0, background: S.backdrop, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "12vh", pointerEvents: "auto", zIndex: 2147483647 }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Jump to a surface"
        style={{ background: S.sheet, color: S.fg, borderRadius: 14, width: 440, maxWidth: "94vw", maxHeight: "72vh", display: "flex", flexDirection: "column", boxShadow: "0 16px 48px rgba(0,0,0,0.4)", border: `1px solid ${S.border}`, fontFamily: "system-ui, -apple-system, sans-serif", overflow: "hidden" }}>
        {/* Spotlight bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 14px" }}>
          <span aria-hidden style={{ fontSize: 16, opacity: 0.8 }}>🎛</span>
          {/* The shadow-firewall pins generic overlay inputs to light (#fff) with
              !important so a host's dark theme can't touch the comment box. This
              palette follows the SYSTEM theme, so override it with a higher-
              specificity (class) themed rule. */}
          <style dangerouslySetInnerHTML={{ __html:
            `[data-slowcook-overlay-ui] input.sc-ovl-palette-input{background-color:${S.input} !important;color:${S.fg} !important;-webkit-text-fill-color:${S.fg} !important;border-color:${S.inputBorder} !important;caret-color:${S.fg} !important;}` +
            `[data-slowcook-overlay-ui] input.sc-ovl-palette-input::placeholder{color:${S.fgDim} !important;-webkit-text-fill-color:${S.fgDim} !important;}`
          }} />
          <input className="sc-ovl-palette-input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Jump to a surface / state…" aria-label="Search surfaces"
            style={{ flex: 1, minWidth: 0, outline: "none", fontSize: 16, padding: "8px 10px", borderRadius: 8, borderStyle: "solid", borderWidth: 1, appearance: "none", WebkitAppearance: "none", colorScheme: dark ? "dark" : "light" }} />
          {q && <button type="button" aria-label="Clear" onClick={() => setQ("")} style={{ border: "none", background: "transparent", color: S.fgDim, cursor: "pointer", fontSize: 16, lineHeight: 1 }}>×</button>}
          <button type="button" aria-label="List all surfaces" title="List all surfaces" aria-pressed={showAll}
            onClick={() => setShowAll((v) => !v)}
            style={{ flexShrink: 0, border: `1px solid ${S.inputBorder}`, background: showAll ? S.rowActive : "transparent", color: S.fg, cursor: "pointer", fontSize: 12.5, fontWeight: 600, lineHeight: 1, borderRadius: 8, padding: "7px 10px" }}>☰ All</button>
        </div>
        {query.length > 0 && !show && (
          <div style={{ borderTop: `1px solid ${S.border}`, padding: "12px 16px", fontSize: 12.5, color: S.fgDim }}>Keep typing… ({PALETTE_MIN_CHARS}+ letters) — or tap <b>☰ All</b> to list everything.</div>
        )}
        {!show && query.length === 0 && (
          <div style={{ borderTop: `1px solid ${S.border}`, padding: "12px 16px", fontSize: 12.5, color: S.fgDim }}>Type to search, or tap <b>☰ All</b> to list every surface.</div>
        )}
        {show && (
          <div style={{ borderTop: `1px solid ${S.border}`, overflow: "auto", padding: "4px 8px 8px" }}>
            {count === 0 && <div style={{ padding: 16, color: S.fgDim, fontSize: 13 }}>No surface matches “{query}”.</div>}
            {groups.map((g) => (
              <div key={g.key} style={{ marginBottom: 4 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: S.header, textTransform: "uppercase", letterSpacing: 0.3, padding: "8px 6px 3px" }}>{g.key}</div>
                {g.rows.map((r) => {
                  const active = sel?.contextId === r.contextId && sel?.scenarioId === r.scenarioId && sel?.stateId === r.stateId;
                  return (
                    <button key={r.epicId + r.contextId + r.scenarioId + r.stateId} type="button"
                      onClick={() => onPick(r.epicId, r.contextId, r.scenarioId, r.stateId)}
                      style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "8px", border: "none", borderRadius: 8, background: active ? S.rowActive : "transparent", cursor: "pointer", font: "inherit", fontSize: 13, color: S.fg }}
                      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = S.rowHover; }}
                      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}>
                      <span aria-hidden style={{ flexShrink: 0, width: 16, textAlign: "center" }}>{r.hard ? "⚡" : r.becomes ? "➡" : "·"}</span>
                      <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        <span style={{ fontWeight: 600 }}>{r.stLabel}</span>
                        <span style={{ color: S.fgDim, fontSize: 11.5 }}>{"  ·  "}{r.scnLabel}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Two-step approval confirm — guards against fat-finger taps on the
 * Approve toggle. Renders a small dialog near the toggle with a clear
 * Cancel / Approve choice. Submitting state shows on the Approve button.
 */
function ApproveConfirm(props: {
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
  submitting: boolean;
}): JSX.Element {
  return (
    <div
      data-slowcook-overlay-ui="1"
      role="dialog"
      aria-label="Confirm approval"
      style={{
        position: "absolute",
        top: 64,
        right: 12,
        width: 280,
        background: "white",
        color: "#1a1a1a",
        borderRadius: 10,
        padding: 16,
        boxShadow: "0 12px 40px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.06)",
        pointerEvents: "auto",
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: 13,
        lineHeight: 1.45,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 14 }}>
        Approve this mockup?
      </div>
      <div style={{ opacity: 0.75, marginBottom: 12 }}>
        Posts an approval comment + requests the
        {" "}
        <code style={{ fontSize: 11, padding: "1px 4px", background: "rgba(0,0,0,0.06)", borderRadius: 3 }}>
          slowcook-mockup-approved
        </code>
        {" "}
        label. Plate refuses further amendments after that lands.
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button
          type="button"
          onClick={props.onCancel}
          disabled={props.submitting}
          style={{
            background: "transparent",
            border: "1px solid rgba(0,0,0,0.18)",
            padding: "6px 12px",
            borderRadius: 6,
            cursor: "pointer",
            font: "inherit",
            color: "#1a1a1a",
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void props.onConfirm()}
          disabled={props.submitting}
          style={{
            background: "#22c55e",
            color: "white",
            border: "none",
            padding: "6px 14px",
            borderRadius: 6,
            cursor: props.submitting ? "not-allowed" : "pointer",
            opacity: props.submitting ? 0.6 : 1,
            font: "inherit",
            fontWeight: 600,
          }}
        >
          {props.submitting ? "Approving…" : "✅ Approve"}
        </button>
      </div>
    </div>
  );
}

/**
 * Slowcook brand mark — a slow-cook pot with three steam wisps.
 * Inline SVG; no asset dependency. 18×18px; fill currentColor so
 * it inherits the toggle's white text.
 */
function SlowcookLogo(): JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-label="slowcook"
      role="img"
      style={{ flexShrink: 0, marginLeft: 2 }}
    >
      {/* Steam wisps — small S-curves above the lid. */}
      <path
        d="M8 3 Q9 4 8 5.5 Q7 7 8 8.5 M12 2 Q13 3.5 12 5 Q11 6.5 12 8 M16 3 Q17 4 16 5.5 Q15 7 16 8.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        fill="none"
        opacity="0.85"
      />
      {/* Lid — slim rectangle with a small knob notch. */}
      <rect x="4" y="9.5" width="16" height="2.2" rx="1.1" fill="currentColor" />
      <rect x="11" y="8.4" width="2" height="1.4" rx="0.4" fill="currentColor" />
      {/* Pot body — rounded-bottom rectangle. */}
      <path
        d="M5 12.2 H19 V18.5 a2.5 2.5 0 0 1 -2.5 2.5 H7.5 a2.5 2.5 0 0 1 -2.5 -2.5 Z"
        fill="currentColor"
      />
      {/* Side handles — small bumps. */}
      <rect x="2" y="13.5" width="2.5" height="3" rx="0.6" fill="currentColor" />
      <rect x="19.5" y="13.5" width="2.5" height="3" rx="0.6" fill="currentColor" />
    </svg>
  );
}

function ToggleButton(props: { active: boolean; onClick: () => void; disabled: boolean; label: string; title?: string; accent?: boolean; approve?: boolean; badge?: number; fg?: string }): JSX.Element {
  const bg = props.active
    ? props.approve
      ? "#22c55e"
      : props.accent
      ? ACCENT
      : "rgba(255,255,255,0.18)"
    : "transparent";
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      style={{
        position: "relative",
        background: bg,
        // active state sits on a coloured bg → white; idle follows the theme.
        color: props.active ? "white" : (props.fg ?? "white"),
        border: "none",
        padding: "6px 12px",
        borderRadius: 999,
        cursor: props.disabled ? "not-allowed" : "pointer",
        opacity: props.disabled ? 0.6 : 1,
        font: "inherit",
      }}
    >
      {props.label}
      {/* 0.6.8 — green "new activity" badge (new replies / newly-applied). */}
      {props.badge ? (
        <span style={{
          position: "absolute", top: -5, right: -5, minWidth: 16, height: 16,
          padding: "0 4px", borderRadius: 999, background: "#22c55e", color: "white",
          fontSize: 10, fontWeight: 800, display: "inline-flex", alignItems: "center",
          justifyContent: "center", boxShadow: "0 0 0 2px rgba(15,15,24,0.92)",
        }}>{props.badge}</span>
      ) : null}
    </button>
  );
}

/**
 * 0.6.13 — page-context badge in the composer so the reviewer sees which page
 * the comment is on (route + the story it declares, if any) before submitting.
 */
function PageBadge(): JSX.Element | null {
  // 0.9.2 — follow the system scheme. Was hardcoded #3a3a3a, which is illegible
  // on the now dark-themed composer.
  const dark = usePrefersDark();
  if (typeof window === "undefined") return null;
  const route = window.location.pathname + window.location.search;
  const story = readCurrentStory();
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 6, maxWidth: "100%",
      fontSize: 11.5, color: dark ? "#ffc2c2" : "#3a3a3a",
      background: dark ? "rgba(255,107,107,0.16)" : "rgba(255,107,107,0.10)",
      border: "1px solid rgba(255,107,107,0.30)", borderRadius: 6,
      padding: "3px 9px", marginBottom: 8,
    }}>
      <span aria-hidden>📄</span>
      <span style={{ fontFamily: "ui-monospace, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{route}</span>
      {story && <span style={{ fontWeight: 700, color: dark ? "#ff9ec2" : "#d6336c" }}>· story-{story}</span>}
    </div>
  );
}

/**
 * 0.9.1 — themed override for composer textareas. The shadow-firewall pins every
 * overlay input/textarea to light (#fff !important) so a host dark theme can't
 * bleed onto the comment box; but the composer now follows the SYSTEM scheme, so
 * re-theme its fields with a higher-specificity (element+class) !important rule.
 */
function ComposerInputTheme({ S }: { S: SheetTheme }): JSX.Element {
  return (
    <style dangerouslySetInnerHTML={{ __html:
      `[data-slowcook-overlay-ui] textarea.sc-ovl-composer-input,[data-slowcook-overlay-ui] input.sc-ovl-composer-input{background-color:${S.input} !important;color:${S.fg} !important;-webkit-text-fill-color:${S.fg} !important;border-color:${S.inputBorder} !important;caret-color:${S.fg} !important;}` +
      `[data-slowcook-overlay-ui] textarea.sc-ovl-composer-input::placeholder{color:${S.fgDim} !important;-webkit-text-fill-color:${S.fgDim} !important;}`
    }} />
  );
}

function Composer(props: {
  target: Element;
  onCancel: () => void;
  onSubmit: (prose: string) => Promise<void>;
  submitting: boolean;
  composerRef: React.MutableRefObject<HTMLDivElement | null>;
}): JSX.Element {
  const [prose, setProse] = useState("");
  const sel = extractSelector(props.target);
  const rect = props.target.getBoundingClientRect();
  // 0.9.1 — follow the SYSTEM colour scheme (the overlay is shadow-isolated from
  // the app theme), matching the jump palette. Was hardcoded white.
  const dark = usePrefersDark();
  const S = sheetTheme(dark);

  // Position popup near the target — Figma-style anchoring. Try below
  // the element first; fall back to above; clamp to viewport so it
  // never sits off-screen. Width 320, max-height 70vh.
  const POPUP_WIDTH = 320;
  const POPUP_GAP = 8;
  const PADDING = 12;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
  const vh = typeof window !== "undefined" ? window.innerHeight : 768;
  const maxHeight = Math.floor(vh * 0.7);

  // Horizontal: anchor to target.left, but clamp so right edge stays in viewport.
  let left = rect.left;
  if (left + POPUP_WIDTH + PADDING > vw) left = vw - POPUP_WIDTH - PADDING;
  if (left < PADDING) left = PADDING;

  // Vertical: try below the element. If not enough room, place above.
  // If neither fits cleanly, clamp the top.
  const spaceBelow = vh - rect.bottom - PADDING;
  const spaceAbove = rect.top - PADDING;
  let top: number;
  if (spaceBelow >= 200 || spaceBelow >= spaceAbove) {
    top = rect.bottom + POPUP_GAP;
    // Clamp to keep popup body in viewport (assume body height ~280 typical).
    if (top + 280 > vh - PADDING && top - 280 > PADDING) {
      top = Math.max(PADDING, vh - 280 - PADDING);
    }
  } else {
    top = Math.max(PADDING, rect.top - POPUP_GAP - 280);
  }

  return (
    <>
      <div
        style={{
          position: "fixed",
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
          border: `2px solid ${ACCENT}`,
          outlineOffset: -2,
          pointerEvents: "none",
          zIndex: 2147483646,
        }}
        aria-hidden="true"
      />
      <div
        ref={props.composerRef}
        data-slowcook-overlay-ui="1"
        role="dialog"
        aria-label="Review comment"
        style={{
          position: "fixed",
          left,
          top,
          width: POPUP_WIDTH,
          maxHeight,
          overflow: "auto",
          background: S.sheet,
          color: S.fg,
          borderRadius: 8,
          boxShadow: `0 12px 40px rgba(0,0,0,0.3)`,
          border: `1px solid ${S.border}`,
          padding: 16,
          pointerEvents: "auto",
          fontFamily: "system-ui, -apple-system, sans-serif",
          fontSize: 13,
          zIndex: 2147483647,
        }}
      >
        <ComposerInputTheme S={S} />
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Review comment</div>
        <PageBadge />
        <div style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 11, color: S.fgDim, marginBottom: 8, wordBreak: "break-all" }}>
          {sel.selector}
        </div>
        <textarea
          className="sc-ovl-composer-input"
          aria-label="Comment text"
          autoFocus
          value={prose}
          onChange={(e) => setProse(e.target.value)}
          placeholder="What's off about this element?"
          rows={5}
          style={{
            width: "100%",
            padding: 8,
            borderRadius: 6,
            borderStyle: "solid",
            borderWidth: 1,
            font: "inherit",
            fontSize: 16, // 0.6.12 — ≥16px stops iOS Safari auto-zooming on focus
            resize: "vertical",
            boxSizing: "border-box",
            colorScheme: dark ? "dark" : "light",
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button
            type="button"
            onClick={props.onCancel}
            disabled={props.submitting}
            style={{
              background: "transparent",
              border: `1px solid ${S.inputBorder}`,
              color: S.fg,
              padding: "6px 12px",
              borderRadius: 6,
              cursor: "pointer",
              font: "inherit",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={props.submitting || prose.trim() === ""}
            onClick={() => void props.onSubmit(prose.trim())}
            style={{
              background: ACCENT,
              color: "white",
              border: "none",
              padding: "6px 14px",
              borderRadius: 6,
              cursor: props.submitting ? "not-allowed" : "pointer",
              opacity: props.submitting || prose.trim() === "" ? 0.6 : 1,
              font: "inherit",
              fontWeight: 600,
            }}
          >
            {props.submitting ? "Submitting…" : "Submit"}
          </button>
        </div>
      </div>
    </>
  );
}

function FeedbackToast(props: { text: string; onDismiss: () => void }): JSX.Element {
  useEffect(() => {
    const t = setTimeout(props.onDismiss, 4000);
    return () => clearTimeout(t);
  }, [props]);
  return (
    <div
      data-slowcook-overlay-ui="1"
      style={{
        position: "absolute",
        bottom: 24,
        right: 24,
        background: "rgba(15, 15, 24, 0.92)",
        color: "white",
        padding: "10px 16px",
        borderRadius: 8,
        boxShadow: "0 4px 14px rgba(0,0,0,0.3)",
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: 13,
        pointerEvents: "auto",
        maxWidth: 320,
      }}
      role="status"
    >
      {props.text}
    </div>
  );
}

/**
 * Localhost gh-proxy URL exported by `slowcook run-mock` (cli ≥ 0.18.0-α.2).
 * When set, the overlay routes every GitHub API call through the proxy
 * and skips the PAT prompt — proxy substitutes its own gh token. Returns
 * null in production builds (env var absent → Next inlines undefined).
 */
function getProxyApiBase(): string | null {
  const v = (typeof process !== "undefined" ? process.env?.["NEXT_PUBLIC_SLOWCOOK_GH_PROXY"] : undefined) ?? null;
  return v && v.length > 0 ? v.replace(/\/$/, "") : null;
}

const PROXY_PAT_SENTINEL = "__slowcook_proxy__";

function ensurePat(repo: RepoCoord, lcr = false): string | null {
  // 0.6.0 — LCR multi-person review: post as the signed-in reviewer using
  // their own device-flow token. No prompt — the "Sign in with GitHub" UI
  // drives acquisition; null here means "not signed in yet".
  if (lcr) {
    if (typeof window === "undefined") return null;
    return loadReviewerToken(window.localStorage, repo);
  }
  // Proxy mode: skip prompt + storage; the proxy ignores the
  // Authorization header and signs upstream with `gh auth token`.
  if (getProxyApiBase()) return PROXY_PAT_SENTINEL;
  // Try localStorage first; fall back to a window.prompt() the first
  // time. The PAT scopes the consumer needs are public_repo (or repo
  // for private). Storing in localStorage keeps it scoped to the
  // preview origin.
  if (typeof window === "undefined") return null;
  let pat = loadPat(window.localStorage, repo);
  if (pat) return pat;
  const entered = window.prompt(
    `Slowcook needs a GitHub PAT (scope: public_repo or repo) to post a comment on ${repo.owner}/${repo.repo}.\n\nIt will be stored only in this browser's localStorage for ${repo.owner}/${repo.repo}.\n\n(Run \`slowcook run-mock\` instead to skip this prompt — it spawns a localhost proxy that uses your local 'gh auth token'.)`
  );
  if (!entered || entered.trim() === "") return null;
  pat = entered.trim();
  savePat(window.localStorage, repo, pat);
  return pat;
}

/**
 * 0.3.0 — Figma-style pin layer.
 *
 * For each fetched overlay-comment record:
 *   1. Try to resolve the stored selector to a live element.
 *   2. If found, render a small pin icon at the element's top-right.
 *   3. If selector misses, render at the stored bbox coords with a
 *      "drifted" indicator so PM knows the anchor is stale.
 *
 * Pin icon picks status from `record.plateReply.status`:
 *   - null            → 💬 (red coral, unresolved)
 *   - "applied"       → ✓  (green, plate amended)
 *   - "declined"      → ⊘  (gray, plate read but didn't act)
 *   - "spec-altering" → !  (yellow, plate escalated)
 *   - "noop"          → •  (gray, plate considered + no change)
 *
 * Click → CommentThreadPopover with prose + plate's reply summary +
 * link to the GitHub comment.
 *
 * Pins recompute position on resize / scroll via a single requestAnimationFrame
 * loop — cheap (one matrix per pin per frame) and keeps the layer
 * sticky to the underlying DOM.
 */
function CommentPins(props: {
  records: OverlayCommentRecord[];
  showApplied: boolean;
  openCommentId: number | null;
  onOpen: (id: number) => void;
  onClose: () => void;
  flashCommentId?: number | null;
}): JSX.Element {
  const { records: allRecords, showApplied, openCommentId, onOpen, onClose, flashCommentId } = props;
  // Hide pins for resolved/applied comments unless the reviewer has asked to
  // see them (the same "show applied" toggle that governs the list). An open
  // pin stays visible so "Locate from list" still works.
  const records = allRecords.filter(
    (r) =>
      showApplied ||
      r.commentId === openCommentId ||
      !(r.plateReply != null && isResolvedStatus(r.plateReply.status)),
  );
  // tick forces a re-render on every animation frame so pins follow
  // the underlying DOM as the page scrolls / reflows.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let raf = 0;
    let alive = true;
    const loop = () => {
      if (!alive) return;
      setTick((n) => (n + 1) % 1_000_000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, []);
  void tick;

  const placements = records.map((r) => {
    // 0.5.0 — records without an element shouldn't reach here; the
    // caller filters them out. Defensive null-check anyway.
    if (!r.payload.element) {
      return { record: r, rect: { x: -100, y: -100 }, drifted: true };
    }
    const resolved = typeof document !== "undefined"
      ? resolveAnchor(document, r.payload.element)
      : null;
    let rect: { x: number; y: number };
    let drifted = false;
    if (resolved) {
      const dom = resolved.element.getBoundingClientRect();
      // 0.5.0 — also detect "element exists but is hidden" (zero-area
      // bounding rect, or display:none ancestor → offsetParent null).
      // Treat as drifted so the pin doesn't render at (0,0) on top
      // of the page corner.
      const isHidden =
        (dom.width === 0 && dom.height === 0) ||
        (resolved.element as HTMLElement).offsetParent === null;
      if (isHidden) {
        rect = { x: r.payload.element.bbox.x + r.payload.element.bbox.w - 14, y: r.payload.element.bbox.y - 8 };
        drifted = true;
      } else {
        rect = { x: dom.right - 14, y: dom.top - 8 };
      }
      try {
        (resolved.element as HTMLElement).setAttribute(
          "data-slowcook-comment-id",
          String(r.commentId)
        );
      } catch { /* read-only nodes etc. */ }
    } else {
      rect = { x: r.payload.element.bbox.x + r.payload.element.bbox.w - 14, y: r.payload.element.bbox.y - 8 };
      drifted = true;
    }
    return { record: r, rect, drifted };
  });

  return (
    <div data-slowcook-overlay-ui="1" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      {/* Only render pins that track a live element. Drifted comments (selector
          no longer resolves) used to render a frozen placeholder at the capture
          bbox that didn't move on scroll — misleading. They now live only in the
          sidebar list. A pin opened from the list (its id matches) still renders
          so "Locate" has something to point at. */}
      {placements
        .filter(({ record, drifted }) => !drifted || record.commentId === openCommentId)
        .map(({ record, rect, drifted }) => (
          <PinIcon
            key={record.commentId}
            record={record}
            x={rect.x}
            y={rect.y}
            drifted={drifted}
            flashing={flashCommentId === record.commentId}
            onClick={() => onOpen(record.commentId)}
          />
        ))}
      {openCommentId !== null && (() => {
        const placement = placements.find((p) => p.record.commentId === openCommentId);
        if (!placement) return null;
        return (
          <CommentThreadPopover
            record={placement.record}
            anchorX={placement.rect.x}
            anchorY={placement.rect.y}
            drifted={placement.drifted}
            onClose={onClose}
          />
        );
      })()}
    </div>
  );
}

function pinPalette(status: OverlayCommentRecord["plateReply"] extends infer R ? (R extends { status: infer S } ? S : null) : null, drifted: boolean): { bg: string; fg: string; glyph: string; ring: string } {
  if (drifted) return { bg: "#facc15", fg: "#1a1a1a", glyph: "⚠", ring: "rgba(250, 204, 21, 0.35)" };
  switch (status) {
    case "applied":       return { bg: "#22c55e", fg: "white",   glyph: "✓", ring: "rgba(34, 197, 94, 0.35)" };
    case "declined":      return { bg: "#94a3b8", fg: "white",   glyph: "⊘", ring: "rgba(148, 163, 184, 0.35)" };
    case "spec-altering": return { bg: "#facc15", fg: "#1a1a1a", glyph: "!", ring: "rgba(250, 204, 21, 0.35)" };
    case "noop":          return { bg: "#94a3b8", fg: "white",   glyph: "•", ring: "rgba(148, 163, 184, 0.35)" };
    case "needs-clarification": return { bg: "#4D96FF", fg: "white", glyph: "?", ring: "rgba(77, 150, 255, 0.35)" };
    default:              return { bg: ACCENT,    fg: "white",   glyph: "💬", ring: "rgba(255, 107, 107, 0.35)" };
  }
}

/** Per-author colour — Figma-style. Hashes the FULL author handle to a hue, so
 *  two reviewers with the same initial still get distinct colours. */
function authorColor(author: string): { bg: string; ring: string } {
  let h = 0;
  for (let i = 0; i < author.length; i++) h = (h * 31 + author.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return { bg: `hsl(${hue}, 58%, 42%)`, ring: `hsla(${hue}, 58%, 42%, 0.35)` };
}
/** First alphanumeric character of the author handle, uppercased. */
function authorInitial(author: string): string {
  const m = author.replace(/[^a-zA-Z0-9]/g, "");
  return (m[0] ?? "?").toUpperCase();
}

function PinIcon(props: {
  record: OverlayCommentRecord;
  x: number;
  y: number;
  drifted: boolean;
  flashing?: boolean;
  onClick: () => void;
}): JSX.Element {
  const author = props.record.author || "unknown";
  const status = props.record.plateReply?.status ?? null;
  const col = authorColor(author);
  // Status is shown as a small corner badge (not the whole pin) so the pin's
  // body can carry the author's identity instead. No badge for a plain
  // unresolved comment; drifted/resolved states get one.
  const statusBadge = props.drifted
    ? pinPalette(null as never, true)
    : status
    ? pinPalette(status as never, false)
    : null;
  const title = `@${author}${props.drifted ? " · selector drifted" : status ? ` · ${status}` : ""} · click to view`;
  return (
    <button
      type="button"
      data-slowcook-overlay-ui="1"
      data-slowcook-comment-id={props.record.commentId}
      title={title}
      onClick={(e) => { e.stopPropagation(); props.onClick(); }}
      style={{
        position: "absolute",
        left: props.x,
        top: props.y,
        width: 22,
        height: 22,
        borderRadius: 999,
        background: col.bg,
        color: "#fff",
        border: `2px solid white`,
        boxShadow: props.flashing
          ? `0 2px 6px rgba(0,0,0,0.25), 0 0 0 12px ${col.ring}`
          : `0 2px 6px rgba(0,0,0,0.25), 0 0 0 4px ${col.ring}`,
        transform: props.flashing ? "scale(1.4)" : "scale(1)",
        transition: "transform 220ms ease, box-shadow 220ms ease",
        cursor: "pointer",
        pointerEvents: "auto",
        fontSize: 11,
        fontWeight: 800,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        font: "inherit",
        padding: 0,
        lineHeight: 1,
      }}
    >
      {authorInitial(author)}
      {statusBadge && (
        <span
          aria-hidden
          style={{
            position: "absolute", top: -5, right: -5,
            width: 12, height: 12, borderRadius: 999,
            background: statusBadge.bg, color: statusBadge.fg,
            border: "1.5px solid white", fontSize: 8, fontWeight: 800,
            display: "flex", alignItems: "center", justifyContent: "center",
            lineHeight: 1,
          }}
        >
          {statusBadge.glyph}
        </span>
      )}
    </button>
  );
}

/**
 * Thread popover — opens above the pin (or below when near the
 * top edge). Shows: original prose + author + timestamp; plate's
 * reply summary if any; "Open on GitHub" links to both.
 */
function CommentThreadPopover(props: {
  record: OverlayCommentRecord;
  anchorX: number;
  anchorY: number;
  drifted: boolean;
  onClose: () => void;
}): JSX.Element {
  const { record } = props;
  const status = record.plateReply?.status ?? null;
  const palette = pinPalette(status as never, props.drifted);

  // Place popover; clamp to viewport so it doesn't run off-screen.
  const popWidth = 320;
  const popHeight = 220;
  const margin = 12;
  const viewW = typeof window !== "undefined" ? window.innerWidth : 1200;
  const viewH = typeof window !== "undefined" ? window.innerHeight : 800;
  let left = props.anchorX - popWidth / 2 + 11;
  if (left < margin) left = margin;
  if (left + popWidth + margin > viewW) left = viewW - popWidth - margin;
  let top = props.anchorY + 28;
  if (top + popHeight + margin > viewH) top = props.anchorY - popHeight - 16;
  if (top < margin) top = margin;

  return (
    <div
      data-slowcook-overlay-ui="1"
      role="dialog"
      aria-label="Comment thread"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        left,
        top,
        width: popWidth,
        maxHeight: "70vh",
        overflow: "auto",
        background: "white",
        color: "#1a1a1a",
        borderRadius: 10,
        padding: 14,
        boxShadow: "0 12px 40px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.08)",
        pointerEvents: "auto",
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: 13,
        lineHeight: 1.5,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          fontWeight: 600,
          padding: "2px 8px",
          borderRadius: 999,
          background: palette.bg,
          color: palette.fg,
          textTransform: "uppercase",
          letterSpacing: 0.4,
        }}>
          {palette.glyph} {props.drifted ? "drifted" : status ?? "unresolved"}
        </span>
        <button
          type="button"
          onClick={props.onClose}
          aria-label="Close"
          style={{
            background: "transparent",
            border: "none",
            color: "rgba(0,0,0,0.45)",
            cursor: "pointer",
            font: "inherit",
            fontSize: 18,
            lineHeight: 1,
            padding: 0,
          }}
        >
          ×
        </button>
      </div>

      {record.payload.element ? (
        <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 4, fontFamily: "ui-monospace, SFMono-Regular, monospace", wordBreak: "break-all" }}>
          {record.payload.element.selector}
        </div>
      ) : (
        <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 4, fontStyle: "italic" }}>
          page note · no element anchor
        </div>
      )}
      <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 10 }}>
        @{record.author} · {formatTimeAgo(record.createdAt)}
      </div>

      <div style={{ marginBottom: 12, whiteSpace: "pre-wrap" }}>
        {record.payload.prose}
      </div>

      {record.plateReply && (
        <div style={{
          marginTop: 12,
          padding: "10px 12px",
          background: "rgba(34, 197, 94, 0.08)",
          borderLeft: "3px solid #22c55e",
          borderRadius: 4,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: "#15803d", marginBottom: 4 }}>
            slowcook plate
          </div>
          <div style={{ whiteSpace: "pre-wrap" }}>{record.plateReply.summary}</div>
          {record.plateReply.files_touched && record.plateReply.files_touched.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 11, opacity: 0.7, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}>
              touched: {record.plateReply.files_touched.join(", ")}
            </div>
          )}
        </div>
      )}

      <div style={{ display: "flex", gap: 12, marginTop: 12, fontSize: 11 }}>
        <a href={record.htmlUrl} target="_blank" rel="noreferrer" style={{ color: ACCENT, textDecoration: "none" }}>
          ↗ Comment on GitHub
        </a>
        {record.plateCommentUrl && (
          <a href={record.plateCommentUrl} target="_blank" rel="noreferrer" style={{ color: "#22c55e", textDecoration: "none" }}>
            ↗ Reply on GitHub
          </a>
        )}
      </div>
    </div>
  );
}

function formatTimeAgo(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    const now = Date.now();
    const diffSec = Math.max(1, Math.round((now - then) / 1000));
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
    return `${Math.round(diffSec / 86400)}d ago`;
  } catch {
    return iso;
  }
}

/**
 * 0.5.0 — comments-list panel. Always reachable from the pill's "📋"
 * button. Surfaces ALL fetched comments, including:
 *   - element-anchored that resolve to a visible element (pin shows)
 *   - element-anchored to a HIDDEN element (no pin; only here)
 *   - general (no anchor) comments (no pin; only here)
 *
 * Top affordance: + Add general note. Each list item: status icon,
 * prose snippet, author + time, anchored / hidden / general badge.
 * Click an item: closes panel + opens the thread popover; if anchored
 * + visible, also flashes the pin in-place.
 */
function CommentsListPanel(props: {
  records: OverlayCommentRecord[];
  showApplied: boolean;
  onToggleApplied: () => void;
  onClose: () => void;
  onOpenComment: (id: number) => void;
  onAddGeneral: () => void;
  onApprove: () => void;
  isApproved: boolean;
}): JSX.Element {
  const { records, showApplied, onToggleApplied, onClose, onOpenComment, onAddGeneral, onApprove, isApproved } = props;
  // 0.6.14 — expand/collapse a row in place to read the full prose + reply,
  // open the GitHub issue, or (for anchored comments) locate the pin on the page.
  const [expandedId, setExpandedId] = useState<number | null>(null);
  // 0.6.0 — resolved comments (applied/declined/noop) hide by default so the
  // list shows what still needs attention; needs-clarification + unresolved
  // always show. The toggle reveals the resolved ones.
  const isResolved = (r: OverlayCommentRecord) => r.plateReply != null && isResolvedStatus(r.plateReply.status);
  const hiddenCount = records.filter(isResolved).length;
  const visible = showApplied ? records : records.filter((r) => !isResolved(r));
  // 0.9.2 — the side panel was hardcoded dark (illegible header in light mode,
  // off-theme in dark). Follow the system scheme like the composer/palette.
  const dark = usePrefersDark();
  const S = sheetTheme(dark);
  const cardBg = dark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.03)";
  // 0.9.4 — a distinct elevated header bar so the title reads as a header
  // instead of blending into the panel body (both schemes).
  const headerBg = dark ? "#23232e" : "#f4f5f7";
  return (
    <div
      data-slowcook-overlay-ui="1"
      role="dialog"
      aria-label="All comments"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: 360,
        maxWidth: "90vw",
        background: S.sheet,
        color: S.fg,
        boxShadow: "-12px 0 40px rgba(0,0,0,0.45)",
        pointerEvents: "auto",
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: 13,
        display: "flex",
        flexDirection: "column",
        borderLeft: `1px solid ${S.border}`,
      }}
    >
      <div style={{ padding: "14px 16px", background: headerBg, borderBottom: `1px solid ${S.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ fontWeight: 600 }}>Comments ({visible.length})</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close panel"
          style={{
            background: "transparent",
            border: "none",
            color: S.fgDim,
            cursor: "pointer",
            font: "inherit",
            fontSize: 18,
            lineHeight: 1,
            padding: 0,
          }}
        >
          ×
        </button>
      </div>
      <div style={{ padding: 12, borderBottom: `1px solid ${S.border}` }}>
        <button
          type="button"
          onClick={onAddGeneral}
          style={{
            width: "100%",
            padding: "10px 12px",
            background: "rgba(255,107,107,0.12)",
            color: ACCENT,
            border: `1px dashed ${ACCENT}`,
            borderRadius: 8,
            cursor: "pointer",
            font: "inherit",
            fontWeight: 600,
            fontSize: 13,
          }}
        >
          + Add note (about the page, not an element)
        </button>
        {/* 0.6.8 — Approve lives here now (out of the floating disk, where it was
            too easy to hit). It asks for confirmation before approving. */}
        <button
          type="button"
          onClick={isApproved ? undefined : onApprove}
          disabled={isApproved}
          title={isApproved ? "Mockup already approved" : "Approve the whole mockup (asks to confirm)"}
          style={{
            width: "100%", marginTop: 8, padding: "10px 12px",
            background: isApproved ? "rgba(34,197,94,0.15)" : "rgba(34,197,94,0.10)",
            color: APPROVED_GREEN, border: `1px solid ${APPROVED_GREEN}`,
            borderRadius: 8, cursor: isApproved ? "default" : "pointer",
            font: "inherit", fontWeight: 700, fontSize: 13,
          }}
        >
          {isApproved ? "✓ Mockup approved" : "✅ Approve mockup"}
        </button>
      </div>
      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={onToggleApplied}
          style={{ margin: "0 12px 8px", padding: "7px 10px", background: "transparent", color: S.fgDim, border: `1px solid ${S.inputBorder}`, borderRadius: 8, cursor: "pointer", font: "inherit", fontSize: 12 }}
        >
          {showApplied ? `Hide ${hiddenCount} already-applied` : `Show ${hiddenCount} already-applied`}
        </button>
      )}
      <div style={{ overflow: "auto", flex: 1, padding: 8 }}>
        {visible.length === 0 ? (
          <div style={{ padding: 16, opacity: 0.55, textAlign: "center", fontSize: 12 }}>
            {records.length === 0
              ? "No comments yet. Toggle 💬 Comment + click an element to anchor a comment, or use the button above for a page-level note."
              : "Nothing needs attention — all comments are applied. Use the toggle above to see them."}
          </div>
        ) : (
          (() => {
            // #198-overlay — separate page-level notes from element-anchored
            // comments into labelled groups; element comments are the ones that
            // get sticky pins, page notes live only here.
            const rows = visible.slice().reverse();
            const groups: Array<{ label: string; items: OverlayCommentRecord[] }> = [
              { label: "📍 On an element", items: rows.filter((r) => r.payload.element !== null) },
              { label: "📄 On the page", items: rows.filter((r) => r.payload.element === null) },
            ];
            const renderRow = (r: OverlayCommentRecord) => {
            const status = r.plateReply?.status ?? null;
            const palette = pinPalette(status as never, false);
            const anchored = r.payload.element !== null;
            const live = anchored && typeof document !== "undefined"
              ? resolveAnchor(document, r.payload.element!)
              : null;
            const hidden = anchored && live && (
              live.element.getBoundingClientRect().width === 0 ||
              (live.element as HTMLElement).offsetParent === null
            );
            // Mode-aware label colours — bright on dark, darker on light — so the
            // pill text stays readable whichever scheme the host app renders in.
            const grey = dark ? "#9aa6b6" : "#475569";
            // Quiet outline chips — no filled background. The colour carries the
            // meaning; a filled translucent pill read as a "bright background" in
            // the dark sidebar. Border at low alpha so it never competes with the
            // comment prose. (Colour-only `bg` is reused for the thin border.)
            const anchorLabel = !anchored
              ? { text: "note", color: grey }
              : !live
              ? { text: "drifted", color: dark ? "#fbbf24" : "#a16207" }
              : hidden
              ? { text: "hidden", color: grey }
              : { text: "anchored", color: dark ? "#34d399" : "#15803d" };
            const expanded = expandedId === r.commentId;
            const clamp = (lines: number) => expanded ? {} : { display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical" as const, overflow: "hidden" };
            return (
              <div
                key={r.commentId}
                style={{
                  background: cardBg,
                  border: `1px solid ${expanded ? S.inputBorder : S.border}`,
                  borderRadius: 8, padding: 10, marginBottom: 6, color: S.fg,
                }}
              >
                {/* Header — click toggles expand. */}
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : r.commentId)}
                  style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", color: S.fg, font: "inherit", cursor: "pointer" }}
                >
                  {/* Per-author identity disk (colour + initial), with the plate
                      status as a small corner badge — matches the on-page pins. */}
                  <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, borderRadius: 999, background: authorColor(r.author || "unknown").bg, color: "#fff", fontSize: 9, fontWeight: 800 }}>{authorInitial(r.author || "unknown")}</span>
                    {status && (
                      <span aria-hidden style={{ position: "absolute", top: -4, right: -4, width: 10, height: 10, borderRadius: 999, background: palette.bg, color: palette.fg, border: `1.5px solid ${S.sheet}`, fontSize: 7, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>{palette.glyph}</span>
                    )}
                  </span>
                  <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, padding: "1px 6px", borderRadius: 999, background: "transparent", border: `1px solid ${anchorLabel.color}`, opacity: 0.85, color: anchorLabel.color }}>{anchorLabel.text}</span>
                  <span style={{ fontSize: 10, opacity: 0.55, marginLeft: "auto" }}>@{r.author} · {formatTimeAgo(r.createdAt)}</span>
                  <span aria-hidden style={{ fontSize: 10, opacity: 0.55, transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▶</span>
                </button>
                <div style={{ fontSize: 12, opacity: 0.95, lineHeight: 1.4, marginTop: 4, ...clamp(3) }}>{r.payload.prose}</div>
                {r.plateReply?.summary && (
                  <div style={{ marginTop: 6, paddingTop: 6, borderTop: `1px solid ${S.border}`, fontSize: 11.5, lineHeight: 1.45, color: S.fgDim, whiteSpace: "pre-wrap", ...clamp(4) }}>
                    <span style={{ color: palette.bg, fontWeight: 700 }}>↳ reply: </span>{r.plateReply.summary}
                  </div>
                )}
                {/* Actions — always offer GitHub; locate only when anchored. */}
                <div style={{ display: "flex", gap: 12, marginTop: 8, fontSize: 11.5 }}>
                  <a href={r.htmlUrl} target="_blank" rel="noreferrer" style={{ color: dark ? "#7cc7ff" : "#0969da", textDecoration: "none" }}>↗ Open issue on GitHub</a>
                  {anchored && (
                    <button type="button" onClick={() => onOpenComment(r.commentId)} style={{ background: "transparent", border: "none", padding: 0, color: dark ? "#34d399" : "#15803d", font: "inherit", fontSize: 11.5, cursor: "pointer" }}>
                      📍 {live ? "Locate on page" : "Anchor drifted"}
                    </button>
                  )}
                  {!expanded && (r.payload.prose.length > 120 || (r.plateReply?.summary?.length ?? 0) > 180) && (
                    <button type="button" onClick={() => setExpandedId(r.commentId)} style={{ color: S.fgDim, font: "inherit", fontSize: 11.5, cursor: "pointer", marginLeft: "auto" }}>Expand</button>
                  )}
                </div>
              </div>
            );
            };
            return groups
              .filter((g) => g.items.length > 0)
              .map((g) => (
                <div key={g.label}>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: S.fgDim, padding: "10px 6px 4px" }}>
                    {g.label} · {g.items.length}
                  </div>
                  {g.items.map(renderRow)}
                </div>
              ));
          })()
        )}
      </div>
    </div>
  );
}

/**
 * 0.5.0 — composer for general (no-anchor) comments. Same shape as the
 * element-anchored composer but without the selector preview / element
 * outline. Centered modal.
 */
function GeneralComposer(props: {
  onCancel: () => void;
  onSubmit: (prose: string) => Promise<void>;
  submitting: boolean;
}): JSX.Element {
  const [prose, setProse] = useState("");
  // 0.9.1 — follow the SYSTEM colour scheme (was hardcoded white).
  const dark = usePrefersDark();
  const S = sheetTheme(dark);
  return (
    <div
      data-slowcook-overlay-ui="1"
      role="dialog"
      aria-label="General comment"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        width: 360,
        maxWidth: "90vw",
        background: S.sheet,
        color: S.fg,
        borderRadius: 10,
        padding: 16,
        boxShadow: `0 20px 60px rgba(0,0,0,0.45), 0 0 0 1px ${S.border}`,
        pointerEvents: "auto",
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: 13,
      }}
    >
      <ComposerInputTheme S={S} />
      <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 14 }}>Add page note</div>
      <PageBadge />
      <div style={{ fontSize: 12, opacity: 0.65, marginBottom: 10 }}>
        Comment about overall behavior — not anchored to a specific element.
      </div>
      <textarea
        className="sc-ovl-composer-input"
        aria-label="Note text"
        autoFocus
        value={prose}
        onChange={(e) => setProse(e.target.value)}
        placeholder="e.g. 'Show an inline error when the user submits a duplicate name.'"
        rows={5}
        style={{
          width: "100%",
          padding: 8,
          borderRadius: 6,
          borderStyle: "solid",
          borderWidth: 1,
          font: "inherit",
          fontSize: 16, // 0.6.12 — ≥16px stops iOS Safari auto-zooming on focus
          resize: "vertical",
          boxSizing: "border-box",
          colorScheme: dark ? "dark" : "light",
        }}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
        <button
          type="button"
          onClick={props.onCancel}
          disabled={props.submitting}
          style={{
            background: "transparent",
            border: `1px solid ${S.inputBorder}`,
            padding: "6px 12px",
            borderRadius: 6,
            cursor: "pointer",
            font: "inherit",
            color: S.fg,
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={props.submitting || prose.trim() === ""}
          onClick={() => void props.onSubmit(prose.trim())}
          style={{
            background: ACCENT,
            color: "white",
            border: "none",
            padding: "6px 14px",
            borderRadius: 6,
            cursor: props.submitting ? "not-allowed" : "pointer",
            opacity: props.submitting || prose.trim() === "" ? 0.6 : 1,
            font: "inherit",
            fontWeight: 600,
          }}
        >
          {props.submitting ? "Posting…" : "Post note"}
        </button>
      </div>
    </div>
  );
}

/**
 * 0.7.0 — Docs studio: the textual half of review. Reads the spine markdown docs
 * on the working branch, lets a reviewer edit them with an edit/preview toggle,
 * and (write-access only) commits the edit to the branch as a "scope change"
 * that `refine` reconciles. Non-write reviewers get read + preview.
 */
/**
 * 0.16.0 — Ask co-pilot. A two-way chat with a repo-aware Claude agent running
 * on the review box (see the `askBase` SSE backend). Reuses the reviewer's
 * device-flow token as the Bearer credential; the backend gates on GitHub
 * write access and runs a per-conversation agent session that can read the
 * code, record decisions, and open PRs (attributed to the reviewer).
 */
interface AskMessage { id: string; role: "user" | "assistant"; text: string; tools: string[]; }

export interface AskPanelProps {
  repo: RepoCoord;
  askBase: string;
  identity: StoredReviewerIdentity | null;
  getToken: () => string | null;
  onSignIn: () => void;
  onSessionExpired: () => void;
  surfaceManifest?: Manifest | null;
  /** Corner the compact window hugs (near the host pill). Default top-left. */
  placement?: "top-left" | "bottom-left";
  onClose: () => void;
}

export function AskPanel(props: AskPanelProps): JSX.Element {
  const { askBase, identity, getToken, onSignIn, onSessionExpired, onClose } = props;
  const repoKey = `${props.repo.owner}/${props.repo.repo}`;
  const winKey = `slowcook.review-overlay.ask.win.${repoKey}`;

  // ── per-account conversation persistence ─────────────────────────────────
  // History is keyed by the GitHub login behind the token, so switching
  // accounts in the same browser switches history. The conversation id is
  // stable across reopens/reloads — the ask backend resumes the SAME agent
  // session from it, so context carries over, not just the transcript.
  interface AskConversation { id: string; title: string; createdAt: number; messages: AskMessage[]; }
  const [login, setLogin] = useState<string | null>(identity?.login ?? null);
  const [convs, setConvs] = useState<AskConversation[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [input, setInput] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<boolean>(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const loginRef = useRef<string | null>(login);
  loginRef.current = login;

  const convsKey = (l: string | null) => `slowcook.review-overlay.ask.${repoKey}.${l ?? "anon"}`;
  const newConv = (): AskConversation => ({
    id: "c" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
    title: "New chat", createdAt: Date.now(), messages: [],
  });

  const persist = useCallback((l: string | null, list: AskConversation[], active: string) => {
    try {
      window.localStorage.setItem(convsKey(l), JSON.stringify({ activeId: active, convs: list.slice(-30) }));
    } catch { /* quota — drop silently */ }
  }, [repoKey]);

  const loadFor = useCallback((l: string | null) => {
    let list: AskConversation[] = [];
    let active = "";
    try {
      const raw = window.localStorage.getItem(convsKey(l));
      if (raw) { const d = JSON.parse(raw); list = d.convs ?? []; active = d.activeId ?? ""; }
    } catch { /* corrupted — start fresh */ }
    if (list.length === 0) { const c = newConv(); list = [c]; active = c.id; }
    if (!list.some((c) => c.id === active)) active = list[list.length - 1]!.id;
    setConvs(list); setActiveId(active);
  }, [repoKey]);

  // initial load under the anon (or identity) key; then re-key by the token's
  // real login so history is genuinely per-account.
  useEffect(() => {
    loadFor(loginRef.current);
    const token = getToken();
    if (!token || loginRef.current) return;
    void fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => { if (u?.login) { setLogin(u.login); loadFor(u.login); } })
      .catch(() => { /* offline — stay on anon key */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // window position/size restore
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(winKey);
      if (raw) { const d = JSON.parse(raw); if (d.pos) setPos(d.pos); if (d.size) setSize(d.size); }
    } catch { /* ignore */ }
  }, [winKey]);
  const saveWin = useCallback((p: { left: number; top: number } | null, sz: { w: number; h: number } | null) => {
    try { window.localStorage.setItem(winKey, JSON.stringify({ pos: p, size: sz })); } catch { /* ignore */ }
  }, [winKey]);

  // observe user resizes (CSS resize handle) and persist them
  useEffect(() => {
    const el = panelRef.current;
    if (!el || expanded) return;
    const ro = new ResizeObserver(() => {
      const w = el.offsetWidth, h = el.offsetHeight;
      setSize((cur) => (cur && Math.abs(cur.w - w) < 2 && Math.abs(cur.h - h) < 2 ? cur : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded]);
  useEffect(() => { if (size || pos) saveWin(pos, size); }, [pos, size, saveWin]);

  useEffect(() => () => { try { abortRef.current?.abort(); } catch { /* noop */ } }, []);
  const active = convs.find((c) => c.id === activeId);
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [active?.messages]);

  const base = askBase.replace(/\/$/, "");

  const mutateActive = (fn: (c: AskConversation) => AskConversation) => {
    setConvs((list) => {
      const next = list.map((c) => (c.id === activeId ? fn(c) : c));
      persist(loginRef.current, next, activeId);
      return next;
    });
  };

  async function send() {
    const text = input.trim();
    if (!text || busy || !active) return;
    const token = getToken();
    if (!token) { onSignIn(); return; }
    setError(null);
    setInput("");
    const userMsg: AskMessage = { id: "u" + Date.now(), role: "user", text, tools: [] };
    const asstId = "a" + Date.now();
    mutateActive((c) => ({
      ...c,
      title: c.messages.length === 0 ? text.slice(0, 48) : c.title,
      messages: [...c.messages, userMsg, { id: asstId, role: "assistant", text: "", tools: [] }],
    }));
    setBusy(true);
    abortRef.current = new AbortController();
    const append = (patch: (a: AskMessage) => AskMessage) =>
      mutateActive((c) => ({ ...c, messages: c.messages.map((x) => (x.id === asstId ? patch(x) : x)) }));
    try {
      const res = await fetch(`${base}/__slowcook/ask/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
        body: JSON.stringify({
          conversationId: active.id,
          message: text,
          context: { route: typeof window !== "undefined" ? window.location.pathname : undefined },
        }),
        signal: abortRef.current.signal,
      });
      if (res.status === 401 || res.status === 403) {
        setError(res.status === 403
          ? "This chat is for reviewers with write access to the repo."
          : "Your GitHub session expired — sign in again to chat.");
        if (res.status === 401) onSessionExpired();
        setBusy(false);
        return;
      }
      if (!res.ok || !res.body) { setError(`Chat backend error (${res.status}).`); setBusy(false); return; }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, nl); buf = buf.slice(nl + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (ev.type === "text" || ev.type === "delta") append((a) => ({ ...a, text: a.text + ev.text }));
          else if (ev.type === "tool") append((a) => ({ ...a, tools: [...a.tools, ev.name] }));
          else if (ev.type === "error") { setError(ev.text || "Agent error."); }
          else if (ev.type === "done" && ev.branch) append((a) => ({ ...a, tools: [...a.tools, `branch ${ev.branch}`] }));
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(String((e as Error).message || e).slice(0, 200));
    } finally {
      setBusy(false);
    }
  }

  const copyMessage = (m: AskMessage) => {
    try {
      void navigator.clipboard.writeText(m.text).then(() => {
        setCopiedId(m.id);
        setTimeout(() => setCopiedId((cur) => (cur === m.id ? null : cur)), 1400);
      });
    } catch { /* clipboard unavailable */ }
  };

  const startDrag = (e: React.PointerEvent) => {
    if (expanded) return;
    const t = e.target as HTMLElement;
    if (t.closest("button") || t.closest("select")) return; // header controls stay clickable
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onDrag = (e: React.PointerEvent) => {
    if (!dragRef.current || !panelRef.current) return;
    const w = panelRef.current.offsetWidth, h = panelRef.current.offsetHeight;
    const left = Math.min(Math.max(0, e.clientX - dragRef.current.dx), window.innerWidth - Math.min(w, 200));
    const top = Math.min(Math.max(0, e.clientY - dragRef.current.dy), window.innerHeight - 48);
    setPos({ left, top });
  };
  const endDrag = () => { dragRef.current = null; };

  const frame: React.CSSProperties = expanded
    ? { inset: 12 }
    : pos
      ? { left: pos.left, top: pos.top, width: size?.w ?? 430, height: size?.h ?? Math.min(560, window.innerHeight * 0.78) }
      : {
          ...(props.placement === "bottom-left" ? { bottom: 64 } : { top: 100 }),
          left: 12, width: size?.w ?? 430, maxWidth: "94vw", height: size?.h ?? "min(560px, 78vh)",
        };

  return createElement(
    "div",
    {
      "data-slowcook-overlay-ui": "1", role: "dialog", "aria-label": "Ask co-pilot",
      ref: panelRef,
      onClick: (e: React.MouseEvent) => e.stopPropagation(),
      style: {
        position: "fixed", zIndex: 2147483602,
        ...frame,
        background: "rgba(15,15,24,0.97)", color: "white", pointerEvents: "auto",
        fontFamily: "system-ui, -apple-system, sans-serif", fontSize: 13,
        display: "flex", flexDirection: "column",
        borderRadius: 16, border: "1px solid rgba(255,255,255,0.14)",
        boxShadow: "0 14px 44px rgba(0,0,0,.45)", overflow: "hidden",
        resize: expanded ? "none" : "both", minWidth: 340, minHeight: 320,
      } as React.CSSProperties,
    },
    createElement("style", { dangerouslySetInnerHTML: { __html:
      ".sc-ask-md p{margin:0 0 8px}.sc-ask-md p:last-child{margin-bottom:0}" +
      ".sc-ask-md ul,.sc-ask-md ol{margin:4px 0 8px;padding-left:20px}.sc-ask-md li{margin:2px 0}" +
      ".sc-ask-md code{background:rgba(255,255,255,0.12);padding:1px 5px;border-radius:5px;font-size:12px}" +
      ".sc-ask-md pre{background:rgba(0,0,0,0.45);padding:9px 11px;border-radius:9px;overflow-x:auto;margin:6px 0}" +
      ".sc-ask-md pre code{background:transparent;padding:0}" +
      ".sc-ask-md h1,.sc-ask-md h2,.sc-ask-md h3,.sc-ask-md h4{margin:10px 0 6px;font-size:13.5px;font-weight:800}" +
      ".sc-ask-md a{color:#ffb4b4}.sc-ask-md blockquote{margin:6px 0;padding:2px 10px;border-left:3px solid rgba(255,107,107,0.6);opacity:.85}" +
      ".sc-ask-md table{border-collapse:collapse;margin:6px 0}.sc-ask-md td,.sc-ask-md th{border:1px solid rgba(255,255,255,0.18);padding:3px 8px;font-size:12px}"
    } }),
    // header — drag handle + conversation switcher
    createElement("div", {
      onPointerDown: startDrag, onPointerMove: onDrag, onPointerUp: endDrag, onPointerCancel: endDrag,
      style: { display: "flex", alignItems: "center", gap: 8, padding: "10px 12px 10px 16px", borderBottom: "1px solid rgba(255,255,255,0.1)", cursor: expanded ? "default" : "grab", touchAction: "none", flexShrink: 0 } as React.CSSProperties,
    },
      createElement("span", { style: { fontWeight: 700, fontSize: 14, whiteSpace: "nowrap" } }, "💬 Ask"),
      login ? createElement("span", { style: { fontSize: 11, opacity: 0.6, whiteSpace: "nowrap" } }, `@${login}`) : null,
      convs.length > 0
        ? createElement("select", {
            value: activeId,
            onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
              setActiveId(e.target.value);
              persist(loginRef.current, convs, e.target.value);
            },
            style: { flex: 1, minWidth: 0, background: "rgba(255,255,255,0.08)", color: "white", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 7, padding: "3px 6px", fontSize: 12 } as React.CSSProperties,
          }, ...convs.slice().reverse().map((c) =>
            createElement("option", { key: c.id, value: c.id, style: { color: "#111" } },
              c.title.length > 46 ? c.title.slice(0, 46) + "…" : c.title)))
        : createElement("span", { style: { flex: 1 } }),
      createElement("button", {
        type: "button", title: "New chat",
        onClick: () => {
          const c = newConv();
          setConvs((list) => { const next = [...list, c]; persist(loginRef.current, next, c.id); return next; });
          setActiveId(c.id);
        },
        style: { background: "transparent", border: "1px solid rgba(255,255,255,0.25)", color: "rgba(255,255,255,0.8)", cursor: "pointer", fontSize: 12, borderRadius: 7, padding: "2px 8px", whiteSpace: "nowrap" },
      }, "＋ New"),
      createElement("button", { type: "button", onClick: () => setExpanded((v) => !v), "aria-label": expanded ? "Shrink" : "Expand", title: expanded ? "Back to the window" : "Expand", style: { background: "transparent", border: "none", color: "rgba(255,255,255,0.6)", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "0 4px" } }, expanded ? "❐" : "⛶"),
      createElement("button", { type: "button", onClick: onClose, "aria-label": "Close", style: { background: "transparent", border: "none", color: "rgba(255,255,255,0.6)", cursor: "pointer", fontSize: 22, lineHeight: 1 } }, "×"),
    ),
    // message list
    createElement("div", { ref: bodyRef, style: { flex: 1, overflowY: "auto", padding: "16px", display: "flex", flexDirection: "column", gap: 12 } as React.CSSProperties },
      !active || active.messages.length === 0
        ? null
        : active.messages.map((m) =>
            createElement("div", { key: m.id, style: { alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "86%" } as React.CSSProperties },
              m.role === "assistant" && m.text
                ? createElement("div", {
                    className: "sc-ask-md",
                    style: {
                      background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)",
                      borderRadius: 12, padding: "9px 13px", wordBreak: "break-word", lineHeight: 1.55,
                    } as React.CSSProperties,
                    dangerouslySetInnerHTML: { __html: renderMarkdown(m.text) },
                  })
                : createElement("div", {
                    style: {
                      background: m.role === "user" ? "rgba(255,107,107,0.18)" : "rgba(255,255,255,0.06)",
                      border: "1px solid " + (m.role === "user" ? "rgba(255,107,107,0.4)" : "rgba(255,255,255,0.12)"),
                      borderRadius: 12, padding: "9px 13px", whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: 1.55,
                    } as React.CSSProperties,
                  }, m.text || (busy && m.role === "assistant" ? "\u2026" : "")),
              createElement("div", { style: { fontSize: 10.5, opacity: 0.55, marginTop: 4, display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" } as React.CSSProperties },
                m.role === "assistant" && m.text
                  ? createElement("button", {
                      type: "button",
                      title: "Copy this response",
                      onClick: () => copyMessage(m),
                      style: { background: "transparent", border: "1px solid rgba(255,255,255,0.2)", color: copiedId === m.id ? "#7ee2a8" : "rgba(255,255,255,0.65)", cursor: "pointer", fontSize: 10.5, borderRadius: 6, padding: "1px 7px" },
                    }, copiedId === m.id ? "\u2713 copied" : "\u29c9 copy")
                  : null,
                ...m.tools.map((t, i) => createElement("span", { key: i }, t.startsWith("branch ") ? `\ud83d\udd00 ${t}` : `\ud83d\udd27 ${t}`)),
              ),
            )),
    ),
    error ? createElement("div", { style: { padding: "8px 16px", color: "#ffb4b4", fontSize: 12, borderTop: "1px solid rgba(255,107,107,0.3)", flexShrink: 0 } as React.CSSProperties }, error) : null,
    // composer
    createElement("div", { style: { display: "flex", gap: 8, padding: "12px 16px", borderTop: "1px solid rgba(255,255,255,0.1)", flexShrink: 0 } as React.CSSProperties },
      createElement("textarea", {
        value: input,
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setInput(e.target.value),
        onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } },
        placeholder: getTokenSafe(getToken) ? "Ask anything about ScreenMe\u2026 (Enter to send, Shift+Enter for newline)" : "Sign in with GitHub to chat",
        disabled: busy,
        rows: 2,
        style: { flex: 1, resize: "none", borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(255,255,255,0.06)", color: "white", padding: "9px 12px", font: "inherit", fontSize: 13 } as React.CSSProperties,
      }),
      createElement("button", {
        type: "button", onClick: () => void send(), disabled: busy || !input.trim(),
        style: { alignSelf: "stretch", padding: "0 18px", borderRadius: 10, border: "none", cursor: busy || !input.trim() ? "not-allowed" : "pointer", opacity: busy || !input.trim() ? 0.5 : 1, background: "#FF6B6B", color: "white", fontWeight: 800, fontSize: 13 } as React.CSSProperties,
      }, busy ? "\u2026" : "Send"),
    ),
  );
}

/** Render-safe token presence check (never throws during SSR). */
function getTokenSafe(getToken: () => string | null): boolean {
  try { return !!getToken(); } catch { return false; }
}

function DocsPanel(props: {
  repo: RepoCoord;
  docPaths: string[];
  branch: string;
  identity: StoredReviewerIdentity | null;
  getToken: () => string | null;
  onSignIn: () => void;
  /** The shared token was rejected (expired) — clear the whole session + re-prompt. */
  onSessionExpired: () => void;
  apiBase?: string;
  onClose: () => void;
  onFeedback: (t: string) => void;
}): JSX.Element {
  const { repo, docPaths, branch, identity, getToken, onSignIn, onSessionExpired, apiBase, onClose, onFeedback } = props;
  const [path, setPath] = useState<string>(docPaths[0] ?? "");
  const [file, setFile] = useState<DocFile | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"edit" | "preview">("preview");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [needsAuth, setNeedsAuth] = useState<boolean>(false);
  const canApply = identity?.canApply === true;
  const dirty = file != null && draft !== file.content;
  const ref = branch || "HEAD";

  const load = useCallback(async (p: string) => {
    setLoading(true); setError(null); setFile(null); setNeedsAuth(false);
    const token = getToken();
    const res = await fetchDocFile({ owner: repo.owner, repo: repo.repo, path: p, ref, pat: token ?? undefined, apiBase });
    const short = p.split("/").pop();
    if (res.ok) { setFile(res.file); setDraft(res.file.content); setView("preview"); }
    else if (res.status === 401) {
      // 401 "Bad credentials" = the token is invalid — almost always an EXPIRED
      // reviewer session (device-flow tokens expire). A token WAS present (the pill
      // still shows signed-in), so clear the whole SHARED session so the overlay is
      // consistent everywhere + re-prompt; absent token is just a normal sign-in.
      setNeedsAuth(true);
      setError(token ? `Your GitHub session expired — sign in again to read ${short}.` : `Sign in with GitHub to read ${short} — this repo is private.`);
      if (token) onSessionExpired();
    } else if (!token && res.status === 404) {
      setNeedsAuth(true);
      setError(`Sign in with GitHub to read ${short} — this repo is private.`);
    } else {
      setError(`Couldn't load ${p}: ${res.message} (${res.status})`);
    }
    setLoading(false);
  }, [repo.owner, repo.repo, ref, apiBase, getToken, onSessionExpired]);

  useEffect(() => { if (path) void load(path); }, [path, load]);

  async function submit() {
    if (!file || !dirty) return;
    const token = getToken();
    if (!canApply || !token) return;
    setSubmitting(true);
    const res = await commitDocFile({
      owner: repo.owner, repo: repo.repo, path, content: draft, sha: file.sha,
      branch: ref, message: `docs(scope): ${path} edited via review (PM scope change)`,
      pat: token, apiBase,
    });
    setSubmitting(false);
    if (res.ok) {
      onFeedback(`Scope change committed to ${ref} — refine will reconcile ${path.split("/").pop()}.`);
      await load(path); // refresh sha + content
    } else {
      setError(`Commit failed: ${res.message} (${res.status})`);
    }
  }

  const name = (p: string) => p.split("/").pop() ?? p;

  return (
    <div
      data-slowcook-overlay-ui="1"
      role="dialog"
      aria-label="Docs studio"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: "fixed", inset: 0, zIndex: 2147483602,
        background: "rgba(15,15,24,0.97)", color: "white", pointerEvents: "auto",
        fontFamily: "system-ui, -apple-system, sans-serif", fontSize: 13,
        display: "flex", flexDirection: "column",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>📄 Docs · textual review</span>
        <span style={{ fontSize: 11, opacity: 0.6 }}>branch <code style={{ background: "rgba(255,255,255,0.1)", padding: "1px 6px", borderRadius: 5 }}>{ref}</code></span>
        <span style={{ marginLeft: "auto" }} />
        <button type="button" onClick={onClose} aria-label="Close docs" style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.6)", cursor: "pointer", fontSize: 22, lineHeight: 1 }}>×</button>
      </div>

      {/* Doc tabs */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "10px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        {docPaths.map((p) => (
          <button key={p} type="button" onClick={() => setPath(p)} title={p}
            style={{
              fontSize: 12, fontWeight: p === path ? 800 : 600, padding: "5px 11px", borderRadius: 999,
              cursor: "pointer", border: "1px solid " + (p === path ? "rgba(255,107,107,0.7)" : "rgba(255,255,255,0.15)"),
              background: p === path ? "rgba(255,107,107,0.18)" : "transparent", color: p === path ? "#ffb4b4" : "rgba(255,255,255,0.75)",
            }}>{name(p)}{dirty && p === path ? " •" : ""}</button>
        ))}
      </div>

      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        <div style={{ display: "inline-flex", background: "rgba(255,255,255,0.06)", borderRadius: 999, padding: 2 }}>
          {(["preview", "edit"] as const).map((v) => (
            <button key={v} type="button" onClick={() => setView(v)}
              style={{ fontSize: 12, fontWeight: 700, padding: "4px 12px", borderRadius: 999, border: "none", cursor: "pointer",
                background: view === v ? "white" : "transparent", color: view === v ? "#111" : "rgba(255,255,255,0.7)" }}>
              {v === "preview" ? "Preview" : "Edit"}
            </button>
          ))}
        </div>
        <span style={{ marginLeft: "auto" }} />
        {identity ? (
          canApply ? (
            <button type="button" disabled={!dirty || submitting} onClick={() => void submit()}
              title={dirty ? "Commit this edit to the branch as a scope change" : "No changes yet"}
              style={{ fontSize: 12.5, fontWeight: 800, padding: "7px 14px", borderRadius: 8, border: "none",
                cursor: !dirty || submitting ? "not-allowed" : "pointer", opacity: !dirty || submitting ? 0.5 : 1,
                background: "#22c55e", color: "white" }}>
              {submitting ? "Submitting…" : "Submit scope change"}
            </button>
          ) : (
            <span style={{ fontSize: 11.5, opacity: 0.7, maxWidth: 280 }}>Read-only — write access is required to submit a scope change; your notes can go via a review comment.</span>
          )
        ) : (
          <button type="button" onClick={onSignIn}
            style={{ fontSize: 12.5, fontWeight: 700, padding: "7px 14px", borderRadius: 8, border: "none", cursor: "pointer", background: "white", color: "#111" }}>
            Sign in to edit
          </button>
        )}
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: "auto", padding: 0 }}>
        {loading ? (
          <div style={{ padding: 24, opacity: 0.6 }}>Loading {name(path)}…</div>
        ) : error ? (
          <div style={{ padding: 24, color: "#ffb4b4" }}>
            <div>{error}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              {needsAuth && (
                <button type="button" onClick={onSignIn}
                  style={{ fontSize: 12.5, fontWeight: 700, padding: "7px 14px", borderRadius: 8, border: "none", cursor: "pointer", background: "white", color: "#111" }}>
                  Sign in with GitHub
                </button>
              )}
              <button type="button" onClick={() => void load(path)}
                style={{ fontSize: 12.5, fontWeight: 600, padding: "7px 14px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.25)", cursor: "pointer", background: "transparent", color: "rgba(255,255,255,0.85)" }}>
                Retry
              </button>
            </div>
          </div>
        ) : view === "edit" ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            style={{
              width: "100%", height: "100%", minHeight: 400, boxSizing: "border-box",
              padding: "16px 20px", border: "none", outline: "none", resize: "none",
              background: "#11111b", color: "#e8e8f0", fontSize: 16, lineHeight: 1.55,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            }}
          />
        ) : (
          <div
            className="sc-doc-prose"
            style={{ padding: "16px 24px", maxWidth: 860, margin: "0 auto", lineHeight: 1.6 }}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(draft) }}
          />
        )}
      </div>

      {/* Prose styling (scoped) */}
      <style dangerouslySetInnerHTML={{ __html:
        `.sc-doc-prose h1,.sc-doc-prose h2,.sc-doc-prose h3{color:#fff;margin:1.1em 0 .4em;line-height:1.25}` +
        `.sc-doc-prose h1{font-size:24px}.sc-doc-prose h2{font-size:19px;border-bottom:1px solid rgba(255,255,255,0.12);padding-bottom:4px}.sc-doc-prose h3{font-size:16px}` +
        `.sc-doc-prose p,.sc-doc-prose li{color:rgba(255,255,255,0.85)}` +
        `.sc-doc-prose code{background:rgba(255,255,255,0.1);padding:1px 5px;border-radius:5px;font-size:0.9em}` +
        `.sc-doc-prose pre{background:#11111b;padding:12px 14px;border-radius:8px;overflow:auto}.sc-doc-prose pre code{background:none;padding:0}` +
        `.sc-doc-prose a{color:#7cc7ff}` +
        `.sc-doc-prose blockquote{border-left:3px solid rgba(255,107,107,0.6);margin:.6em 0;padding:.2em 0 .2em 14px;color:rgba(255,255,255,0.7)}` +
        `.sc-doc-prose hr{border:none;border-top:1px solid rgba(255,255,255,0.12);margin:1.2em 0}` +
        `.sc-doc-prose table{border-collapse:collapse;width:100%;margin:.8em 0;font-size:12.5px}` +
        `.sc-doc-prose th,.sc-doc-prose td{border:1px solid rgba(255,255,255,0.15);padding:6px 10px;text-align:left}` +
        `.sc-doc-prose th{background:rgba(255,255,255,0.06)}`
      }} />
    </div>
  );
}

/**
 * 0.7.1 — "Viewing as" surface switcher, in the review pane. Lets a reviewer
 * jump between the mock's persona/section surfaces. This is review-only — a real
 * user is one role — so it must NOT live in the product mock. Tracks the current
 * route (longest matching surface home) and navigates via the parent's
 * router-agnostic handler.
 */
function SurfaceSwitcher(props: { surfaces: ReviewSurface[]; onNavigate: (home: string) => void; disabled: boolean }): JSX.Element {
  const { surfaces, onNavigate, disabled } = props;
  const [path, setPath] = useState<string>(typeof window !== "undefined" ? window.location.pathname : "/");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const on = () => setPath(window.location.pathname);
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  const current = surfaces
    .filter((s) => (s.home === "/" ? true : path === s.home || path.startsWith(s.home + "/") || path === s.home))
    .sort((a, b) => b.home.length - a.home.length)[0] ?? surfaces[0];
  return (
    <select
      className="sc-ovl-pane-select"
      aria-label="Viewing as (review surface)"
      title="Viewing as — jump between persona surfaces (review only; not a real control)"
      value={current?.home ?? ""}
      disabled={disabled}
      onChange={(e) => onNavigate(e.target.value)}
      style={{
        marginLeft: 2, maxWidth: 150,
        border: "1px solid rgba(0,0,0,0.15)", borderRadius: 999,
        cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1,
      }}
    >
      {surfaces.map((s) => (
        <option key={s.home} value={s.home} style={{ color: "#111" }}>
          {(s.icon ? s.icon + " " : "") + "as " + s.label}
        </option>
      ))}
    </select>
  );
}
