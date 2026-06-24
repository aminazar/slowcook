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

import { useEffect, useState, useRef, useCallback, type JSX } from "react";
import { createPortal } from "react-dom";
import { extractSelector, resolveStoredSelector } from "../selector.js";
import {
  buildPayload,
  formatReviewComment,
  formatLcrIssue,
  type ViewportInfo,
  type ReviewCommentPayload,
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
import { loadManifest, applySelection, getSelection, type Manifest } from "../testing-surfaces.js";

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

export function SlowcookReviewOverlay(props: SlowcookReviewOverlayProps): JSX.Element | null {
  // 0.5.1 — auto-detect props from process.env.NEXT_PUBLIC_SLOWCOOK_*.
  // Next inlines NEXT_PUBLIC_* at consumer build time, so this works
  // even though the overlay package itself doesn't have access to the
  // consumer's env at compile time. Consumers can pass props
  // explicitly to override.
  const owner = props.owner ?? process.env["NEXT_PUBLIC_SLOWCOOK_OWNER"] ?? "";
  const repo = props.repo ?? process.env["NEXT_PUBLIC_SLOWCOOK_REPO"] ?? "";
  const prNumber = props.prNumber ?? parseInt(process.env["NEXT_PUBLIC_SLOWCOOK_PR_NUMBER"] ?? "0", 10);
  const storyId = props.storyId ?? process.env["NEXT_PUBLIC_SLOWCOOK_STORY_ID"] ?? null;
  const enabled = props.enabled ?? (process.env["NEXT_PUBLIC_SLOWCOOK_REVIEW"] === "1");
  const reviewMode: "scenarios" | "lcr" =
    props.reviewMode ??
    (process.env["NEXT_PUBLIC_SLOWCOOK_REVIEW_MODE"] === "lcr" ? "lcr" : "scenarios");
  // 0.6.0 — LCR multi-person review: box-hosted device-flow helper base URL.
  const authBase = props.authBase ?? process.env["NEXT_PUBLIC_SLOWCOOK_AUTH_BASE"] ?? "";
  const overlayVersion = props.overlayVersion ?? "0.6.0";
  const repoCoord: RepoCoord = { owner, repo };
  // 0.7.0 — docs studio config.
  const docPaths: string[] = props.docPaths ??
    (process.env["NEXT_PUBLIC_SLOWCOOK_DOC_PATHS"]?.split(",").map((s) => s.trim()).filter(Boolean)) ??
    ["docs/PRD.md", "docs/ROADMAP.md", "docs/USER_STORIES.md", "docs/ARCHITECTURE.md"];
  const branchProp = props.branch ?? process.env["NEXT_PUBLIC_SLOWCOOK_BRANCH"] ?? "";
  // 0.7.1 — review surfaces (persona switcher lives in the pane, not the mock).
  const surfaces: ReviewSurface[] = props.surfaces ?? (() => {
    try { const raw = process.env["NEXT_PUBLIC_SLOWCOOK_SURFACES"]; return raw ? (JSON.parse(raw) as ReviewSurface[]) : []; }
    catch { return []; }
  })();
  // 0.9.0 — EPSS testing-surface router manifest.
  const testingSurfacesUrl: string =
    props.testingSurfacesUrl ?? process.env["NEXT_PUBLIC_SLOWCOOK_SURFACES_URL"] ?? "";
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
  const reportFailure = useCallback((status: number | undefined, message: string | undefined, prefix: string) => {
    if (status === 401 || status === 403 || status === 404) openLogin(describeAuthError(status, message, { owner, repo }));
    else setFeedback(`${prefix}: ${status ?? "?"} ${message ?? ""}`);
  }, [openLogin, owner, repo]);

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
          // No selector + no bbox → general comment.
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
          apiBase={getProxyApiBase() ?? undefined}
          onClose={() => setDocsPanelOpen(false)}
          onFeedback={(t) => setFeedback(t)}
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
// 0.9.0 — overlay artifacts follow the SYSTEM colour scheme (not the app's,
// since the overlay lives in an isolated shadow root). Reactive to OS changes.
function usePrefersDark(): boolean {
  const [dark, setDark] = useState<boolean>(() => {
    try { return window.matchMedia("(prefers-color-scheme: dark)").matches; } catch { return true; }
  });
  useEffect(() => {
    let mq: MediaQueryList;
    try { mq = window.matchMedia("(prefers-color-scheme: dark)"); } catch { return; }
    const on = (): void => setDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return dark;
}

interface PillTheme { bg: string; border: string; fg: string; fgDim: string; sub: string; subBorder: string; shadow: string; ghBg: string; ghFg: string; }
function pillTheme(dark: boolean): PillTheme {
  return dark
    ? { bg: "rgba(15,15,24,0.92)", border: "rgba(255,255,255,0.16)", fg: "white", fgDim: "rgba(255,255,255,0.55)", sub: "rgba(255,255,255,0.08)", subBorder: "rgba(255,255,255,0.15)", shadow: "0 4px 14px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06)", ghBg: "#ffffff", ghFg: "#24292f" }
    : { bg: "rgba(255,255,255,0.96)", border: "rgba(0,0,0,0.12)", fg: "#1a1a1a", fgDim: "rgba(0,0,0,0.5)", sub: "rgba(0,0,0,0.05)", subBorder: "rgba(0,0,0,0.12)", shadow: "0 4px 16px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.7)", ghBg: "#24292f", ghFg: "#ffffff" };
}

interface SheetTheme { backdrop: string; sheet: string; fg: string; fgDim: string; header: string; input: string; inputBorder: string; border: string; rowActive: string; rowHover: string; }
function sheetTheme(dark: boolean): SheetTheme {
  return dark
    ? { backdrop: "rgba(0,0,0,0.5)", sheet: "#1b1b22", fg: "#ececf0", fgDim: "#a0a0aa", header: "#8a8a96", input: "#26262f", inputBorder: "#3a3a46", border: "rgba(255,255,255,0.08)", rowActive: "rgba(59,175,160,0.22)", rowHover: "rgba(255,255,255,0.06)" }
    : { backdrop: "rgba(0,0,0,0.4)", sheet: "#ffffff", fg: "#111111", fgDim: "#999999", header: "#8a8a8a", input: "#ffffff", inputBorder: "#d0d7de", border: "#eeeeee", rowActive: "rgba(59,175,160,0.14)", rowHover: "#f3f4f6" };
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
  surfaces: ReviewSurface[];
  surfaceManifest: Manifest | null;
  onNavigate: (home: string) => void;
  // 0.6.2 — LCR sign-in lives IN the floating disk (self-styled, theme-proof),
  // not a separate fixed badge.
  reviewMode: "scenarios" | "lcr";
  identity: StoredReviewerIdentity | null;
  onSignIn: () => void;
  onSignOut: () => void;
}): JSX.Element {
  const { mode, armed, onArm, onCancelArm, onChange, disabled, isMobile, isApproved, commentCount, newCount, onListClick, docsEnabled, onDocsClick, surfaces, surfaceManifest, onNavigate, reviewMode, identity, onSignIn, onSignOut } = props;
  // 0.5.1 — initialise with the default; load saved position from
  // localStorage AFTER mount. Eliminates a hydration mismatch where
  // SSR/first-client render disagreed on the position value.
  const [pos, setPos] = useState<TogglePosition>({ top: 12, left: 12 });
  useEffect(() => { setPos(loadTogglePosition()); }, []);
  const dragRef = useRef<{ startX: number; startY: number; startTop: number; startLeft: number } | null>(null);

  // 0.9.0 — EPSS jump palette open state. The tappable status (right of the
  // pill) opens it; it lists matching states to jump to.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // 0.9.0 — follow the system colour scheme.
  const dark = usePrefersDark();
  const T = pillTheme(dark);

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
    const newTop = Math.max(0, dragRef.current.startTop + dy);
    // Allow a slightly-negative left so a clipped (grown-right) pill can be
    // panned left to reveal its right side; the grip stays grabbable.
    const newLeft = Math.max(-2000, dragRef.current.startLeft + dx);
    setPos({ top: newTop, left: newLeft });
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    dragRef.current = null;
    saveTogglePosition(pos);
  }, [pos]);

  return (
    <div
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
        maxWidth: "min(300px, 90vw)",
        gap: 4,
        // 0.4.2 — green-tinted when approved; else follows the system theme.
        background: isApproved ? (dark ? "rgba(20, 83, 45, 0.92)" : "rgba(220, 245, 228, 0.96)") : T.bg,
        padding: "5px 6px",
        borderRadius: 16,
        border: isApproved ? `1px solid rgba(34, 197, 94, 0.55)` : `1px solid ${T.border}`,
        boxShadow: isApproved
          ? `0 4px 14px rgba(34, 197, 94, 0.30), inset 0 1px 0 rgba(255,255,255,0.06)`
          : T.shadow,
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: 13,
        color: T.fg,
        userSelect: "none",
      }}
    >
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
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 3, flex: 1, minWidth: 0 }}>
      {/* Top row — the buttons (wraps on crowded mobile). Content-width. */}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 4, rowGap: 5, maxWidth: "100%" }}>
      {/* Slowcook logo — pinned to the left of the button row. */}
      <SlowcookLogo />
      {/* 0.8.0 — single Review/exit toggle. Off = overlay idle. On (accent) =
          a review session: the page still navigates freely; you arm a pick with
          the "📍 Pin a comment" button below. (Was "Commenting" — but comment
          mode no longer traps clicks, so it now reads "Reviewing".) */}
      <ToggleButton
        active={mode === "comment"}
        onClick={() => onChangeSafe(mode === "comment" ? "nav" : "comment")}
        disabled={disabled}
        label={mode === "comment" ? "rev" : "nav"}
        title={
          mode === "comment"
            ? "Review mode — navigate freely + pin comments; click to switch to nav"
            : (newCount ? `Switch to review — ${newCount} new update(s)` : "Switch to review — pin comments + the testing-surface router")
        }
        accent
        fg={T.fg}
        badge={newCount}
      />
      {/* 0.8.0 — arm a single element-pick. While armed the next page tap selects
          an element to comment on (then auto-disarms); tap again to cancel. */}
      {mode === "comment" && (
        <button
          type="button"
          onClick={() => (armed ? onCancelArm() : onArm())}
          disabled={disabled}
          title={armed ? "Cancel — tap an element, or cancel the pick" : "Pin a comment on an element"}
          style={{
            marginLeft: 4,
            background: armed ? ACCENT : T.sub,
            color: armed ? "white" : T.fg,
            border: armed ? `1px solid ${ACCENT}` : "1px solid transparent",
            padding: "6px 10px",
            borderRadius: 999,
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.6 : 1,
            font: "inherit",
            fontSize: 12,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            whiteSpace: "nowrap",
          }}
        >
          {armed ? "✕ Cancel pick" : (isMobile ? "📍" : "📍 Pin a comment")}
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
          marginLeft: 4,
          background: T.sub,
          color: T.fg,
          border: "none",
          padding: "6px 10px",
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
        📋 {commentCount > 0 && (
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
      {/* 0.7.0 — Docs (textual review): read + edit the spec docs. Available in
          both Nav and Comment modes — it's a parallel review surface. */}
      {docsEnabled && (
        <button
          type="button"
          onClick={() => { setConfirmLogout(false); onDocsClick(); }}
          disabled={disabled}
          title="Review & edit the spec docs (textual review)"
          style={{
            marginLeft: 4, background: T.sub, color: T.fg,
            border: "none", padding: "6px 10px", borderRadius: 999,
            cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1,
            font: "inherit", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5,
          }}
        >
          📄 Docs
        </button>
      )}
      {/* 0.7.1 — "Viewing as" surface switcher. A REVIEW affordance (a real user
          is one role), so it lives in the pane, not the mock. */}
      {surfaces.length > 0 && <SurfaceSwitcher surfaces={surfaces} onNavigate={onNavigate} disabled={disabled} />}
      {/* 0.6.2 — LCR per-reviewer sign-in, inside the disk. All colours are
          explicit (white-on-dark) so the app's dark/light theme can't touch it.
          0.6.11 — only in Comment mode. */}
      {reviewMode === "lcr" && mode === "comment" && (
        identity ? (
          <span
            title={confirmLogout
              ? "Click again to sign out (or click anything else to cancel)"
              : identity.canApply
              ? `Signed in as @${identity.login} — you have write access, so your comments are applied`
              : `Signed in as @${identity.login} — no write access, so your feedback is gathered for the team to review (not auto-applied)`}
            onClick={() => { if (confirmLogout) { setConfirmLogout(false); onSignOut(); } else { setConfirmLogout(true); } }}
            style={{
              marginLeft: 4, display: "inline-flex", alignItems: "center", gap: 6,
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
                {/* tier chip — write access applies; otherwise feedback to team */}
                <span style={{
                  fontSize: 9.5, fontWeight: 800, letterSpacing: 0.3, textTransform: "uppercase",
                  padding: "1px 6px", borderRadius: 999,
                  background: identity.canApply ? "rgba(34,197,94,0.22)" : "rgba(148,163,184,0.25)",
                  color: identity.canApply ? "#4ade80" : "#cbd5e1",
                }}>{identity.canApply ? "applies" : "review"}</span>
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
              marginLeft: 4, display: "inline-flex", alignItems: "center", gap: 6,
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
      </div>{/* /top row */}

      {/* 0.9.1 — EPSS current location: always shown, small font, both modes.
          Tapping it opens the jump palette (the dedicated 🎛 button was dropped).
          The status WRAPS onto a few lines instead of widening the pill right. */}
      {surfaceManifest && surfaceManifest.epics.length > 0 && (() => {
        const sel = getSelection();
        return (
          <button
            type="button"
            data-slowcook-overlay-ui="1"
            data-testid="epss-status"
            onClick={() => setPaletteOpen(true)}
            title={sel ? `${sel.label} — tap to jump` : "No surface selected — tap to jump"}
            style={{
              maxWidth: "100%", display: "block", textAlign: "start",
              padding: "0 2px 1px", margin: 0, border: "none", background: "transparent",
              color: T.fgDim, cursor: "pointer", font: "inherit", fontSize: 9.5, lineHeight: 1.25,
              whiteSpace: "normal", overflowWrap: "anywhere", wordBreak: "break-word",
            }}
          >
            {sel ? sel.label : "no surface selected"}
          </button>
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sel = getSelection();
  interface Row { epicId: string; contextId: string; scenarioId: string; stateId: string; epicLabel: string; ctxLabel: string; scnLabel: string; stLabel: string; hard?: boolean; becomes?: boolean; q: string }
  const query = q.trim();
  const show = query.length >= PALETTE_MIN_CHARS; // Spotlight: results only after 3 chars
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
        </div>
        {query.length > 0 && !show && (
          <div style={{ borderTop: `1px solid ${S.border}`, padding: "12px 16px", fontSize: 12.5, color: S.fgDim }}>Keep typing… ({PALETTE_MIN_CHARS}+ letters)</div>
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
  if (typeof window === "undefined") return null;
  const route = window.location.pathname + window.location.search;
  const story = readCurrentStory();
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 6, maxWidth: "100%",
      fontSize: 11.5, color: "#3a3a3a", background: "rgba(255,107,107,0.10)",
      border: "1px solid rgba(255,107,107,0.30)", borderRadius: 6,
      padding: "3px 9px", marginBottom: 8,
    }}>
      <span aria-hidden>📄</span>
      <span style={{ fontFamily: "ui-monospace, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{route}</span>
      {story && <span style={{ fontWeight: 700, color: "#d6336c" }}>· story-{story}</span>}
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
        <div style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 11, opacity: 0.7, marginBottom: 8, wordBreak: "break-all" }}>
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
      ? resolveStoredSelector(document, r.payload.element.selector, r.payload.element.fallback_selector)
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
        background: "rgba(15, 15, 24, 0.98)",
        color: "white",
        boxShadow: "-12px 0 40px rgba(0,0,0,0.45)",
        pointerEvents: "auto",
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: 13,
        display: "flex",
        flexDirection: "column",
        borderLeft: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      <div style={{ padding: "14px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ fontWeight: 600 }}>Comments ({visible.length})</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close panel"
          style={{
            background: "transparent",
            border: "none",
            color: "rgba(255,255,255,0.55)",
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
      <div style={{ padding: 12, borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
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
          style={{ margin: "0 12px 8px", padding: "7px 10px", background: "transparent", color: "rgba(255,255,255,0.6)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, cursor: "pointer", font: "inherit", fontSize: 12 }}
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
              ? resolveStoredSelector(document, r.payload.element!.selector, r.payload.element!.fallback_selector)
              : null;
            const hidden = anchored && live && (
              live.element.getBoundingClientRect().width === 0 ||
              (live.element as HTMLElement).offsetParent === null
            );
            const anchorLabel = !anchored
              ? { text: "note", color: "#94a3b8", bg: "rgba(148,163,184,0.18)" }
              : !live
              ? { text: "drifted", color: "#facc15", bg: "rgba(250,204,21,0.18)" }
              : hidden
              ? { text: "hidden", color: "#94a3b8", bg: "rgba(148,163,184,0.18)" }
              : { text: "anchored", color: "#22c55e", bg: "rgba(34,197,94,0.18)" };
            const expanded = expandedId === r.commentId;
            const clamp = (lines: number) => expanded ? {} : { display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical" as const, overflow: "hidden" };
            return (
              <div
                key={r.commentId}
                style={{
                  background: "rgba(255,255,255,0.03)",
                  border: `1px solid ${expanded ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.08)"}`,
                  borderRadius: 8, padding: 10, marginBottom: 6, color: "white",
                }}
              >
                {/* Header — click toggles expand. */}
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : r.commentId)}
                  style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", textAlign: "left", color: "white", font: "inherit", cursor: "pointer" }}
                >
                  {/* Per-author identity disk (colour + initial), with the plate
                      status as a small corner badge — matches the on-page pins. */}
                  <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 18, height: 18, borderRadius: 999, background: authorColor(r.author || "unknown").bg, color: "#fff", fontSize: 9, fontWeight: 800 }}>{authorInitial(r.author || "unknown")}</span>
                    {status && (
                      <span aria-hidden style={{ position: "absolute", top: -4, right: -4, width: 10, height: 10, borderRadius: 999, background: palette.bg, color: palette.fg, border: "1.5px solid rgba(15,15,24,1)", fontSize: 7, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>{palette.glyph}</span>
                    )}
                  </span>
                  <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, padding: "1px 6px", borderRadius: 999, background: anchorLabel.bg, color: anchorLabel.color }}>{anchorLabel.text}</span>
                  <span style={{ fontSize: 10, opacity: 0.55, marginLeft: "auto" }}>@{r.author} · {formatTimeAgo(r.createdAt)}</span>
                  <span aria-hidden style={{ fontSize: 10, opacity: 0.55, transform: expanded ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▶</span>
                </button>
                <div style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.4, marginTop: 4, ...clamp(3) }}>{r.payload.prose}</div>
                {r.plateReply?.summary && (
                  <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid rgba(255,255,255,0.08)", fontSize: 11.5, lineHeight: 1.45, color: "rgba(255,255,255,0.82)", whiteSpace: "pre-wrap", ...clamp(4) }}>
                    <span style={{ color: palette.bg, fontWeight: 700 }}>↳ reply: </span>{r.plateReply.summary}
                  </div>
                )}
                {/* Actions — always offer GitHub; locate only when anchored. */}
                <div style={{ display: "flex", gap: 12, marginTop: 8, fontSize: 11.5 }}>
                  <a href={r.htmlUrl} target="_blank" rel="noreferrer" style={{ color: "#7cc7ff", textDecoration: "none" }}>↗ Open issue on GitHub</a>
                  {anchored && (
                    <button type="button" onClick={() => onOpenComment(r.commentId)} style={{ color: "#22c55e", font: "inherit", fontSize: 11.5, cursor: "pointer" }}>
                      📍 {live ? "Locate on page" : "Anchor drifted"}
                    </button>
                  )}
                  {!expanded && (r.payload.prose.length > 120 || (r.plateReply?.summary?.length ?? 0) > 180) && (
                    <button type="button" onClick={() => setExpandedId(r.commentId)} style={{ color: "rgba(255,255,255,0.6)", font: "inherit", fontSize: 11.5, cursor: "pointer", marginLeft: "auto" }}>Expand</button>
                  )}
                </div>
              </div>
            );
            };
            return groups
              .filter((g) => g.items.length > 0)
              .map((g) => (
                <div key={g.label}>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.6, color: "rgba(255,255,255,0.42)", padding: "10px 6px 4px" }}>
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
function DocsPanel(props: {
  repo: RepoCoord;
  docPaths: string[];
  branch: string;
  identity: StoredReviewerIdentity | null;
  getToken: () => string | null;
  onSignIn: () => void;
  apiBase?: string;
  onClose: () => void;
  onFeedback: (t: string) => void;
}): JSX.Element {
  const { repo, docPaths, branch, identity, getToken, onSignIn, apiBase, onClose, onFeedback } = props;
  const [path, setPath] = useState<string>(docPaths[0] ?? "");
  const [file, setFile] = useState<DocFile | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"edit" | "preview">("preview");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const canApply = identity?.canApply === true;
  const dirty = file != null && draft !== file.content;
  const ref = branch || "HEAD";

  const load = useCallback(async (p: string) => {
    setLoading(true); setError(null); setFile(null);
    const token = getToken();
    const res = await fetchDocFile({ owner: repo.owner, repo: repo.repo, path: p, ref, pat: token ?? undefined, apiBase });
    if (res.ok) { setFile(res.file); setDraft(res.file.content); setView("preview"); }
    else if (!token && (res.status === 404 || res.status === 401)) {
      setError(`Sign in with GitHub to read ${p.split("/").pop()} — this repo is private.`);
    } else {
      setError(`Couldn't load ${p}: ${res.message} (${res.status})`);
    }
    setLoading(false);
  }, [repo.owner, repo.repo, ref, apiBase, getToken]);

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
          <div style={{ padding: 24, color: "#ffb4b4" }}>{error}</div>
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
