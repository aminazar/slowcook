"use client";

import Link from "next/link";
import { useScenarioRegistry } from "./registry-context.js";

/**
 * 0.3.0 — per-scenario comment stats. Optional prop; when present,
 * each card renders a small badge cluster. Hook for fetching the data
 * lives in `@slowcook-ai/review-overlay/react#useScenarioCommentStats`
 * to keep mock-runtime UI-agnostic + free of GitHub deps.
 *
 * Shape mirrors review-overlay's `ScenarioCommentStats` so consumers
 * can pass the hook's output through verbatim.
 */
export interface ScenarioCommentStats {
  total: number;
  unresolved: number;
  applied: number;
  declined: number;
  specAltering: number;
  noop: number;
  /**
   * 0.3.1 — true when the corresponding mockup PR carries the
   * `slowcook-mockup-approved` label. The picker renders approved
   * cards with green border + "✓ Approved" badge.
   */
  approved?: boolean;
}

export interface ScenarioPickerProps {
  /**
   * Optional per-scenario comment stats keyed by scenario id. When set,
   * each card renders a small badge cluster (💬 total + ✓ applied +
   * 💬 unresolved + ! spec-altering + ⊘ declined + • noop). Zero-valued
   * categories are hidden so the row stays tight.
   */
  commentStats?: Record<string, ScenarioCommentStats>;
}

/**
 * Default homepage for a slowcook mock app. Lists every registered
 * scenario; each row links to that scenario's `initialPath` with
 * `?scenario=<id>` set so client components resolve correctly.
 *
 * When the registry is empty (just-bootstrapped mock with no vibe
 * runs) shows a placeholder with pointers to add the first scenario.
 *
 * Consumer's mock/src/app/page.tsx is just:
 *
 * ```tsx
 * import { ScenarioPicker } from "@slowcook-ai/mock-runtime";
 * export default function Page() {
 *   return <ScenarioPicker />;
 * }
 * ```
 *
 * Consumers can replace this with their own picker if they want to
 * surface scenarios differently (group by status, search, etc.) — the
 * registry + hooks API is stable; the UI is replaceable.
 *
 * 0.2.0 — visual structure pass: branded header with the slowcook
 * logo, framed scenario cards with hover affordance, footer line, and
 * tighter use of the consumer's existing tokens (`var(--color-coral)`,
 * `card-bg`, `card-border`).
 */
