/**
 * GitHub API submit + PAT storage — 0.16.0-α.6.
 *
 * The overlay POSTs review comments directly from the browser using a
 * PAT stored in localStorage. Mode A in the 0.13.1-overlay design;
 * Mode B (consumer's own submit endpoint) deferred to a follow-up.
 *
 * Storage key is keyed by the {owner}/{repo} pair so the same browser
 * can hold multiple consumers' tokens without collision.
 *
 * 0.3.0 — also reads PR comments to render Figma-style anchored pins
 * for previously-left feedback. Cached in localStorage so the pin
 * layer renders instantly on refresh.
 */
import {
  parseReviewComment,
  parsePlateReply,
  type ReviewCommentPayload,
  type PlateReplyEntry,
} from "./comment-format.js";

const PAT_STORAGE_KEY_PREFIX = "slowcook.review-overlay.pat.";

export interface RepoCoord {
  owner: string;
  repo: string;
}

export function patStorageKey(repo: RepoCoord): string {
  return `${PAT_STORAGE_KEY_PREFIX}${repo.owner}/${repo.repo}`;
}

export function loadPat(storage: Storage, repo: RepoCoord): string | null {
  return storage.getItem(patStorageKey(repo));
}

export function savePat(storage: Storage, repo: RepoCoord, pat: string): void {
  storage.setItem(patStorageKey(repo), pat);
}

export function clearPat(storage: Storage, repo: RepoCoord): void {
  storage.removeItem(patStorageKey(repo));
}

export interface SubmitArgs extends RepoCoord {
  pr: number;
  pat: string;
  body: string;
  /** Override the API base; default https://api.github.com */
  apiBase?: string;
  /** Inject fetch — defaults to globalThis.fetch. Useful for tests. */
  fetchImpl?: typeof fetch;
}

export interface SubmitOk {
  ok: true;
  commentId: number;
  htmlUrl: string;
}

export interface SubmitErr {
  ok: false;
  status: number;
  message: string;
}

export type SubmitResult = SubmitOk | SubmitErr;

/**
 * 0.3.0 — A single overlay comment paired with plate's reply (when one
 * exists). The overlay's pin layer renders one of these per comment.
 */
export interface OverlayCommentRecord {
  /** GitHub comment id (numeric). */
  commentId: number;
  /** PR-comment author + ISO timestamp + comment body URL on GitHub. */
  author: string;
  createdAt: string;
  htmlUrl: string;
  /** Parsed structured payload from the review-overlay marker block. */
  payload: ReviewCommentPayload;
  /**
   * Plate's reply for this comment (parsed from a `slowcook:plate-reply`
   * block on a comment posted after the overlay one). Null when plate
   * hasn't acted yet OR when the run pre-dates the breadcrumb (0.3.0+).
   */
  plateReply: PlateReplyEntry | null;
  /** GitHub comment URL of the plate reply (when plateReply is set). */
  plateCommentUrl?: string;
}

interface FetchArgs extends RepoCoord {
  pr: number;
  pat: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Fetch all overlay comments + correlated plate replies for a PR.
 * Returns one record per overlay comment in oldest-first order.
 */
export async function fetchOverlayComments(args: FetchArgs): Promise<OverlayCommentRecord[]> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  const apiBase = args.apiBase ?? "https://api.github.com";
  const url = `${apiBase}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/issues/${args.pr}/comments?per_page=100`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${args.pat}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const all = (await res.json()) as Array<{
    id: number;
    user: { login: string };
    body: string;
    created_at: string;
    html_url: string;
  }>;

  const overlayRecords: OverlayCommentRecord[] = [];
  // Plate-reply entries indexed by `to_comment_id` for O(1) lookup later.
  const plateRepliesByCommentId = new Map<number, { entry: PlateReplyEntry; htmlUrl: string }>();

  for (const c of all) {
    const overlayPayload = parseReviewComment(c.body);
    if (overlayPayload) {
      overlayRecords.push({
        commentId: c.id,
        author: c.user.login,
        createdAt: c.created_at,
        htmlUrl: c.html_url,
        payload: overlayPayload,
        plateReply: null,
      });
    }
    const plateReply = parsePlateReply(c.body);
    if (plateReply) {
      for (const r of plateReply.replies) {
        plateRepliesByCommentId.set(r.to_comment_id, { entry: r, htmlUrl: c.html_url });
      }
    }
  }

