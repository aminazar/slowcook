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
import { AttachedWindow } from "./attached-window.js";

/** The review-time report (dash's relay contract, ported): what reviewing
 *  amounted to — today/week/average seconds, pins, the seven-day shape. */
export interface ScreentimeReport {
  todaySeconds: number;
  weekSeconds: number;
  dailyAverageSeconds: number;
  todayComments?: number;
  weekComments?: number;
  daysCounted?: number;
  days: { date: string; seconds: number; comments?: number }[];
}

// ── the local screentime bank (no relay required): day-bucketed seconds and
//    pins per repo, in localStorage. A relay (`screentimeBase`) supersedes it
//    for cross-device counting; this keeps the panel honest on one browser.
const bankKey = (c: RepoCoord) => `slowcook.review-screentime.${c.owner}/${c.repo}`;
type Bank = Record<string, { s: number; c: number }>;
const readBank = (c: RepoCoord): Bank => { try { return JSON.parse(localStorage.getItem(bankKey(c)) ?? "{}") as Bank; } catch { return {}; } };
const writeBank = (c: RepoCoord, b: Bank): void => { try { localStorage.setItem(bankKey(c), JSON.stringify(b)); } catch { /* full */ } };
const today = (): string => new Date().toISOString().slice(0, 10);
export const bankScreentime = (c: RepoCoord, seconds: number): void => {
  const b = readBank(c); const d = today();
  b[d] = { s: (b[d]?.s ?? 0) + seconds, c: b[d]?.c ?? 0 };
  writeBank(c, b);
};
export const bankPin = (c: RepoCoord): void => {
  const b = readBank(c); const d = today();
  b[d] = { s: b[d]?.s ?? 0, c: (b[d]?.c ?? 0) + 1 };
  writeBank(c, b);
};
export const localScreentimeReport = (c: RepoCoord): ScreentimeReport => {
  const b = readBank(c);
  const days = Object.entries(b).sort(([a], [z]) => z.localeCompare(a)).slice(0, 7)
    .map(([date, v]) => ({ date, seconds: v.s, comments: v.c }));
  const d = today();
  const weekSeconds = days.reduce((n, x) => n + x.seconds, 0);
  const counted = days.filter((x) => x.seconds > 0).length || 1;
  return {
    todaySeconds: b[d]?.s ?? 0,
    weekSeconds,
    dailyAverageSeconds: Math.round(weekSeconds / counted),
    todayComments: b[d]?.c ?? 0,
    weekComments: days.reduce((n, x) => n + (x.comments ?? 0), 0),
    daysCounted: counted,
    days,
  };
};
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

