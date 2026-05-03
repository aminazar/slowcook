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
 * POST a comment to the given PR. Returns a tagged result rather than
 * throwing so the React layer can render specific UI per failure mode.
 */
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