  // Correlate by comment id (no heuristic; plate's breadcrumb names it).
  for (const rec of overlayRecords) {
    const reply = plateRepliesByCommentId.get(rec.commentId);
    if (reply) {
      rec.plateReply = reply.entry;
      rec.plateCommentUrl = reply.htmlUrl;
    }
  }

  return overlayRecords;
}

/**
 * 0.6.4 — LCR mode retrieval. In lcr mode a comment IS a `lcr-review` issue
 * (not a PR comment), so the pin layer + comments list must read the repo's
 * issues, not a PR's comments. Lists `lcr-review` issues (open + closed),
 * decodes each one's hidden payload, and maps the issue STATE onto the
 * reply-status the list-panel filter understands: a CLOSED issue is treated as
 * resolved/applied (hidden behind "show already-applied"); an OPEN one shows.
 * A `needs-clarification` label keeps it visible (status stays unresolved).
 *
 * Requires a token with read access (the signed-in reviewer's token; the repo
 * is typically private). Returns [] on any error so the overlay degrades to its
 * cached state.
 */
export interface FetchLcrArgs extends RepoCoord {
  token: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}
export async function fetchLcrIssues(args: FetchLcrArgs): Promise<OverlayCommentRecord[]> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  const apiBase = args.apiBase ?? "https://api.github.com";
  const url = `${apiBase}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/issues?labels=lcr-review&state=all&per_page=100`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${args.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const issues = (await res.json()) as Array<{
    number: number;
    user: { login: string } | null;
    body: string | null;
    created_at: string;
    html_url: string;
    state: "open" | "closed";
    labels: Array<{ name: string }>;
    comments: number;
    comments_url: string;
    pull_request?: unknown;
  }>;
  const headers = {
    Authorization: `Bearer ${args.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const out: OverlayCommentRecord[] = [];
  for (const it of issues) {
    if (it.pull_request) continue; // the /issues endpoint also returns PRs
    const payload = parseReviewComment(it.body ?? "");
    if (!payload) continue;
    const needsClarification = it.labels?.some((l) => l.name === "needs-clarification");
    const resolved = it.state === "closed" && !needsClarification;
    // closed → applied (hidden behind the toggle); open → needs-clarification
    // (always visible — it still wants the reviewer's attention).
    const status: PlateReplyEntry["status"] = resolved ? "applied" : "needs-clarification";

    // 0.6.7 — pull the latest reply so the answer shows IN the overlay (pin
    // popover + list), not only on GitHub. Maintainer/fixer comments are the
    // reply channel; the issue body is the original note.
    let reply: { body: string; htmlUrl: string } | null = null;
    if (it.comments > 0) {
      try {
        const cres = await fetchImpl(`${it.comments_url}?per_page=100`, { headers });
        if (cres.ok) {
          const cs = (await cres.json()) as Array<{ body: string | null; html_url: string }>;
          const last = cs[cs.length - 1];
          if (last?.body) reply = { body: cleanReplyBody(last.body), htmlUrl: last.html_url };
        }
      } catch { /* keep going without a reply */ }
    }

    const plateReply: PlateReplyEntry | null =
      reply ? { to_comment_id: it.number, status, summary: reply.body }
      : resolved ? { to_comment_id: it.number, status: "applied", summary: "Resolved — issue closed." }
      : needsClarification ? { to_comment_id: it.number, status: "needs-clarification", summary: "Awaiting your clarification." }
      : null;

    out.push({
      commentId: it.number,
      author: it.user?.login ?? "unknown",
      createdAt: it.created_at,
      htmlUrl: it.html_url,
      payload,
      plateReply,
      plateCommentUrl: reply?.htmlUrl,
    });
  }
  return out;
}

/** Strip hidden payload/plate markers + trim a reply body for the overlay. */
function cleanReplyBody(body: string): string {
  const cut = (body.split("<!--")[0] ?? "").trim();
  return cut.length > 500 ? cut.slice(0, 500) + "…" : cut;
}

/**
 * localStorage cache for the comment list — lets the pin layer render
 * instantly on refresh without waiting for the network round-trip.
 * Background-refresh fires after, updating with any newer state.
 */
const COMMENTS_CACHE_KEY_PREFIX = "slowcook.review-overlay.comments.";

export function commentsCacheKey(repo: RepoCoord, pr: number): string {
  return `${COMMENTS_CACHE_KEY_PREFIX}${repo.owner}/${repo.repo}/${pr}`;
}

export function loadCachedComments(storage: Storage, repo: RepoCoord, pr: number): OverlayCommentRecord[] | null {
  const raw = storage.getItem(commentsCacheKey(repo, pr));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed as OverlayCommentRecord[];
  } catch {
    return null;
  }
}

export function saveCachedComments(storage: Storage, repo: RepoCoord, pr: number, records: OverlayCommentRecord[]): void {
  try {
    storage.setItem(commentsCacheKey(repo, pr), JSON.stringify(records));
  } catch {
    /* ignore quota / private-mode errors */
  }
}

/**
 * 0.4.0 — per-scenario comment stats. The scenarios picker renders one
 * badge cluster per card: total / applied / unresolved / spec-altering
 * / declined / noop. Aggregated across every open + closed mockup PR
 * in the repo, grouped by story_id from each overlay comment's payload.
 */
export interface ScenarioCommentStats {
  total: number;
  unresolved: number;
  applied: number;
  declined: number;
  specAltering: number;
  noop: number;
  /**
   * 0.4.2 — true when the corresponding mockup PR carries the
   * `slowcook-mockup-approved` label. The picker renders approved
   * scenarios with distinct visual treatment (green border + ✓
   * Approved badge); plate refuses to amend after the label lands.
   */
  approved?: boolean;
}

export const APPROVED_LABEL = "slowcook-mockup-approved";

export function emptyStats(): ScenarioCommentStats {
  return { total: 0, unresolved: 0, applied: 0, declined: 0, specAltering: 0, noop: 0, approved: false };
}

interface FetchPrsArgs extends RepoCoord {
  pat: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

/**
 * List every PR (open + closed) on the repo that carries the
 * `slowcook-mockup` label. Each result includes the PR number, the
 * derived storyId from the branch name (`slowcook/mockup/story-N`),
 * and the comments-list URL for paginated comment fetch.
 */
export async function fetchAllMockupPrs(args: FetchPrsArgs): Promise<Array<{ pr: number; storyId: string; labels: string[] }>> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  const apiBase = args.apiBase ?? "https://api.github.com";
  const url = `${apiBase}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/issues?labels=slowcook-mockup&state=all&per_page=100`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${args.pat}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const issues = (await res.json()) as Array<{
    number: number;
    pull_request?: { url?: string };
    title?: string;
    labels?: Array<{ name: string }>;
  }>;
  const out: Array<{ pr: number; storyId: string; labels: string[] }> = [];
  for (const issue of issues) {
    if (!issue.pull_request) continue;
    const titleMatch = (issue.title ?? "").match(/story-([\w-]+)/);
    if (!titleMatch || !titleMatch[1]) continue;
    out.push({
      pr: issue.number,
      storyId: titleMatch[1],
      labels: (issue.labels ?? []).map((l) => l.name),
    });
  }
  return out;
}

/**
 * Aggregate per-scenario comment stats by walking every mockup PR's
 * comments + grouping by overlay-payload.story_id. Plate's breadcrumb
 * provides the status (applied / declined / spec-altering / noop);
 * absent breadcrumb counts as unresolved.
 *
 * One round-trip per PR + 1 for the listing. For most consumers the
 * total is <20 PRs; in-flight Promise.all keeps the wall-clock fast.
 */
export async function fetchScenarioStats(args: FetchPrsArgs): Promise<Record<string, ScenarioCommentStats>> {
  const prs = await fetchAllMockupPrs(args);
  if (prs.length === 0) return {};
  const allRecords = await Promise.all(
    prs.map((p) => fetchOverlayComments({ ...args, pr: p.pr }).catch(() => []))
  );
  const stats: Record<string, ScenarioCommentStats> = {};
  for (let i = 0; i < prs.length; i++) {
    const { storyId, labels } = prs[i]!;
    const records = allRecords[i]!;
    if (!stats[storyId]) stats[storyId] = emptyStats();
    // Approval state from the PR's labels — sticky-OR across multiple
    // PRs for the same story (rare, but a re-opened mockup-2 PR could
    // exist alongside an approved mockup-1).
    if (labels.includes(APPROVED_LABEL)) {
      stats[storyId]!.approved = true;
    }
    for (const rec of records) {
      const targetId = rec.payload.story_id ?? storyId;
      if (!stats[targetId]) stats[targetId] = emptyStats();
      const target = stats[targetId];
      target.total += 1;
      const status = rec.plateReply?.status;
      switch (status) {
        case "applied":       target.applied += 1; break;
        case "declined":      target.declined += 1; break;
        case "spec-altering": target.specAltering += 1; break;
        case "noop":          target.noop += 1; break;
        default:              target.unresolved += 1; break;
      }
    }
  }
  return stats;
}

const SCENARIO_STATS_CACHE_KEY_PREFIX = "slowcook.review-overlay.scenario-stats.";

export function scenarioStatsCacheKey(repo: RepoCoord): string {
  return `${SCENARIO_STATS_CACHE_KEY_PREFIX}${repo.owner}/${repo.repo}`;
}

export function loadCachedScenarioStats(storage: Storage, repo: RepoCoord): Record<string, ScenarioCommentStats> | null {
  const raw = storage.getItem(scenarioStatsCacheKey(repo));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, ScenarioCommentStats>;
  } catch {
    return null;
  }
}

export function saveCachedScenarioStats(storage: Storage, repo: RepoCoord, stats: Record<string, ScenarioCommentStats>): void {
  try {
    storage.setItem(scenarioStatsCacheKey(repo), JSON.stringify(stats));
  } catch {
    /* ignore quota errors */
  }
}

/**
 * POST a comment to the given PR. Returns a tagged result rather than
 * throwing so the React layer can render specific UI per failure mode.
 */
/**
 * 0.4.2 — POST a label add to a PR. Used by the approve flow so the
 * `slowcook-mockup-approved` label actually lands (the comment alone
 * was advisory). Returns true on success.
 */
export async function addLabelsToPr(args: {
  owner: string;
  repo: string;
  pr: number;
  pat: string;
  labels: string[];
  apiBase?: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  const apiBase = args.apiBase ?? "https://api.github.com";
  const url = `${apiBase}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/issues/${args.pr}/labels`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.pat}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ labels: args.labels }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 0.5.2 — submit a PR review with `event: "APPROVE"`. Used by the
 * approve flow alongside the label add + comment so the PR shows
 * a real green ✓ approval in GitHub's PR header.
 *
 * Note: GitHub forbids self-approving by default ("Pull request
 * reviews cannot be requested from pull request authors"). On
 * single-author repos / dogfood repos this works because the PAT
 * holder approves a bot-authored PR. Returns false on the
 * self-approval rejection so the overlay degrades gracefully.
 */
export async function submitPrApproval(args: {
  owner: string;
  repo: string;
  pr: number;
  pat: string;
  body?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; status?: number; message?: string }> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  const apiBase = args.apiBase ?? "https://api.github.com";
  const url = `${apiBase}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/pulls/${args.pr}/reviews`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.pat}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        event: "APPROVE",
        body: args.body ?? "Mockup approved via slowcook review overlay.",
      }),
    });
    if (res.ok) return { ok: true };
    let detail = "";
    try {
      const j = (await res.json()) as { message?: string };
      detail = j.message ?? "";
    } catch { /* non-json */ }
    return { ok: false, status: res.status, message: detail || res.statusText };
  } catch (e) {
    return { ok: false, status: 0, message: `network error: ${(e as Error).message}` };
  }
}

/**
 * 0.4.2 — fetch the labels currently on a PR. Used by the overlay to
 * detect approval state on mount + by the scenario-stats aggregator.
 */
export async function fetchPrLabels(args: {
  owner: string;
  repo: string;
  pr: number;
  pat: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  const apiBase = args.apiBase ?? "https://api.github.com";
  const url = `${apiBase}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/issues/${args.pr}/labels?per_page=100`;
  try {
    const res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${args.pat}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return [];
    const arr = (await res.json()) as Array<{ name: string }>;
    return arr.map((l) => l.name);
  } catch {
    return [];
  }
}

export async function submitComment(args: SubmitArgs): Promise<SubmitResult> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  const apiBase = args.apiBase ?? "https://api.github.com";
  const url = `${apiBase}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/issues/${args.pr}/comments`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.pat}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ body: args.body }),
    });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      message: `network error: ${(e as Error).message}`,
    };
  }
  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { message?: string };
      detail = j.message ?? "";
    } catch {
      // body wasn't JSON — keep detail empty
    }
    return {
      ok: false,
      status: res.status,
      message: detail || res.statusText,
    };
  }
  const j = (await res.json()) as { id: number; html_url: string };
  return { ok: true, commentId: j.id, htmlUrl: j.html_url };
}

export interface CreateIssueArgs extends RepoCoord {
  pat: string;
  title: string;
  body: string;
  labels?: string[];
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

/**
 * 0.6.0 — open a standalone issue (LCR review). Distinct from submitComment
 * (which comments on a PR): an LCR review note is about a story/route of the
 * living spec, so it becomes its own `vibe`-labelled issue. Returns the same
 * SubmitResult shape (commentId = issue number).
 */
export async function createIssue(args: CreateIssueArgs): Promise<SubmitResult> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  const apiBase = args.apiBase ?? "https://api.github.com";
  const url = `${apiBase}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/issues`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.pat}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ title: args.title, body: args.body, labels: args.labels ?? [] }),
    });
  } catch (e) {
    return { ok: false, status: 0, message: `network error: ${(e as Error).message}` };
  }
  if (!res.ok) {
    let detail = "";
    try {
      const j = (await res.json()) as { message?: string };
      detail = j.message ?? "";
    } catch { /* non-JSON body */ }
    return { ok: false, status: res.status, message: detail || res.statusText };
  }
  const j = (await res.json()) as { number: number; html_url: string };
  return { ok: true, commentId: j.number, htmlUrl: j.html_url };
}

// ── Docs studio (0.7.0) — the textual half of review. Read + commit the spine
//    markdown docs on the working branch via the GitHub Contents API, so a
//    scope-change edit lands as a real commit that `refine` picks up. ──────────

/** UTF-8-safe base64 (the docs carry emoji/unicode). */
function b64decodeUtf8(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function b64encodeUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export interface DocFile { path: string; content: string; sha: string }

/** Read one markdown doc at a ref (branch). `pat` optional for public repos. */
export async function fetchDocFile(args: RepoCoord & {
  path: string; ref: string; pat?: string; apiBase?: string; fetchImpl?: typeof fetch;
}): Promise<{ ok: true; file: DocFile } | { ok: false; status: number; message: string }> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  const apiBase = args.apiBase ?? "https://api.github.com";
  const url = `${apiBase}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/contents/${args.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(args.ref)}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: {
        ...(args.pat ? { Authorization: `Bearer ${args.pat}` } : {}),
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch (e) {
    return { ok: false, status: 0, message: `network error: ${(e as Error).message}` };
  }
  if (!res.ok) {
    let detail = "";
    try { detail = ((await res.json()) as { message?: string }).message ?? ""; } catch { /* */ }
    return { ok: false, status: res.status, message: detail || res.statusText };
  }
  const j = (await res.json()) as { content?: string; sha: string; encoding?: string };
  const content = j.content && j.encoding === "base64" ? b64decodeUtf8(j.content) : (j.content ?? "");
  return { ok: true, file: { path: args.path, content, sha: j.sha } };
}

/** Commit an edited doc to a branch (the "scope change"). Requires write access. */
export async function commitDocFile(args: RepoCoord & {
  path: string; content: string; sha: string; branch: string; message: string;
  pat: string; apiBase?: string; fetchImpl?: typeof fetch;
}): Promise<{ ok: true; htmlUrl?: string; commit?: string } | { ok: false; status: number; message: string }> {
  const fetchImpl = args.fetchImpl ?? globalThis.fetch;
  const apiBase = args.apiBase ?? "https://api.github.com";
  const url = `${apiBase}/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/contents/${args.path.split("/").map(encodeURIComponent).join("/")}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${args.pat}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        message: args.message,
        content: b64encodeUtf8(args.content),
        sha: args.sha,
        branch: args.branch,
      }),
    });
  } catch (e) {
    return { ok: false, status: 0, message: `network error: ${(e as Error).message}` };
  }
  if (!res.ok) {
    let detail = "";
    try { detail = ((await res.json()) as { message?: string }).message ?? ""; } catch { /* */ }
    return { ok: false, status: res.status, message: detail || res.statusText };
  }
  const j = (await res.json()) as { commit?: { html_url?: string; sha?: string } };
  return { ok: true, htmlUrl: j.commit?.html_url, commit: j.commit?.sha };
}