function SignIn({ coord, authBase, accent, onDone, screentimeBase, localReport }: { coord: RepoCoord; authBase?: string; accent: string; onDone: () => void; screentimeBase?: string; localReport: () => ScreentimeReport }) {
  const [open, setOpen] = useState(false);
  const [tok, setTok] = useState("");
  const [patState, setPatState] = useState<"idle" | "checking" | "bad">("idle");
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
  const dark = usePrefersDark();
  const C = dark
    ? { fg: "#e9e9e9", dim: "#8d8d8d", border: "#5c5c5c", inset: "#2b2b2b", danger: "#e0645c", success: "#4fbf76" }
    : { fg: "#1a1a1a", dim: "#6b6b6b", border: "#d0d0d0", inset: "#f2f2f2", danger: "#c03528", success: "#2e9e5b" };
  const mono = { fontFamily: "ui-monospace, monospace" } as const;

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
    if (!authBase && authBase !== "") return;
    setFlow({ step: "starting" });
    let grant;
    try { grant = await requestDeviceCode(authBase); } catch {
      setFlow({ step: "failed", why: "The sign-in helper didn't answer — the token tab still works." });
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
      if (poll.status === "expired") { setFlow({ step: "failed", why: "The code expired — start again." }); return; }
      if (poll.status === "denied") { setFlow({ step: "failed", why: "GitHub reported the request was declined." }); return; }
    }
    setFlow({ step: "failed", why: "The code expired — start again." });
  };

  const savePatTok = async () => {
    const t = tok.trim();
    if (!t) return;
    setPatState("checking");
    const r = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${t}` } }).catch(() => null);
    if (!r?.ok) { setPatState("bad"); return; }
    setPatState("idle");
    await finish(t);
  };

  // THE REVIEW-TIME PANEL (dash, ported whole): signed in, the key opens what
  // your reviewing amounted to — time, pins, and the seven-day shape. With a
  // relay (`screentimeBase`) the ledger counts every device; without one it
  // is this browser's own bank, and it says so.
  const [report, setReport] = useState<ScreentimeReport | null>(null);
  useEffect(() => {
    if (!open || !authed) { setReport(null); return; }
    if (!screentimeBase) { setReport(localReport()); return; }
    const t = loadTok();
    void fetch(`${screentimeBase}/screentime?project=${encodeURIComponent(coord.repo)}`, { headers: t ? { authorization: `Bearer ${t}` } : undefined })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setReport(j ?? localReport()))
      .catch(() => setReport(localReport()));
  }, [open, authed, screentimeBase]);

  // two routes, two tabs (dash): the device code, or a classic token that
  // starts with a redirect and comes back to a password field
  const deviceAvailable = authBase !== undefined && authBase !== "" ? true : Boolean(authBase === "");
  const hasDevice = Boolean(authBase);
  const [tab, setTab] = useState<"code" | "token">(hasDevice ? "code" : "token");
  void deviceAvailable;
  const [copied, setCopied] = useState(false);
  const [tokenSent, setTokenSent] = useState(false);
  // the code arrives → put it on the clipboard FIRST, then let the button
  // open GitHub — the affirmation gates the link (dash)
  useEffect(() => {
    if (flow.step !== "code") { setCopied(false); return; }
    void navigator.clipboard?.writeText(flow.userCode).then(() => setCopied(true)).catch(() => setCopied(true));
  }, [flow.step, flow.step === "code" ? flow.userCode : ""]);

  const fmt = (secs: number): string => (secs >= 3600 ? `${Math.floor(secs / 3600)}h ${Math.round((secs % 3600) / 60)}m` : `${Math.round(secs / 60)}m`);

  return (
    <>
      <button onClick={() => setOpen((o) => !o)}
        title={authBad ? "GitHub sign-in expired — sign in again" : authed ? `Signed in${who ? ` as ${who}` : ""}` : "Sign in to review"}
        style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: "0 2px", display: "inline-flex", alignItems: "center", position: "relative" }}>
        {authed && !authBad && avatar
          ? <img src={avatar} alt={who ?? "signed in"} width={16} height={16} style={{ width: 16, height: 16, borderRadius: 999, objectFit: "cover", display: "block" }} />
          : <span style={{ opacity: authed && !authBad ? 0.55 : 1 }}>{authed && !authBad ? "🔓" : "🔑"}</span>}
        {authBad && <span style={{ position: "absolute", top: -2, right: -2, width: 7, height: 7, borderRadius: 999, background: "#e0483f" }} />}
      </button>
      <AttachedWindow open={open} onClose={() => setOpen(false)} width={300}>
        <div dir="ltr" style={{ textAlign: "left", color: C.fg }}>
          <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 2 }}>{authBad ? "Sign-in expired — sign in again" : authed ? `Signed in${who ? ` as ${who}` : ""}` : "Sign in to review"}</div>
          <div style={{ fontSize: 10, color: C.dim, ...mono, marginBottom: 10 }}>{coord.owner}/{coord.repo}</div>

          {authed && !authBad ? (
            <div data-screentime style={{ display: "grid", gap: 8 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                <b style={{ flex: 1, fontSize: 12.5 }}>your review time</b>
                <span style={{ fontSize: 10, color: C.dim, ...mono }}>{coord.repo}</span>
              </div>
              {!report ? (
                <span style={{ fontSize: 10.5, color: C.dim, ...mono }}>reading the ledger…</span>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 14, alignItems: "baseline", flexWrap: "wrap" }}>
                    {(((report.daysCounted ?? 1) > 1
                      ? [["today", report.todaySeconds], ["last 7 days", report.weekSeconds], [`daily average · ${report.daysCounted} days`, report.dailyAverageSeconds]]
                      : [["today", report.todaySeconds]]) as [string, number][]).map(([label, secs]) => (
                      <span key={label} style={{ display: "grid", gap: 1 }}>
                        <b style={{ fontSize: 15, ...mono }}>{fmt(secs)}</b>
                        <span style={{ fontSize: 9.5, color: C.dim, ...mono }}>{label}</span>
                      </span>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 14, alignItems: "baseline", flexWrap: "wrap" }}>
                    {(((report.daysCounted ?? 1) > 1
                      ? [["pins today", report.todayComments ?? 0], ["pins this week", report.weekComments ?? 0]]
                      : [["pins today", report.todayComments ?? 0]]) as [string, number][]).map(([label, n]) => (
                      <span key={label} style={{ display: "grid", gap: 1 }}>
                        <b style={{ fontSize: 15, ...mono }}>{n}</b>
                        <span style={{ fontSize: 9.5, color: C.dim, ...mono }}>{label}</span>
                      </span>
                    ))}
                  </div>
                  <div style={{ display: "grid", gap: 2 }}>
                    {report.days.slice(0, 7).map((d: { date: string; seconds: number }) => {
                      const max = Math.max(1, ...report.days.map((x: { seconds: number }) => x.seconds));
                      return (
                        <span key={d.date} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <span style={{ fontSize: 9.5, color: C.dim, width: 62, ...mono }}>{d.date.slice(5)}</span>
                          <span style={{ flex: 1, height: 6, borderRadius: 999, background: C.inset }}>
                            <span style={{ display: "block", height: 6, borderRadius: 999, width: `${Math.round((d.seconds / max) * 100)}%`, background: accent }} />
                          </span>
                          <span style={{ fontSize: 9.5, color: C.dim, ...mono }}>{Math.round(d.seconds / 60)}m</span>
                        </span>
                      );
                    })}
                    {report.days.length === 0 && (
                      <span style={{ fontSize: 10.5, color: C.dim, ...mono }}>no review time banked yet — it counts while you are actually reading</span>
                    )}
                  </div>
                  <span style={{ fontSize: 9.5, color: C.dim, ...mono }}>
                    {screentimeBase ? "counted across every device you review from" : "this browser only — point screentimeBase at a relay to count every device"}
                  </span>
                </>
              )}
            </div>
          ) : (
          <>
          {hasDevice && (
            <div style={{ display: "flex", gap: 4, marginBottom: 10, background: C.inset, borderRadius: 999, padding: 3 }}>
              {([["code", "device code"], ["token", "classic token"]] as const).map(([k, label]) => (
                <button key={k} onClick={() => setTab(k)}
                  style={{ flex: 1, border: "none", borderRadius: 999, padding: "5px 0", fontSize: 10.5, fontWeight: 800, cursor: "pointer",
                    background: tab === k ? accent : "transparent", color: tab === k ? "#fff" : C.dim }}>{label}</button>
              ))}
            </div>
          )}

          {hasDevice && tab === "code" && (
            <>
              {flow.step !== "code" && (
                <button onClick={() => void startDevice()} disabled={flow.step === "starting"}
                  style={{ display: "block", width: "100%", textAlign: "center", background: accent, color: "#fff", borderRadius: 8, padding: "7px 0", border: "none", cursor: "pointer", fontWeight: 700, fontSize: 11.5, marginBottom: 8 }}>
                  {flow.step === "starting" ? "Asking GitHub…" : "Get a code"}
                </button>
              )}
              {flow.step === "code" && (
                <div style={{ textAlign: "center", marginBottom: 8 }}>
                  <div style={{ fontSize: 10, color: C.dim, marginBottom: 4 }}>Enter this code on GitHub:</div>
                  <div style={{ ...mono, fontSize: 20, fontWeight: 800, letterSpacing: 2, marginBottom: 4, userSelect: "all" }}>{flow.userCode}</div>
                  <div style={{ fontSize: 9.5, color: copied ? C.success : C.dim, marginBottom: 6 }}>
                    {copied ? "copied to your clipboard — paste it on GitHub" : "copying…"}
                  </div>
                  {copied ? (
                    <a href={flow.verificationUri} target="_blank" rel="noreferrer"
                      style={{ display: "block", background: accent, color: "#fff", borderRadius: 8, padding: "6px 0", textDecoration: "none", fontWeight: 700, fontSize: 11.5 }}>
                      Open github.com/login/device ↗
                    </a>
                  ) : (
                    <span style={{ display: "block", background: C.border, color: C.dim, borderRadius: 8, padding: "6px 0", fontWeight: 700, fontSize: 11.5, cursor: "default" }}>
                      Open github.com/login/device ↗
                    </span>
                  )}
                  <div style={{ fontSize: 9.5, color: C.dim, marginTop: 5 }}>waiting for GitHub…</div>
                </div>
              )}
              {flow.step === "failed" && <div style={{ fontSize: 10, color: C.danger, marginBottom: 7, lineHeight: 1.5 }}>{flow.why}</div>}
            </>
          )}

          {(!hasDevice || tab === "token") && (
            <>
              {!tokenSent ? (
                <>
                  <a href={`https://github.com/settings/tokens/new?scopes=repo&description=${encodeURIComponent(`review ${coord.owner}/${coord.repo}`)}`}
                    target="_blank" rel="noreferrer" onClick={() => setTokenSent(true)}
                    style={{ display: "block", textAlign: "center", background: accent, color: "#fff", borderRadius: 8, padding: "7px 0", textDecoration: "none", fontWeight: 700, fontSize: 11.5 }}>
                    Create a token on GitHub ↗
                  </a>
                  <div style={{ fontSize: 9.5, color: C.dim, marginTop: 6, lineHeight: 1.5 }}>
                    scope <span style={mono}>repo</span> — come back here when you have it
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 10, color: C.dim, marginBottom: 5 }}>Paste the token you just created:</div>
                  <input dir="ltr" type="password" value={tok} onChange={(e) => { setTok(e.target.value); setPatState("idle"); }} placeholder="ghp_… / gho_…"
                    onKeyDown={(e) => { if (e.key === "Enter") void savePatTok(); }} autoComplete="off"
                    style={{ width: "100%", boxSizing: "border-box", fontSize: 11.5, padding: "7px 9px", borderRadius: 10, border: `1px solid ${patState === "bad" ? C.danger : C.border}`, background: C.inset, color: C.fg }} />
                  <button onClick={() => void savePatTok()} disabled={!tok.trim() || patState === "checking"}
                    style={{ display: "block", width: "100%", marginTop: 6, background: tok.trim() ? accent : C.inset, color: "#fff", border: "none", borderRadius: 8, padding: "7px 0", fontWeight: 800, fontSize: 11.5, cursor: tok.trim() ? "pointer" : "default" }}>
                    {patState === "checking" ? "checking…" : "save"}
                  </button>
                  {patState === "bad" && <div style={{ fontSize: 10, color: C.danger, marginTop: 4 }}>GitHub rejected that token — check it was copied whole.</div>}
                  <button onClick={() => setTokenSent(false)} style={{ border: "none", background: "transparent", color: C.dim, fontSize: 9.5, marginTop: 4, cursor: "pointer", padding: 0 }}>back</button>
                </>
              )}
            </>
          )}
          <div style={{ fontSize: 9.5, color: C.dim, marginTop: 6 }}>One sign-in covers every review surface on this site, in this browser.</div>
          </>
          )}
        </div>
      </AttachedWindow>
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
  /** 0.24.0 — a relay origin serving GET /screentime?project= (dash's
   *  contract): the review-time panel then counts every device. Absent ⇒
   *  the panel reads this browser's own bank. */
  screentimeBase?: string;
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
    // the crop target: the SHELL's own resolution of the anchor (carried on
    // the comment — a11y/fallback anchors included), else the attribute
    // lookup, else the whole viewport (page-level comments).
    const shots: import("./use-evidence.js").GatheredEvidence = await gatherEvidence(c.rect ?? rectForNode(c.node)).catch(() => ({}));
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
    bankPin(coord); // the report counts what reviewing PRODUCED, not only how long it took
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
      onActiveTime={(seconds) => { setActiveSec((t) => t + seconds); bankScreentime(coord, seconds); p.onActiveTime?.(seconds); }}
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
      accessory={<>{p.accessory}<SignIn coord={coord} authBase={p.authBase} accent={p.accent ?? "#A31621"} screentimeBase={p.screentimeBase} localReport={() => localScreentimeReport(coord)} onDone={() => bump((n) => n + 1)} /></>}
      sidebarFooter={p.sidebarFooter}
    />
  );
}
