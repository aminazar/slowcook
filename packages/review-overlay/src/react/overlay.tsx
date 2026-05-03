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
import { extractSelector } from "../selector.js";
import {
  buildPayload,
  formatReviewComment,
  type ViewportInfo,
} from "../comment-format.js";
import {
  loadPat,
  savePat,
  submitComment,
  type RepoCoord,
} from "../github.js";

export interface SlowcookReviewOverlayProps {
  /** GitHub owner (e.g. "aminazar"). */
  owner: string;
  /** GitHub repo (e.g. "slowcook"). */
  repo: string;
  /** Pull-request number for the mockup PR being reviewed. */
  prNumber: number;
  /** Optional story id; included in the JSON payload. */
  storyId?: string | null;
  /** Render only when truthy; useful for `process.env.NEXT_PUBLIC_SLOWCOOK_REVIEW === "1"` gating. */
  enabled?: boolean;
  /** Overlay package version, included in the JSON payload. */
  overlayVersion?: string;
}

type Mode = "nav" | "comment" | "approve";

const APPROVE_LABEL = "slowcook-mockup-approved";

const ACCENT = "#FF6B6B";

export function SlowcookReviewOverlay(props: SlowcookReviewOverlayProps): JSX.Element | null {
  const { owner, repo, prNumber, storyId = null, enabled = true } = props;
  const overlayVersion = props.overlayVersion ?? "0.1.0";
  const repoCoord: RepoCoord = { owner, repo };

  // Hooks must run unconditionally — render the null AFTER all hooks
  // are declared. Bails early during SSR via the typeof window check.
  const [mode, setMode] = useState<Mode>("nav");
  const [target, setTarget] = useState<Element | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [approveConfirmOpen, setApproveConfirmOpen] = useState(false);
  // 0.2.0 — track viewport width for the icon-only mobile collapse + the
  // picker-route hide. Updates on resize + initial mount.
  const [isMobile, setIsMobile] = useState<boolean>(false);
  const [isPickerRoute, setIsPickerRoute] = useState<boolean>(false);
  const composerRef = useRef<HTMLDivElement | null>(null);

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
  }, []);

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
      const body = `### ✅ Mockup approved\n\nPM approved the mockup via the review overlay (\`${overlayVersion}\`).\n\nPlease apply the \`${APPROVE_LABEL}\` label.`;
      const result = await submitComment({
        owner: repoCoord.owner,
        repo: repoCoord.repo,
        pr: prNumber,
        pat,
        body,
      });
      if (result.ok) {
        setFeedback(`Approval comment posted (#${result.commentId}).`);
        setMode("nav");
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
        });
        if (result.ok) {
          setFeedback(`Comment posted (#${result.commentId}).`);
          setComposerOpen(false);
          setTarget(null);
        } else {
          setFeedback(`Failed: ${result.status} ${result.message}`);
        }
      } finally {
        setSubmitting(false);
      }
    },
    [overlayVersion, prNumber, repoCoord, storyId, target]
  );

  if (!enabled) return null;
  if (typeof window === "undefined") return null;
  if (isPickerRoute) return null;

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
      />
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

function ModeToggle(props: { mode: Mode; onChange: (m: Mode) => void; disabled: boolean; isMobile: boolean }): JSX.Element {
  const { mode, onChange, disabled, isMobile } = props;
  const [pos, setPos] = useState<TogglePosition>(loadTogglePosition);
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
      style={{
        position: "absolute",
        top: pos.top,
        right: pos.right,
        pointerEvents: "auto",
        display: "flex",
        alignItems: "center",
        gap: 4,
        background: "rgba(15, 15, 24, 0.92)",
        padding: "4px 4px 4px 6px",
        borderRadius: 999,
        border: "1px solid rgba(255, 255, 255, 0.16)",
        boxShadow: "0 4px 14px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.06)",
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
      <ToggleButton
        active={mode === "approve"}
        onClick={() => onChange("approve")}
        disabled={disabled}
        label={isMobile ? "✅" : "✅ Approve"}
        title="Approve the mockup (asks for confirmation)"
        approve
      />
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
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: rect.x,
          top: rect.y,
          width: rect.width,
          height: rect.height,
          border: `2px solid ${ACCENT}`,
          outlineOffset: -2,
          pointerEvents: "none",
        }}
        aria-hidden="true"
      />
      <div
        ref={props.composerRef}
        data-slowcook-overlay-ui="1"
        role="dialog"
        aria-label="Review comment"
        style={{
          position: "absolute",
          right: 12,
          top: 64,
          width: 320,
          maxHeight: "70vh",
          overflow: "auto",
          background: "white",
          color: "#1a1a1a",
          borderRadius: 8,
          boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
          padding: 16,
          pointerEvents: "auto",
          fontFamily: "system-ui, -apple-system, sans-serif",
          fontSize: 13,
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

function ensurePat(repo: RepoCoord): string | null {
  // Try localStorage first; fall back to a window.prompt() the first
  // time. The PAT scopes the consumer needs are public_repo (or repo
  // for private). Storing in localStorage keeps it scoped to the
  // preview origin.
  if (typeof window === "undefined") return null;
  let pat = loadPat(window.localStorage, repo);
  if (pat) return pat;
  const entered = window.prompt(
    `Slowcook needs a GitHub PAT (scope: public_repo or repo) to post a comment on ${repo.owner}/${repo.repo}.\n\nIt will be stored only in this browser's localStorage for ${repo.owner}/${repo.repo}.`
  );
  if (!entered || entered.trim() === "") return null;
  pat = entered.trim();
  savePat(window.localStorage, repo, pat);
  return pat;
}
