/**
 * GitHubIssueReview — the TURNKEY issue-transport review pill (0.17.0).
 *
 * Everything dash's refine/wire/skin boards proved, folded into one mount:
 *   <GitHubIssueReview owner="org" repo="app" labels={["lcr-review","app-review"]} />
 *
 * - comments file as labeled GitHub issues (Node/Card format, pin → issue)
 * - hydration: GitHub is the record — every labeled issue (open AND closed;
 *   done-reports live on applied threads), replies in thread popovers
 * - agent replies may carry `<!-- slowcook:agent NAME -->` and
 *   `<!-- slowcook:cost cents=N basis="..." -->` markers → rendered as
 *   "NAME · agent" with a money line (cost reporting is for agents only)
 * - sign-in: GitHub device flow when `authBase` (a reviewer-auth-server) is
 *   given — one code, no token dance; guided classic-PAT paste as fallback
 * - a 401 anywhere flips a visible red dot on the key — never silent death
 *
 * The shell itself stays transport-free in ./review-shell; this file is the
 * GitHub-issues adapter around it.
 */
import { useEffect, useState, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { renderEvidenceMarkdown } from "../comment-format.js";
import { uploadReviewAsset } from "../github.js";
import { useReviewEvidence, rectForNode, type EvidenceConfig } from "./use-evidence.js";
import { usePrefersDark } from "./theme.js";
import {
  ReviewShell, localStorageStore,
  type ReviewComment, type ReviewCommentMeta, type Corner,
} from "./review-shell.js";
import { loadPat, savePat, type RepoCoord } from "../github.js";
import {
  loadReviewerToken, saveReviewerToken, saveReviewerIdentity, loadReviewerIdentity,
  requestDeviceCode, pollAccessToken, identifyReviewer,
} from "../reviewer-session.js";

/* ────────────────────────────── pure transport helpers (unit-tested) */

export interface AgentReply {
  author: string;
  text: string;
}

/** Parse the slowcook agent/cost markers off a reply body. */
export function parseAgentReply(login: string, body: string): AgentReply {
  const agent = /<!--\s*slowcook:agent\s+([a-z0-9-]+)\s*-->/.exec(body)?.[1];
  const cost = /<!--\s*slowcook:cost\s+cents=(\d+)(?:\s+basis="([^"]*)")?\s*-->/.exec(body);
  let text = body.replace(/<!--\s*slowcook:[^>]*-->\s*/g, "").trim();
  if (cost) {
    const dollars = (Number(cost[1]) / 100).toFixed(2);
    text += `\n\n*cost: ~$${dollars}${cost[2] ? ` (${cost[2]})` : ""}*`;
  }
  return { author: agent ? `${agent} · agent` : login, text };
}

export function buildIssueBody(c: ReviewComment, surface: string, extra?: { evidenceMd?: string[]; screenshotDataUrl?: string; screenshotUrl?: string; context?: { url?: string; viewport?: string; scheme?: string } }): string {
  const ctx = extra?.context;
  const lines = [
    `**Review note (${surface})**`, "",
    `**Node:** \`${c.node}\``, `**Card:** ${c.label}`,
    ...(c.route ? [`**Route:** \`${c.route}\``] : []),
    ...(ctx?.url ? [`**URL:** ${ctx.url}`] : []),
    ...(ctx?.viewport ? [`**Viewport:** ${ctx.viewport}${ctx.scheme ? ` · ${ctx.scheme} mode` : ""}`] : []),
    "",
    `> ${c.text.replace(/\n/g, "\n> ")}`, "",
  ];
  if (extra?.screenshotDataUrl) { lines.push(`![screenshot](${extra.screenshotDataUrl})`, ""); }
  if (extra?.screenshotUrl) { lines.push(`📸 [screenshot — the commented element, ringed](${extra.screenshotUrl})`, ""); }
  if (extra?.evidenceMd?.length) { lines.push(...extra.evidenceMd, ""); }
  lines.push(`_Filed from the review shell._`);
  return lines.join("\n");
}

export interface IssueLike {
  number: number;
  title: string;
  body: string;
  state: string;
  html_url: string;
  created_at: string;
  user: { login: string };
  comments: number;
  labels?: { name: string }[];
}

