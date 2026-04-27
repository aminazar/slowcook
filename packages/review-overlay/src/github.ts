/**
 * GitHub API submit + PAT storage — 0.16.0-α.6.
 *
 * The overlay POSTs review comments directly from the browser using a
 * PAT stored in localStorage. Mode A in the 0.13.1-overlay design;
 * Mode B (consumer's own submit endpoint) deferred to a follow-up.
 *
 * Storage key is keyed by the {owner}/{repo} pair so the same browser
 * can hold multiple consumers' tokens without collision.
 */

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
