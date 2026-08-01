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
import { useEffect, useState, type ReactNode } from "react";
import { renderEvidenceMarkdown } from "../comment-format.js";
import { uploadReviewAsset } from "../github.js";
import { useReviewEvidence, rectForNode, type EvidenceConfig } from "./use-evidence.js";
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

export function buildIssueBody(c: ReviewComment, surface: string, extra?: { evidenceMd?: string[]; screenshotDataUrl?: string; screenshotUrl?: string }): string {
  const lines = [
    `**Review note (${surface})**`, "",
    `**Node:** \`${c.node}\``, `**Card:** ${c.label}`, "",
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
  const text = (quoted.split(/\n\n(?:!\[screenshot\]|📸 \[screenshot|<details><summary>evidence|_Filed)/)[0] ?? i.title).replace(/\n> /g, "\n");
  return {
    id: `gh-${i.number}`, node, label, text: text.trim(),
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

function SignIn({ coord, authBase, onDone }: { coord: RepoCoord; authBase?: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
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
      <button onClick={() => setOpen((o) => !o)}
        title={authBad ? "GitHub sign-in expired — sign in again" : authed ? `Signed in${who ? ` as ${who}` : ""}` : "Sign in to review"}
        style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: "0 2px", display: "inline-flex", alignItems: "center", position: "relative" }}>
        {/* signed in → YOUR avatar, sized to the pill (16px, round) — the
            lock only while signed out or expired */}
        {authed && !authBad && avatar
          ? <img src={avatar} alt={who ?? "signed in"} width={16} height={16} style={{ width: 16, height: 16, borderRadius: 999, objectFit: "cover", display: "block" }} />
          : <span style={{ opacity: authed && !authBad ? 0.55 : 1 }}>{authed && !authBad ? "🔓" : "🔑"}</span>}
        {authBad && <span style={{ position: "absolute", top: -2, right: -2, width: 7, height: 7, borderRadius: 999, background: "#e0483f" }} />}
      </button>
      {open && (
        <div style={{ position: "fixed", right: 16, bottom: 64, width: 300, background: "#1f1f1f", color: "#e9e9e9", border: "1px solid #5c5c5c", borderRadius: 12, padding: 12, zIndex: 2147483200, fontFamily: "system-ui, sans-serif", boxShadow: "0 14px 44px rgba(0,0,0,.5)" }}>
          <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 2 }}>{authBad ? "Sign-in expired — sign in again" : authed ? `Signed in${who ? ` as ${who}` : ""}` : "Sign in to review"}</div>
          <div style={{ fontSize: 10, color: "#8d8d8d", ...mono, marginBottom: 10 }}>{coord.owner}/{coord.repo}</div>
          {authBase && flow.step !== "code" && (
            <button onClick={() => void startDevice()} disabled={flow.step === "starting"}
              style={{ display: "block", width: "100%", textAlign: "center", background: "#e9e9e9", color: "#1a1a1a", borderRadius: 8, padding: "7px 0", border: "none", cursor: "pointer", fontWeight: 700, fontSize: 11.5, marginBottom: 8 }}>
              {flow.step === "starting" ? "Asking GitHub…" : "Sign in with GitHub"}
            </button>
          )}
          {flow.step === "code" && (
            <div style={{ textAlign: "center", marginBottom: 8 }}>
              <div style={{ fontSize: 10, color: "#8d8d8d", marginBottom: 4 }}>Enter this code on GitHub:</div>
              <div style={{ ...mono, fontSize: 20, fontWeight: 800, letterSpacing: 2, marginBottom: 6, userSelect: "all" }}>{flow.userCode}</div>
              <a href={flow.verificationUri} target="_blank" rel="noreferrer"
                style={{ display: "block", background: "#e9e9e9", color: "#1a1a1a", borderRadius: 8, padding: "6px 0", textDecoration: "none", fontWeight: 700, fontSize: 11.5 }}>
                Open github.com/login/device ↗
              </a>
              <div style={{ fontSize: 9.5, color: "#8d8d8d", marginTop: 5 }}>waiting for GitHub…</div>
            </div>
          )}
          {flow.step === "failed" && <div style={{ fontSize: 10, color: "#c66", marginBottom: 7 }}>{flow.why}</div>}
          <details open={!authBase}>
            <summary style={{ fontSize: 9.5, color: "#8d8d8d", cursor: "pointer" }}>paste a token instead</summary>
            <a href={tokenUrl} target="_blank" rel="noreferrer" style={{ display: "block", fontSize: 10.5, color: "#e9e9e9", margin: "6px 0" }}>① Create a token on GitHub ↗ (pre-filled, repo scope)</a>
            <input type="password" value={tok} onChange={(e) => setTok(e.target.value)} placeholder="② paste ghp_… / gho_…"
              onKeyDown={(e) => { if (e.key === "Enter") void savePatTok(); }} autoComplete="off"
              style={{ width: "100%", boxSizing: "border-box", fontSize: 11.5, padding: "6px 9px", borderRadius: 10, border: "1px solid #555", background: "#2b2b2b", color: "#e9e9e9" }} />
          </details>
          <div style={{ fontSize: 9.5, color: "#8d8d8d", marginTop: 6 }}>One sign-in covers every review surface on this site, in this browser.</div>
        </div>
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
}

export function GitHubIssueReview(p: GitHubIssueReviewProps) {
  const coord: RepoCoord = { owner: p.owner, repo: p.repo };
  const { gh, loadTok } = makeGh(coord);
  const [meta, setMeta] = useState<Record<string, ReviewCommentMeta>>({});
  const [, bump] = useState(0);
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
        body: buildIssueBody(c, surface, { evidenceMd, screenshotDataUrl: shots.screenshotDataUrl, screenshotUrl: shots.screenshotUrl }),
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

  const onReply = async (c: ReviewComment, text: string) => {
    if (typeof c.remoteId !== "number" || !loadTok()) return;
    await gh(`/repos/${p.owner}/${p.repo}/issues/${c.remoteId}/comments`, {
      method: "POST", body: JSON.stringify({ body: text }),
    }).catch(() => { /* optimistic copy stays; hydration reconciles */ });
  };

  const hydrate = async (): Promise<ReviewComment[] | null> => {
    if (!loadTok()) return null;
    const r = await gh(`/repos/${p.owner}/${p.repo}/issues?labels=${encodeURIComponent(scopeLabel)}&state=all&per_page=100`).catch(() => null);
    if (!r?.ok) return null;
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
      toggleLabels={["Read", "Comment"]}
      corner={p.corner ?? "bottom-left"}
      accent={p.accent ?? "#A31621"}
      icon={p.icon}
      author={p.author ?? "Reviewer"}
      store={localStorageStore(p.storageKey ?? `${p.owner}/${p.repo}:issue-review`)}
      onComment={onComment}
      onReply={onReply}
      hydrate={hydrate}
      hydrateKey={p.hydrateKey}
      meta={meta}
      accessory={<>{p.accessory}<SignIn coord={coord} authBase={p.authBase} onDone={() => bump((n) => n + 1)} /></>}
      sidebarFooter={p.sidebarFooter}
    />
  );
}