export function parseIssue(i: IssueLike): (ReviewComment & { state: string; nComments: number; working: boolean }) | null {
  let node = /\*\*Node:\*\* `([^`]+)`/.exec(i.body)?.[1];
  if (!node) {
    const el = /\*\*Element:\*\* `([^`]+)`/.exec(i.body)?.[1];
    const tid = el ? /data-testid="([^"]+)"/.exec(el)?.[1] : undefined;
    node = tid ?? (el ? `dom:${el}` : undefined);
  }
  if (!node) return null;
  const label = /\*\*Card:\*\* (.+)/.exec(i.body)?.[1]?.trim() ?? i.title;
  // the prose ends where the appendix begins — screenshot, evidence block or
  // the filed-from footer, whichever comes first (0.21.0: evidence-carrying
  // bodies used to leak their whole appendix into the sidebar's comment text)
  const quoted = i.body.split(/\n> /).slice(1).join("\n");
  const route = /\*\*Route:\*\* `([^`]+)`/.exec(i.body)?.[1];
  const text = (quoted.split(/\n\n(?:!\[screenshot\]|📸 \[screenshot|<details><summary>evidence|_Filed)/)[0] ?? i.title).replace(/\n> /g, "\n");
  return {
    id: `gh-${i.number}`, node, label, text: text.trim(), ...(route ? { route } : {}),
    author: i.user.login, createdAt: Date.parse(i.created_at),
    remoteId: i.number, url: i.html_url,
    state: i.state, nComments: i.comments,
    working: i.labels?.some((l) => l.name === "agent-working") ?? false,
  };
}

/* ────────────────────────────── auth (module-level 401 signal) */

let authBad = false;
const authSubs = new Set<() => void>();
function setAuthBad(v: boolean) {
  if (authBad === v) return;
  authBad = v;
  authSubs.forEach((f) => f());
}

function makeGh(coord: RepoCoord) {
  const loadTok = (): string | null => {
    try {
      return loadReviewerToken(localStorage, coord) ?? loadPat(localStorage, coord);
    } catch { return null; }
  };
  const gh = async (path: string, init?: RequestInit) => {
    const tok = loadTok();
    const res = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        ...(tok ? { authorization: `Bearer ${tok}` } : {}),
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    if (tok && res.status === 401) setAuthBad(true);
    else if (tok && res.ok) setAuthBad(false);
    return res;
  };
  return { gh, loadTok };
}

/** Pure popover placement (0.22.2, extracted for the environment-matrix
 *  tests): anchored to the trigger's rect, clamped to the viewport, opening
 *  upward when the pill sits in the lower half — the common corner. */
export function placePopover(
  r: { top: number; bottom: number; right: number },
  vw: number, vh: number, W = 300,
): { left: number; top?: number; bottom?: number } {
  const left = Math.max(8, Math.min(r.right - W, vw - W - 8));
  return r.top > vh / 2 ? { left, bottom: vh - r.top + 8 } : { left, top: r.bottom + 8 };
}

function SignIn({ coord, authBase, onDone }: { coord: RepoCoord; authBase?: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  // 0.22.2 — the popover ANCHORS TO THE PILL (it was fixed at right:16
  // bottom:64, a spot the draggable pill may be nowhere near), FOLLOWS THE
  // HOST THEME (it was hardcoded dark), and pins dir="ltr" (its chrome is
  // English; on an RTL host page it inherited rtl and read mangled —
  // delgoosh's Persian QA surfaces found all three).
  const dark = usePrefersDark();
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) { setAnchor(null); return; }
    setAnchor(placePopover(r, window.innerWidth, window.innerHeight));
  };
  const C = dark
    ? { bg: "#1f1f1f", fg: "#e9e9e9", dim: "#8d8d8d", border: "#5c5c5c", inputBg: "#2b2b2b", inputBorder: "#555", btnBg: "#e9e9e9", btnFg: "#1a1a1a", shadow: "0 14px 44px rgba(0,0,0,.5)" }
    : { bg: "#ffffff", fg: "#1a1a1a", dim: "#6b6b6b", border: "#d0d0d0", inputBg: "#f5f5f5", inputBorder: "#bbb", btnBg: "#1a1a1a", btnFg: "#ffffff", shadow: "0 14px 44px rgba(0,0,0,.18)" };
  const [tok, setTok] = useState("");
  const [flow, setFlow] = useState<{ step: "idle" | "starting" | "failed"; why?: string } | { step: "code"; userCode: string; verificationUri: string }>({ step: "idle" });
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    authSubs.add(f);
    return () => { authSubs.delete(f); };
  }, []);
  const { loadTok } = makeGh(coord);
  const authed = !!loadTok();
  const identity = (() => { try { return loadReviewerIdentity(localStorage, coord); } catch { return null; } })();
  const who = identity?.login;
  const avatar = identity?.avatarUrl ?? (who ? `https://github.com/${who}.png?size=64` : undefined);

  const finish = async (token: string) => {
    try {
      saveReviewerToken(localStorage, coord, token);
      savePat(localStorage, coord, token);
      saveReviewerIdentity(localStorage, coord, await identifyReviewer(token));
    } catch { /* identity is cosmetic */ }
    setAuthBad(false);
    setFlow({ step: "idle" }); setOpen(false); setTok("");
    onDone();
  };

  const startDevice = async () => {
    if (!authBase) return;
    setFlow({ step: "starting" });
    let grant;
    try { grant = await requestDeviceCode(authBase); } catch {
      setFlow({ step: "failed", why: "The sign-in helper didn't answer — the token fallback below works." });
      return;
    }
    setFlow({ step: "code", userCode: grant.userCode, verificationUri: grant.verificationUri });
    let wait = Math.max(grant.intervalSeconds, 5);
    const deadline = Date.now() + grant.expiresInSeconds * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, wait * 1000));
      let poll;
      try { poll = await pollAccessToken(authBase, grant.deviceCode); } catch { continue; }
      if (poll.status === "authorized") { await finish(poll.token); return; }
      if (poll.status === "slow_down") wait = poll.intervalSeconds;
      if (poll.status === "expired" || poll.status === "denied") {
        setFlow({ step: "failed", why: poll.status === "expired" ? "The code expired — start again." : "GitHub reported the request was declined." });
        return;
      }
    }
    setFlow({ step: "failed", why: "The code expired — start again." });
  };

  const savePatTok = async () => {
    const t = tok.trim();
    if (!t) return;
    const r = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${t}` } }).catch(() => null);
    if (r?.ok) await finish(t);
  };

  const tokenUrl = `https://github.com/settings/tokens/new?scopes=repo&description=${encodeURIComponent(`review ${coord.owner}/${coord.repo}`)}`;
  const mono = { fontFamily: "ui-monospace, monospace" } as const;
  return (
    <>
      <button ref={btnRef} onClick={() => { place(); setOpen((o) => !o); }}
        title={authBad ? "GitHub sign-in expired — sign in again" : authed ? `Signed in${who ? ` as ${who}` : ""}` : "Sign in to review"}
        style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: "0 2px", display: "inline-flex", alignItems: "center", position: "relative" }}>
        {/* signed in → YOUR avatar, sized to the pill (16px, round) — the
            lock only while signed out or expired */}
        {authed && !authBad && avatar
          ? <img src={avatar} alt={who ?? "signed in"} width={16} height={16} style={{ width: 16, height: 16, borderRadius: 999, objectFit: "cover", display: "block" }} />
          : <span style={{ opacity: authed && !authBad ? 0.55 : 1 }}>{authed && !authBad ? "🔓" : "🔑"}</span>}
        {authBad && <span style={{ position: "absolute", top: -2, right: -2, width: 7, height: 7, borderRadius: 999, background: "#e0483f" }} />}
      </button>
      {open && createPortal(
        <div dir="ltr" style={{ position: "fixed", left: anchor?.left ?? 16, ...(anchor?.top !== undefined ? { top: anchor.top } : { bottom: anchor?.bottom ?? 64 }), width: 300, textAlign: "left", background: C.bg, color: C.fg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, zIndex: 2147483200, fontFamily: "system-ui, sans-serif", boxShadow: C.shadow }}>
          <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 2 }}>{authBad ? "Sign-in expired — sign in again" : authed ? `Signed in${who ? ` as ${who}` : ""}` : "Sign in to review"}</div>
          <div style={{ fontSize: 10, color: C.dim, ...mono, marginBottom: 10 }}>{coord.owner}/{coord.repo}</div>
          {authBase && flow.step !== "code" && (
            <button onClick={() => void startDevice()} disabled={flow.step === "starting"}
              style={{ display: "block", width: "100%", textAlign: "center", background: C.btnBg, color: C.btnFg, borderRadius: 8, padding: "7px 0", border: "none", cursor: "pointer", fontWeight: 700, fontSize: 11.5, marginBottom: 8 }}>
              {flow.step === "starting" ? "Asking GitHub…" : "Sign in with GitHub"}
            </button>
          )}
          {flow.step === "code" && (
            <div style={{ textAlign: "center", marginBottom: 8 }}>
              <div style={{ fontSize: 10, color: C.dim, marginBottom: 4 }}>Enter this code on GitHub:</div>
              <div style={{ ...mono, fontSize: 20, fontWeight: 800, letterSpacing: 2, marginBottom: 6, userSelect: "all" }}>{flow.userCode}</div>
              <a href={flow.verificationUri} target="_blank" rel="noreferrer"
                style={{ display: "block", background: C.btnBg, color: C.btnFg, borderRadius: 8, padding: "6px 0", textDecoration: "none", fontWeight: 700, fontSize: 11.5 }}>
                Open github.com/login/device ↗
              </a>
              <div style={{ fontSize: 9.5, color: C.dim, marginTop: 5 }}>waiting for GitHub…</div>
            </div>
          )}
          {flow.step === "failed" && <div style={{ fontSize: 10, color: "#c66", marginBottom: 7 }}>{flow.why}</div>}
          <details open={!authBase}>
            <summary style={{ fontSize: 9.5, color: C.dim, cursor: "pointer" }}>paste a token instead</summary>
            <a href={tokenUrl} target="_blank" rel="noreferrer" style={{ display: "block", fontSize: 10.5, color: C.fg, margin: "6px 0" }}>① Create a token on GitHub ↗ (pre-filled, repo scope)</a>
            <input type="password" value={tok} onChange={(e) => setTok(e.target.value)} placeholder="② paste ghp_… / gho_…"
              onKeyDown={(e) => { if (e.key === "Enter") void savePatTok(); }} autoComplete="off"
              style={{ width: "100%", boxSizing: "border-box", fontSize: 11.5, padding: "6px 9px", borderRadius: 10, border: `1px solid ${C.inputBorder}`, background: C.inputBg, color: C.fg }} />
          </details>
          <div style={{ fontSize: 9.5, color: C.dim, marginTop: 6 }}>One sign-in covers every review surface on this site, in this browser.</div>
        </div>,
        document.body,
      )}
    </>
  );
}