export function ScenarioPicker(props: ScenarioPickerProps = {}) {
  const registry = useScenarioRegistry();
  const scenarios = registry.list;
  const commentStats = props.commentStats;

  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(ellipse at top, rgba(255,107,107,0.06) 0%, transparent 60%), var(--background, #0f0f18)",
      }}
    >
      <header
        style={{
          maxWidth: 880,
          margin: "0 auto",
          padding: "32px 24px 0",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 24,
        }}
      >
        <Brand />
        <a
          href="https://github.com/aminazar/slowcook"
          target="_blank"
          rel="noreferrer"
          style={{
            fontSize: 12,
            opacity: 0.55,
            color: "var(--foreground, #e8e8f0)",
            textDecoration: "none",
            border: "1px solid var(--card-border, rgba(255,255,255,0.08))",
            padding: "5px 10px",
            borderRadius: 999,
          }}
        >
          slowcook · mock
        </a>
      </header>

      <main
        style={{
          maxWidth: 880,
          margin: "0 auto",
          padding: "32px 24px 80px",
          color: "var(--foreground, #e8e8f0)",
        }}
      >
        {scenarios.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <h1
              style={{
                fontSize: 22,
                fontWeight: 600,
                margin: "0 0 6px",
                letterSpacing: "-0.01em",
              }}
            >
              Scenarios
            </h1>
            <p style={{ fontSize: 13, opacity: 0.6, margin: "0 0 24px" }}>
              Each scenario renders the UI with one story&apos;s fixture data. Pick one
              to navigate into the mock.
            </p>
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: 0,
                display: "grid",
                gap: 12,
              }}
            >
              {scenarios.map((s) => {
                const stats = commentStats?.[s.id];
                const approved = stats?.approved === true;
                return (
                <li key={s.id}>
                  <Link
                    href={`${s.initialPath}?scenario=${encodeURIComponent(s.id)}`}
                    style={{
                      position: "relative",
                      display: "block",
                      padding: "16px 18px",
                      background: approved
                        ? "rgba(34, 197, 94, 0.06)"
                        : "var(--card-bg, rgba(255,255,255,0.03))",
                      border: approved
                        ? "1px solid rgba(34, 197, 94, 0.45)"
                        : "1px solid var(--card-border, rgba(255,255,255,0.08))",
                      borderRadius: 12,
                      textDecoration: "none",
                      color: "inherit",
                      transition: "border-color 120ms ease, transform 120ms ease, background 120ms ease",
                    }}
                    onMouseEnter={(e) => {
                      if (approved) {
                        e.currentTarget.style.borderColor = "rgba(34, 197, 94, 0.7)";
                        e.currentTarget.style.background = "rgba(34, 197, 94, 0.10)";
                      } else {
                        e.currentTarget.style.borderColor = "rgba(255,107,107,0.45)";
                        e.currentTarget.style.background = "rgba(255,107,107,0.04)";
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (approved) {
                        e.currentTarget.style.borderColor = "rgba(34, 197, 94, 0.45)";
                        e.currentTarget.style.background = "rgba(34, 197, 94, 0.06)";
                      } else {
                        e.currentTarget.style.borderColor = "var(--card-border, rgba(255,255,255,0.08))";
                        e.currentTarget.style.background = "var(--card-bg, rgba(255,255,255,0.03))";
                      }
                    }}
                  >
                    {/* 0.3.2 — APPROVED ribbon goes top-right (corner badge);
                        name + metadata flow without competing for space. */}
                    {approved && (
                      <span
                        title="Mockup approved · plate refuses further amendments"
                        style={{
                          position: "absolute",
                          top: 10,
                          right: 12,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          fontSize: 10,
                          fontWeight: 700,
                          letterSpacing: 0.5,
                          textTransform: "uppercase",
                          padding: "2px 7px",
                          borderRadius: 999,
                          background: "rgba(34, 197, 94, 0.18)",
                          color: "#22c55e",
                          border: "1px solid rgba(34, 197, 94, 0.45)",
                        }}
                      >
                        ✓ Approved
                      </span>
                    )}
                    {/* Name takes the full content width (minus the corner
                        ribbon's reservation). Metadata gets its own row
                        below — no more elbowing inline. */}
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: 15,
                        marginBottom: 4,
                        paddingRight: approved ? 96 : 0,
                        lineHeight: 1.35,
                      }}
                    >
                      {s.name}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        opacity: 0.55,
                        fontFamily: "ui-monospace, SFMono-Regular, monospace",
                        marginBottom: 4,
                      }}
                    >
                      story-{s.id} · {s.user ? `as ${s.user.handle}` : "anonymous"}
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        opacity: 0.6,
                        fontFamily: "ui-monospace, SFMono-Regular, monospace",
                      }}
                    >
                      {s.initialPath}
                    </div>
                    {s.expectedInteractions && s.expectedInteractions.length > 0 && (
                      <ul
                        style={{
                          marginTop: 12,
                          padding: 0,
                          listStyle: "none",
                          display: "grid",
                          gap: 4,
                        }}
                      >
                        {s.expectedInteractions.map((i, idx) => (
                          <li
                            key={idx}
                            style={{
                              fontSize: 12,
                              opacity: 0.6,
                              paddingLeft: 12,
                              borderLeft: "2px solid var(--card-border, rgba(255,255,255,0.12))",
                              lineHeight: 1.5,
                            }}
                          >
                            {i}
                          </li>
                        ))}
                      </ul>
                    )}
                    {commentStats && commentStats[s.id] && commentStats[s.id]!.total > 0 && (
                      <CommentStatsRow stats={commentStats[s.id]!} />
                    )}
                  </Link>
                </li>
                );
              })}
            </ul>
          </>
        )}

        <footer
          style={{
            marginTop: 40,
            paddingTop: 16,
            borderTop: "1px solid var(--card-border, rgba(255,255,255,0.06))",
            fontSize: 11,
            opacity: 0.45,
            display: "flex",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <span>scenarios are mock data; refreshing resets state. brew wires real data later.</span>
          <span>{scenarios.length} scenario{scenarios.length === 1 ? "" : "s"}</span>
        </footer>
      </main>
    </div>
  );
}

