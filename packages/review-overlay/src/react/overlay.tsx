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
  const composerRef = useRef<HTMLDivElement | null>(null);

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
      <ModeToggle mode={mode} onChange={setMode} disabled={submitting} />
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
      {feedback && <FeedbackToast text={feedback} onDismiss={() => setFeedback(null)} />}
    </div>
  );
}

function ModeToggle(props: { mode: Mode; onChange: (m: Mode) => void; disabled: boolean }): JSX.Element {
  const { mode, onChange, disabled } = props;
  return (
    <div
      data-slowcook-overlay-ui="1"
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        pointerEvents: "auto",
        display: "flex",
        gap: 4,
        background: "rgba(15, 15, 24, 0.92)",
        padding: 4,
        borderRadius: 999,
        boxShadow: "0 4px 14px rgba(0,0,0,0.25)",
        fontFamily: "system-ui, -apple-system, sans-serif",
        fontSize: 13,
        color: "white",
      }}
    >
      <ToggleButton active={mode === "nav"} onClick={() => onChange("nav")} disabled={disabled} label="Nav" />
      <ToggleButton active={mode === "comment"} onClick={() => onChange("comment")} disabled={disabled} label="💬 Comment" accent />
      <ToggleButton active={mode === "approve"} onClick={() => onChange("approve")} disabled={disabled} label="✅ Approve" approve />
    </div>
  );
}

function ToggleButton(props: { active: boolean; onClick: () => void; disabled: boolean; label: string; accent?: boolean; approve?: boolean }): JSX.Element {
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