/* ────────────────────────────── the turnkey component */

export interface GitHubIssueReviewProps {
  owner: string;
  repo: string;
  /** Labels applied to every filed issue; the LAST one scopes hydration. */
  labels: string[];
  /** Reviewer display name for locally-drafted comments. */
  author?: string;
  /** One-line surface name embedded in issue bodies (e.g. "staging — /app"). */
  surface?: string;
  title?: string;
  accent?: string;
  icon?: string;
  corner?: Corner;
  /** Origin (or "") serving /__slowcook/auth/* — enables GitHub device flow. */
  authBase?: string;
  /** Bump to force re-hydration (e.g. from an SSE relay). */
  hydrateKey?: number;
  storageKey?: string;
  requireTargets?: boolean;
  anchorFallback?: boolean;
  sidebarFooter?: ReactNode;
  /** Extra pill accessory rendered BEFORE the built-in sign-in key (e.g. an
   *  Ask-agent button). */
  accessory?: ReactNode;
  /** 0.21.0 — REVIEW EVIDENCE (QA mode on a real backend): the ringed
   *  screenshot crop and the 60s network/console tail, attached to every
   *  filed issue. Same shape and behavior as the overlay's `evidence`. */
  evidence?: EvidenceConfig;
  /** 0.22.0 — dash-harness parity: active review seconds, banked however the
   *  host wants (dash posts to a relay; a QA consumer may localStorage it). */
  onActiveTime?: (seconds: number) => void;
  /** 0.22.0 — what a page-level comment calls the page (dash: "the page"). */
  pageLabel?: string;
  /** 0.22.0 — the mode toggle's words; dash's boards read Review/Comment. */
  toggleLabels?: [string, string];
  /** 0.22.0 — extra content on the built-in status row (rendered after the
   *  sync chip). The row itself is standard now: every consumer gets the ⟳
   *  sync-age/tap-to-re-read chip dash's boards proved. */
  statusExtra?: ReactNode;
  /** 0.23.1 — lift the pill above a host bottom bar (dash no.588: the pill
   *  rests ABOVE the phone bottom-nav, never on it). Pixels. */
  bottomInset?: number;
  /** 0.23.1 — routes that inherited another's meaning keep its pins
   *  (dash no.675). Map: filed-on route → routes that may show it. */
  routeHeirs?: Record<string, string[]>;
}