function EmptyState() {
  return (
    <div
      style={{
        padding: 28,
        background: "var(--card-bg, rgba(255,255,255,0.03))",
        border: "1px solid var(--card-border, rgba(255,255,255,0.08))",
        borderRadius: 12,
        color: "var(--foreground, #e8e8f0)",
      }}
    >
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 8px" }}>
        No scenarios registered yet
      </h1>
      <p style={{ fontSize: 13, opacity: 0.7, margin: "0 0 16px" }}>
        The mock is bootstrapped but empty. Scenarios are added by the{" "}
        <code style={codeStyle}>vibe</code> agent when it runs against a story
        spec, OR you can hand-author one for testing:
      </p>
      <ol style={{ fontSize: 13, opacity: 0.7, paddingLeft: 20, display: "grid", gap: 6, margin: 0 }}>
        <li>
          Create <code style={codeStyle}>mock/scenarios/story-N.ts</code> exporting a
          default <code style={codeStyle}>Scenario</code>
        </li>
        <li>
          Add an import + entry to{" "}
          <code style={codeStyle}>mock/src/lib/scenario-registry.ts</code>
        </li>
        <li>Refresh — your scenario appears here</li>
      </ol>
    </div>
  );
}

const codeStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  padding: "1px 6px",
  borderRadius: 4,
  fontSize: 12,
  fontFamily: "ui-monospace, SFMono-Regular, monospace",
};

/**
 * 0.3.0 — per-card comment stats row. Renders only the categories with
 * non-zero counts so the row stays tight on cards without much activity.
 * Color cues match the review-pill's pin palette so the visual language
 * is consistent across surfaces.
 */
function CommentStatsRow(props: { stats: ScenarioCommentStats }) {
  const { stats } = props;
  const items: Array<{ count: number; glyph: string; color: string; bg: string; label: string }> = [
    { count: stats.total,        glyph: "💬", color: "#94a3b8", bg: "rgba(148, 163, 184, 0.12)", label: "comments" },
    { count: stats.applied,      glyph: "✓",  color: "#22c55e", bg: "rgba(34, 197, 94, 0.12)",   label: "applied" },
    { count: stats.unresolved,   glyph: "●",  color: "#FF6B6B", bg: "rgba(255, 107, 107, 0.12)", label: "unresolved" },
    { count: stats.specAltering, glyph: "!",  color: "#facc15", bg: "rgba(250, 204, 21, 0.16)",  label: "spec-altering" },
    { count: stats.declined,     glyph: "⊘",  color: "#94a3b8", bg: "rgba(148, 163, 184, 0.12)", label: "declined" },
    { count: stats.noop,         glyph: "·",  color: "#94a3b8", bg: "rgba(148, 163, 184, 0.12)", label: "noop" },
  ].filter((i) => i.count > 0);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12, paddingTop: 12, borderTop: "1px dashed var(--card-border, rgba(255,255,255,0.08))" }}>
      {items.map((i) => (
        <span
          key={i.label}
          title={`${i.count} ${i.label}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 8px",
            borderRadius: 999,
            background: i.bg,
            color: i.color,
            fontSize: 11,
            fontWeight: 600,
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
          }}
        >
          <span aria-hidden="true">{i.glyph}</span>
          <span>{i.count}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * Brand mark for the picker header — slowcook logo + wordmark.
 * Inline SVG; no asset dep. Same logo as the review-overlay's pill
 * (kept in sync by hand for now; would lift to a shared sub-package
 * if more surfaces start using it).
 */
function Brand() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--foreground, #e8e8f0)" }}>
      <span
        aria-hidden="true"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 36,
          height: 36,
          background: "rgba(255,107,107,0.12)",
          color: "#FF6B6B",
          borderRadius: 10,
          border: "1px solid rgba(255,107,107,0.25)",
        }}
      >
        <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M8 3 Q9 4 8 5.5 Q7 7 8 8.5 M12 2 Q13 3.5 12 5 Q11 6.5 12 8 M16 3 Q17 4 16 5.5 Q15 7 16 8.5"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            fill="none"
            opacity="0.85"
          />
          <rect x="4" y="9.5" width="16" height="2.2" rx="1.1" fill="currentColor" />
          <rect x="11" y="8.4" width="2" height="1.4" rx="0.4" fill="currentColor" />
          <path
            d="M5 12.2 H19 V18.5 a2.5 2.5 0 0 1 -2.5 2.5 H7.5 a2.5 2.5 0 0 1 -2.5 -2.5 Z"
            fill="currentColor"
          />
          <rect x="2" y="13.5" width="2.5" height="3" rx="0.6" fill="currentColor" />
          <rect x="19.5" y="13.5" width="2.5" height="3" rx="0.6" fill="currentColor" />
        </svg>
      </span>
      <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.1 }}>
        <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.01em" }}>slowcook</span>
        <span style={{ fontSize: 11, opacity: 0.55 }}>mock — design contract</span>
      </div>
    </div>
  );
}
