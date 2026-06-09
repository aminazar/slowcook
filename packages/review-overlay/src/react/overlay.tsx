/**
 * <SlowcookReviewOverlay /> — 0.16.0-α.6.
 *
 * Mounted into the consumer's mock-app root layout. Renders a floating
 * mode toggle (nav / comment / approve). In comment mode, clicks on
 * elements capture a selector + bbox + viewport metadata; the user
 * types prose and submits to the mockup PR via PAT.
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
import { extractSelector, resolveStoredSelector } from "../selector.js";
import {
  buildPayload,
  formatReviewComment,
  type ViewportInfo,
} from "../comment-format.js";
import {
  loadPat,
  savePat,
  submitComment,
  fetchOverlayComments,
  loadCachedComments,
  saveCachedComments,
  fetchPrLabels,
  addLabelsToPr,
  submitPrApproval,
  APPROVED_LABEL,
  type RepoCoord,
  type OverlayCommentRecord,
} from "../github.js";

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
  /** Overlay package version, included in the JSON payload. */
  overlayVersion?: string;
}

type Mode = "nav" | "comment" | "approve";

const ACCENT = "#FF6B6B";
const APPROVED_GREEN = "#22c55e";

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
  const overlayVersion = props.overlayVersion ?? "0.6.0";
  const repoCoord: RepoCoord = { owner, repo };

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

  // Hooks must run unconditionally — render the null AFTER all hooks
  // are declared. Bails early during SSR via the typeof window check.
  const [mode, setMode] = useState<Mode>("nav");
  const [target, setTarget] = useState<Element | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
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
  // 0.4.2 — approved state. True when the PR carries the
  // slowcook-mockup-approved label; pill renders green-tinted +
  // hides the Approve button. Nav + Comment still work for follow-up
  // discussion (plate refuses to amend either way).
  const [isApproved, setIsApproved] = useState<boolean>(false);

  // Mount-time + on-focus fetch of overlay comments.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!enabled) return;
    if (!owner || !repo || !prNumber) return;
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
  }, [enabled, owner, repo, prNumber]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia("(max-width: 640px)");
    const apply = () => setIsMobile(mql.matches);
    apply();
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, []);

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

  // ESC exits comment/approve mode + closes composer.
  useEffect(() => {
    if (typeof window === "undefined") return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setMode("nav");
        setComposerOpen(false);
        setTarget(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Capture clicks at the document level when in comment/approve mode.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (mode === "nav") return;
    function onClick(e: MouseEvent) {
      const el = e.target as Element | null;
      if (!el) return;
      // Don't capture clicks on the overlay's own UI.
      if (composerRef.current && composerRef.current.contains(el)) return;
      if ((el as HTMLElement).closest('[data-slowcook-overlay-ui="1"]')) return;
      e.preventDefault();
      e.stopPropagation();
      if (mode === "comment") {
        setTarget(el);
        setComposerOpen(true);
      } else if (mode === "approve") {
        void submitApproval();
      }
    }
    document.addEventListener("click", onClick, { capture: true });
    return () => document.removeEventListener("click", onClick, { capture: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      const pat = ensurePat(repoCoord);
      if (!pat) {
        setFeedback("Approval cancelled — no PAT.");
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
        setFeedback(`Approval failed: ${result.status} ${result.message}`);
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
        const pat = ensurePat(repoCoord);
        if (!pat) {
          setFeedback("Cancelled — no PAT.");
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
          prose,
          selector: sel,
          bbox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
          viewport,
          userAgent: navigator.userAgent,
        });
        const body = formatReviewComment({ payload });
        const result = await submitComment({
          owner: repoCoord.owner,
          repo: repoCoord.repo,
          pr: prNumber,
          pat,
          body,
          apiBase: getProxyApiBase() ?? undefined,
        });
        if (result.ok) {
          setFeedback(`Comment posted (#${result.commentId}).`);
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
          setFeedback(`Failed: ${result.status} ${result.message}`);
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
        const pat = ensurePat(repoCoord);
        if (!pat) {
          setFeedback("Cancelled — no PAT.");
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
          prose,
          viewport,
          userAgent: navigator.userAgent,
          // No selector + no bbox → general comment.
        });
        const body = formatReviewComment({ payload });
        const result = await submitComment({
          owner: repoCoord.owner,
          repo: repoCoord.repo,
          pr: prNumber,
          pat,
          body,
          apiBase: getProxyApiBase() ?? undefined,
        });
        if (result.ok) {
          setFeedback(`Note posted (#${result.commentId}).`);
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
          setFeedback(`Failed: ${result.status} ${result.message}`);
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
  // don't supply a real owner/repo/pr. Avoids "submit comment"
  // failing silently because the API call goes nowhere.
  if (!owner || !repo || !prNumber) return null;

  return (
    <div
      data-slowcook-overlay-ui="1"
      style={{
        position: "fixed",
        inset: 0,
        pointerEvents: "none",
        zIndex: 2147483000,
      }}
    >
      {mode !== "nav" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundColor:
              mode === "comment"
                ? "rgba(255, 107, 107, 0.05)"
                : "rgba(74, 222, 128, 0.05)",
            pointerEvents: "none",
          }}
          aria-hidden="true"
        />
      )}
      <ModeToggle
        mode={mode}
        onChange={(m) => (m === "approve" ? onApproveClicked() : setMode(m))}
        disabled={submitting}
        isMobile={isMobile}
        isApproved={isApproved}
        commentCount={comments.length}
        onListClick={() => setListPanelOpen(true)}
      />
      {/* 0.3.0 — Figma-style pin layer for previously-left comments.
          Only visible in Comment mode (Nav stays clean). 0.5.0 —
          general (no-anchor) comments are skipped here; they show
          only in the list panel. */}
      {mode === "comment" && comments.length > 0 && (
        <CommentPins
          records={comments.filter((c) => c.payload.element !== null)}
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
      {feedback && <FeedbackToast text={feedback} onDismiss={() => setFeedback(null)} />}
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
const TOGGLE_POSITION_STORAGE_KEY = "slowcook.review-overlay.toggle-pos";

interface TogglePosition {
  /** Absolute top in CSS px from viewport top. */
  top: number;
  /** Absolute right in CSS px from viewport right. */
  right: number;
}

function loadTogglePosition(): TogglePosition {
  const fallback: TogglePosition = { top: 12, right: 12 };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(TOGGLE_POSITION_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<TogglePosition>;
    if (typeof parsed.top !== "number" || typeof parsed.right !== "number") return fallback;
    return { top: parsed.top, right: parsed.right };
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
  onChange: (m: Mode) => void;
  disabled: boolean;
  isMobile: boolean;
  isApproved: boolean;
  commentCount: number;
  onListClick: () => void;
}): JSX.Element {
  const { mode, onChange, disabled, isMobile, isApproved, commentCount, onListClick } = props;
  // 0.5.1 — initialise with the default; load saved position from
  // localStorage AFTER mount. Eliminates a hydration mismatch where
  // SSR/first-client render disagreed on the position value.
  const [pos, setPos] = useState<TogglePosition>({ top: 12, right: 12 });
  useEffect(() => { setPos(loadTogglePosition()); }, []);
  const dragRef = useRef<{ startX: number; startY: number; startTop: number; startRight: number } | null>(null);

  // Drag handlers — pointer events for unified mouse + touch.
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Only drag from the grip itself; clicks on toggle buttons must stay clicks.
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startTop: pos.top,
      startRight: pos.right,
    };
  }, [pos]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    e.preventDefault();
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    const newTop = Math.max(0, dragRef.current.startTop + dy);
    const newRight = Math.max(0, dragRef.current.startRight - dx);
    setPos({ top: newTop, right: newRight });
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
        right: pos.right,
        pointerEvents: "auto",
        display: "flex",
        alignItems: "center",
        gap: 4,
        // 0.4.2 — green-tinted background + green border when approved.
        background: isApproved
          ? "rgba(20, 83, 45, 0.92)"      // dark-green pill
          : "rgba(15, 15, 24, 0.92)",     // default dark
        padding: "4px 4px 4px 6px",
        borderRadius: 999,
        border: isApproved
          ? `1px solid rgba(34, 197, 94, 0.55)`   // brighter green border
          : "1px solid rgba(255, 255, 255, 0.16)",
        boxShadow: isApproved
          ? `0 4px 14px rgba(34, 197, 94, 0.30), inset 0 1px 0 rgba(255,255,255,0.06)`
          : "0 4px 14px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06)",
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: 13,
        color: "white",
        userSelect: "none",
      }}
    >
      {/* Slowcook logo — slow-cook pot with steam. Scales with currentColor. */}
      <SlowcookLogo />
      {/* Grip handle for dragging. Pointer events only on this element. */}
      <div
        role="button"
        aria-label="Drag overlay toggle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        title="Drag to move"
        style={{
          width: 8,
          height: 22,
          marginRight: 2,
          cursor: dragRef.current ? "grabbing" : "grab",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: 0.55,
          touchAction: "none",
        }}
      >
        <svg width="6" height="14" viewBox="0 0 6 14" aria-hidden="true">
          <circle cx="1.5" cy="2"  r="1.1" fill="currentColor" />
          <circle cx="4.5" cy="2"  r="1.1" fill="currentColor" />
          <circle cx="1.5" cy="7"  r="1.1" fill="currentColor" />
          <circle cx="4.5" cy="7"  r="1.1" fill="currentColor" />
          <circle cx="1.5" cy="12" r="1.1" fill="currentColor" />
          <circle cx="4.5" cy="12" r="1.1" fill="currentColor" />
        </svg>
      </div>
      <ToggleButton
        active={mode === "nav"}
        onClick={() => onChange("nav")}
        disabled={disabled}
        label={isMobile ? "🧭" : "Nav"}
        title="Navigate (default)"
      />
      <ToggleButton
        active={mode === "comment"}
        onClick={() => onChange("comment")}
        disabled={disabled}
        label={isMobile ? "💬" : "💬 Comment"}
        title="Comment on an element"
        accent
      />
      {isApproved ? (
        <span
          data-slowcook-overlay-ui="1"
          title="Mockup approved — comment thread stays open for follow-up; plate refuses to amend"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "6px 12px",
            borderRadius: 999,
            background: APPROVED_GREEN,
            color: "white",
            fontWeight: 700,
            fontSize: 13,
          }}
        >
          ✓ Approved
        </span>
      ) : (
        <ToggleButton
          active={mode === "approve"}
          onClick={() => onChange("approve")}
          disabled={disabled}
          label={isMobile ? "✅" : "✅ Approve"}
          title="Approve the mockup (asks for confirmation)"
          approve
        />
      )}
      {/* 0.5.0 — list-panel toggle. Always reachable; shows ALL
          comments (incl. hidden-element + general). Count badge. */}
      <button
        type="button"
        onClick={onListClick}
        disabled={disabled}
        title={`See all comments (${commentCount})`}
        style={{
          marginLeft: 4,
          background: "rgba(255,255,255,0.06)",
          color: "white",
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

function ToggleButton(props: { active: boolean; onClick: () => void; disabled: boolean; label: string; title?: string; accent?: boolean; approve?: boolean }): JSX.Element {
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
        background: bg,
        color: "white",
        border: "none",
        padding: "6px 12px",
        borderRadius: 999,
        cursor: props.disabled ? "not-allowed" : "pointer",
        opacity: props.disabled ? 0.6 : 1,
        font: "inherit",
      }}
    >
      {props.label}
    </button>
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
          background: "white",
          color: "#1a1a1a",
          borderRadius: 8,
          boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
          padding: 16,
          pointerEvents: "auto",
          fontFamily: "system-ui, -apple-system, sans-serif",
          fontSize: 13,
          zIndex: 2147483647,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Review comment</div>
        <div style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 11, opacity: 0.7, marginBottom: 8, wordBreak: "break-all" }}>
          {sel.selector}
        </div>
        <textarea
          aria-label="Comment text"
          autoFocus
          value={prose}
          onChange={(e) => setProse(e.target.value)}
          placeholder="What's off about this element?"
          rows={5}
          style={{
            width: "100%",
            padding: 8,
            border: "1px solid rgba(0,0,0,0.15)",
            borderRadius: 6,
            font: "inherit",
            resize: "vertical",
            boxSizing: "border-box",
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
          <button
            type="button"
            onClick={props.onCancel}
            disabled={props.submitting}
            style={{
              background: "transparent",
              border: "1px solid rgba(0,0,0,0.15)",
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

function ensurePat(repo: RepoCoord): string | null {
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
  openCommentId: number | null;
  onOpen: (id: number) => void;
  onClose: () => void;
  flashCommentId?: number | null;
}): JSX.Element {
  const { records, openCommentId, onOpen, onClose, flashCommentId } = props;
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
      {placements.map(({ record, rect, drifted }) => (
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
    default:              return { bg: ACCENT,    fg: "white",   glyph: "💬", ring: "rgba(255, 107, 107, 0.35)" };
  }
}

function PinIcon(props: {
  record: OverlayCommentRecord;
  x: number;
  y: number;
  drifted: boolean;
  flashing?: boolean;
  onClick: () => void;
}): JSX.Element {
  const status = props.record.plateReply?.status ?? null;
  const palette = pinPalette(status as never, props.drifted);
  const title = props.drifted
    ? `Selector drifted (anchored at original bbox); click to view`
    : `${status ?? "unresolved"} · click to view`;
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
        background: palette.bg,
        color: palette.fg,
        border: `2px solid white`,
        boxShadow: props.flashing
          ? `0 2px 6px rgba(0,0,0,0.25), 0 0 0 12px ${palette.ring}`
          : `0 2px 6px rgba(0,0,0,0.25), 0 0 0 4px ${palette.ring}`,
        transform: props.flashing ? "scale(1.4)" : "scale(1)",
        transition: "transform 220ms ease, box-shadow 220ms ease",
        cursor: "pointer",
        pointerEvents: "auto",
        fontSize: 11,
        fontWeight: 700,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        font: "inherit",
        padding: 0,
        lineHeight: 1,
      }}
    >
      {palette.glyph}
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
            ↗ Plate reply on GitHub
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
  onClose: () => void;
  onOpenComment: (id: number) => void;
  onAddGeneral: () => void;
}): JSX.Element {
  const { records, onClose, onOpenComment, onAddGeneral } = props;
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
        <div style={{ fontWeight: 600 }}>Comments ({records.length})</div>
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
      </div>
      <div style={{ overflow: "auto", flex: 1, padding: 8 }}>
        {records.length === 0 ? (
          <div style={{ padding: 16, opacity: 0.55, textAlign: "center", fontSize: 12 }}>
            No comments yet. Toggle 💬 Comment + click an element to anchor a comment, or use the button above for a page-level note.
          </div>
        ) : (
          records.slice().reverse().map((r) => {
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
            return (
              <button
                key={r.commentId}
                type="button"
                onClick={() => onOpenComment(r.commentId)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 8,
                  padding: 10,
                  marginBottom: 6,
                  cursor: "pointer",
                  color: "white",
                  font: "inherit",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                  <span style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 18,
                    height: 18,
                    borderRadius: 999,
                    background: palette.bg,
                    color: palette.fg,
                    fontSize: 10,
                    fontWeight: 700,
                  }}>{palette.glyph}</span>
                  <span style={{
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: 0.4,
                    padding: "1px 6px",
                    borderRadius: 999,
                    background: anchorLabel.bg,
                    color: anchorLabel.color,
                  }}>{anchorLabel.text}</span>
                  <span style={{ fontSize: 10, opacity: 0.55, marginLeft: "auto" }}>
                    @{r.author} · {formatTimeAgo(r.createdAt)}
                  </span>
                </div>
                <div style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.4, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                  {r.payload.prose}
                </div>
              </button>
            );
          })
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
        background: "white",
        color: "#1a1a1a",
        borderRadius: 10,
        padding: 16,
        boxShadow: "0 20px 60px rgba(0,0,0,0.45), 0 0 0 1px rgba(0,0,0,0.08)",
        pointerEvents: "auto",
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: 13,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 14 }}>Add page note</div>
      <div style={{ fontSize: 12, opacity: 0.65, marginBottom: 10 }}>
        Comment about overall behavior — not anchored to a specific element.
      </div>
      <textarea
        aria-label="Note text"
        autoFocus
        value={prose}
        onChange={(e) => setProse(e.target.value)}
        placeholder="e.g. 'Show an inline error when the user submits a duplicate name.'"
        rows={5}
        style={{
          width: "100%",
          padding: 8,
          border: "1px solid rgba(0,0,0,0.15)",
          borderRadius: 6,
          font: "inherit",
          resize: "vertical",
          boxSizing: "border-box",
        }}
      />
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
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