export function GitHubIssueReview(p: GitHubIssueReviewProps) {
  const coord: RepoCoord = { owner: p.owner, repo: p.repo };
  const { gh, loadTok } = makeGh(coord);
  const [meta, setMeta] = useState<Record<string, ReviewCommentMeta>>({});
  const [, bump] = useState(0);
  // 0.22.0 — the sync chip's truth: when the pins were last re-read, and the
  // honest error when GitHub said no. Amber past 3 minutes, like dash's row.
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [rehydrate, setRehydrate] = useState(0);
  // 0.22.3 — THE TIMER IS VISIBLE (Amin: dash measured active time but showed
  // it nowhere). The shell's own measurement feeds a ⏱ chip on the status
  // row; the host's onActiveTime callback still receives every flush.
  const [activeSec, setActiveSec] = useState(0);
  const scopeLabel = p.labels[p.labels.length - 1] ?? p.labels[0] ?? "review";
  const surface = p.surface ?? `${p.owner}/${p.repo}`;

  const gatherEvidence = useReviewEvidence({
    config: p.evidence,
    upload: async (base64, path) => {
      const pat = loadTok();
      if (!pat) return null;
      const up = await uploadReviewAsset({ owner: p.owner, repo: p.repo, pat, path, contentBase64: base64 });
      return up.ok ? up.blobUrl : null;
    },
  });

  const onComment = async (c: ReviewComment) => {
    if (!loadTok()) {
      setMeta((m) => ({ ...m, [c.id]: { status: "local only", replies: [{ author: "shell", text: "No GitHub sign-in in this browser — tap the 🔑 on the pill; the comment auto-posts after sign-in." }] } }));
      return;
    }
    // evidence rides every filed issue: the crop is of the pinned node when it
    // still stands (re-resolved now — the page may have scrolled), else the
    // viewport; the tail is whatever the last 60s actually did
    const shots: import("./use-evidence.js").GatheredEvidence = await gatherEvidence(rectForNode(c.node)).catch(() => ({}));
    const evidenceMd = shots.evidence ? [
      ...renderEvidenceMarkdown(shots.evidence),
      "", "<!-- slowcook-evidence", JSON.stringify(shots.evidence), "-->",
    ] : undefined;
    const res = await gh(`/repos/${p.owner}/${p.repo}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: `[review] ${c.label} — ${c.text.slice(0, 60)}${c.text.length > 60 ? "…" : ""}`,
        body: buildIssueBody(c, surface, {
          evidenceMd, screenshotDataUrl: shots.screenshotDataUrl, screenshotUrl: shots.screenshotUrl,
          context: {
            url: typeof location !== "undefined" ? location.href : undefined,
            viewport: typeof window !== "undefined" ? `${window.innerWidth}×${window.innerHeight}` : undefined,
            scheme: typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
          },
        }),
        labels: p.labels,
      }),
    }).catch(() => null);
    if (!res?.ok) {
      setMeta((m) => ({ ...m, [c.id]: { status: "not posted", replies: [{ author: "shell", text: `GitHub said ${res?.status ?? "network error"} — saved locally; it will retry.` }] } }));
      return;
    }
    const issue = await res.json() as { number: number; html_url: string };
    return { url: issue.html_url, remoteId: issue.number };
  };

  // 0.23.0 — a pin whose ISSUE was deleted leaves the board (dash 12fdc12).
  // 404/410 ⇒ gone; anything else (including closed — that renders as
  // applied) or a network hiccup ⇒ keep, lag-safe.
  const verifyRemote = async (remoteId: string | number): Promise<boolean> => {
    if (!loadTok()) return true;
    const r = await gh(`/repos/${p.owner}/${p.repo}/issues/${remoteId}`).catch(() => null);
    if (!r) return true;
    return !(r.status === 404 || r.status === 410);
  };

  const onReply = async (c: ReviewComment, text: string) => {
    if (typeof c.remoteId !== "number" || !loadTok()) return;
    await gh(`/repos/${p.owner}/${p.repo}/issues/${c.remoteId}/comments`, {
      method: "POST", body: JSON.stringify({ body: text }),
    }).catch(() => { /* optimistic copy stays; hydration reconciles */ });
  };

  const hydrate = async (): Promise<ReviewComment[] | null> => {
    if (!loadTok()) { setSyncError("signed out"); return null; }
    const r = await gh(`/repos/${p.owner}/${p.repo}/issues?labels=${encodeURIComponent(scopeLabel)}&state=all&per_page=100`).catch(() => null);
    if (!r?.ok) { setSyncError(r ? `GitHub ${r.status}` : "network error"); return null; }
    setSyncError(null); setSyncedAt(Date.now());
    const issues = await r.json() as IssueLike[];
    const parsed = issues.map(parseIssue).filter((x): x is NonNullable<ReturnType<typeof parseIssue>> => !!x);
    const nextMeta: Record<string, ReviewCommentMeta> = {};
    for (const c of parsed) {
      let replies: AgentReply[] = [];
      if (c.nComments > 0) { // open AND closed — done-reports live on applied threads
        const cr = await gh(`/repos/${p.owner}/${p.repo}/issues/${c.remoteId}/comments`).catch(() => null);
        if (cr?.ok) {
          const list = await cr.json() as { user: { login: string }; body: string }[];
          replies = list.map((x) => parseAgentReply(x.user.login, x.body));
        }
      }
      nextMeta[c.id] = { status: c.state === "closed" ? "applied" : c.working ? "working" : "filed", replies, url: c.url };
    }
    setMeta((m) => ({ ...m, ...nextMeta }));
    return parsed.map(({ state: _s, nComments: _n, working: _w, ...c }) => c);
  };

  return (
    <ReviewShell
      enabled
      requireTargets={p.requireTargets ?? true}
      anchorFallback={p.anchorFallback ?? true}
      title={p.title ?? "Review"}
      toggleLabels={p.toggleLabels ?? ["Read", "Comment"]}
      pageLabel={p.pageLabel}
      onActiveTime={(seconds) => { setActiveSec((t) => t + seconds); p.onActiveTime?.(seconds); }}
      corner={p.corner ?? "bottom-left"}
      accent={p.accent ?? "#A31621"}
      icon={p.icon}
      author={p.author ?? (() => { try { return loadReviewerIdentity(localStorage, coord)?.login ?? "Reviewer"; } catch { return "Reviewer"; } })()}
      store={localStorageStore(p.storageKey ?? `${p.owner}/${p.repo}:issue-review`)}
      onComment={onComment}
      onReply={onReply}
      hydrate={hydrate}
      verifyRemote={verifyRemote}
      routeHeirs={p.routeHeirs}
      bottomInset={p.bottomInset}
      hydrateKey={(p.hydrateKey ?? 0) + rehydrate}
      meta={meta}
      statusRow={
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center", maxWidth: "100%", minWidth: 0 }}>
          {(() => {
            const mins = syncedAt === null ? null : Math.floor((Date.now() - syncedAt) / 60000);
            const stale = mins === null || mins >= 3;
            return (
              <button onClick={() => setRehydrate((k) => k + 1)}
                title={syncError ?? (syncedAt ? `pins re-read ${mins}m ago — tap to re-read now` : "pins not read yet — tap to read")}
                style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 9.5, padding: "0 2px", flexShrink: 0, maxWidth: 118, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: syncError || stale ? "#E8B84B" : "inherit", opacity: 0.85, fontFamily: "ui-monospace, monospace" }}>
                ⟳{syncError ? syncError : syncedAt ? (mins === 0 ? "now" : `${mins}m`) : "—"}
              </button>
            );
          })()}
          {activeSec >= 60 && (
            <span title="active review time this session — a tab being read, not a tab on a desk"
              style={{ fontSize: 9.5, fontFamily: "ui-monospace, monospace", opacity: 0.85, flexShrink: 0 }}>
              ⏱{activeSec >= 3600 ? `${Math.floor(activeSec / 3600)}h${Math.floor((activeSec % 3600) / 60)}m` : `${Math.floor(activeSec / 60)}m`}
            </span>
          )}
          {p.statusExtra}
        </span>
      }
      accessory={<>{p.accessory}<SignIn coord={coord} authBase={p.authBase} onDone={() => bump((n) => n + 1)} /></>}
      sidebarFooter={p.sidebarFooter}
    />
  );
}
