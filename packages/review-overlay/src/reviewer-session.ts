/**
 * Reviewer session (0.6.0) — multi-person LCR review identity, browser side.
 *
 * In LCR mode each reviewer signs in as THEMSELVES via GitHub device flow so
 * their comments are attributed to their own account. The device dance's
 * token-exchange hops aren't CORS-open to a browser, so they go through the
 * box-hosted auth-helper (run-mock's reviewer-auth-server, env AUTH_BASE);
 * identity + comment posting use the per-reviewer token directly against the
 * CORS-OK api.github.com. Token + identity persist in localStorage per repo.
 *
 * Pure + injectable fetch — the React hook in ./react/use-reviewer-session.ts
 * is a thin wrapper over these.
 */
import type { DeviceCodeGrant, PollResult, ReviewerIdentity } from "@slowcook-ai/core";
import type { RepoCoord } from "./github.js";

const TOKEN_KEY_PREFIX = "slowcook.review-overlay.reviewer-token.";
const IDENTITY_KEY_PREFIX = "slowcook.review-overlay.reviewer-identity.";

const tokenKey = (r: RepoCoord) => `${TOKEN_KEY_PREFIX}${r.owner}/${r.repo}`;
const identityKey = (r: RepoCoord) => `${IDENTITY_KEY_PREFIX}${r.owner}/${r.repo}`;

export function loadReviewerToken(storage: Storage, repo: RepoCoord): string | null {
  return storage.getItem(tokenKey(repo));
}
export function saveReviewerToken(storage: Storage, repo: RepoCoord, token: string): void {
  storage.setItem(tokenKey(repo), token);
}
/** Identity plus the access tier we derive from repo permissions. `canApply`
 *  true → repo write access → comments get the `vibe` label (auto-applied);
 *  false → comments are held for the team (`community-review`). */
export type StoredReviewerIdentity = ReviewerIdentity & { canApply?: boolean };

export function loadReviewerIdentity(storage: Storage, repo: RepoCoord): StoredReviewerIdentity | null {
  const raw = storage.getItem(identityKey(repo));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as StoredReviewerIdentity;
    return typeof v?.login === "string" ? v : null;
  } catch {
    return null;
  }
}
export function saveReviewerIdentity(storage: Storage, repo: RepoCoord, id: StoredReviewerIdentity): void {
  storage.setItem(identityKey(repo), JSON.stringify(id));
}
export function clearReviewerSession(storage: Storage, repo: RepoCoord): void {
  storage.removeItem(tokenKey(repo));
  storage.removeItem(identityKey(repo));
}

/** Begin a device-flow login via the box auth-helper. */
export async function requestDeviceCode(authBase: string, f: typeof fetch = fetch): Promise<DeviceCodeGrant> {
  const res = await f(`${authBase.replace(/\/$/, "")}/__slowcook/auth/device`, { method: "POST" });
  if (!res.ok) throw new Error(`device code request failed: ${res.status}`);
  return (await res.json()) as DeviceCodeGrant;
}

/** Poll the box auth-helper once for the access token. */
export async function pollAccessToken(authBase: string, deviceCode: string, f: typeof fetch = fetch): Promise<PollResult> {
  const res = await f(`${authBase.replace(/\/$/, "")}/__slowcook/auth/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceCode }),
  });
  if (!res.ok) throw new Error(`token poll failed: ${res.status}`);
  return (await res.json()) as PollResult;
}

/** Resolve a reviewer token to identity (CORS-OK; runs in the browser). */
export async function identifyReviewer(token: string, f: typeof fetch = fetch): Promise<ReviewerIdentity> {
  const res = await f("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`identify failed: ${res.status}`);
  const j = (await res.json()) as { login: string; name: string | null; avatar_url?: string };
  return { login: j.login, name: j.name ?? j.login, avatarUrl: j.avatar_url };
}

/**
 * Does this reviewer have write access (push or higher) to the repo? Drives the
 * apply tier: GET /repos/{owner}/{repo} returns `permissions` for the
 * authenticated user. `push` (write), `maintain`, or `admin` → can apply.
 * Anything else (read/none), or any error, → held for the team (fail closed).
 */
export async function checkRepoWriteAccess(token: string, repo: RepoCoord, f: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await f(`https://api.github.com/repos/${repo.owner}/${repo.repo}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) return false;
    const j = (await res.json()) as { permissions?: { push?: boolean; maintain?: boolean; admin?: boolean } };
    const p = j.permissions ?? {};
    return !!(p.push || p.maintain || p.admin);
  } catch {
    return false; // fail closed — unknown access never auto-applies
  }
}

export type LoginEvent =
  | { type: "code"; grant: DeviceCodeGrant }
  | { type: "authorized"; token: string }
  | { type: "denied" }
  | { type: "expired" }
  | { type: "error"; message: string };

export interface LoginDriverOptions {
  authBase: string;
  /** Called with the user-code grant to show the reviewer, then on terminal events. */
  onEvent: (e: LoginEvent) => void;
  /** Abort polling (e.g. the reviewer closed the dialog). */
  shouldStop?: () => boolean;
  /** Injected sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

/**
 * Run the full device-flow login: request a code, surface it via onEvent, then
 * poll until authorized / denied / expired. Returns the token on success, null
 * otherwise. Honors slow_down (backs off) and shouldStop (reviewer cancelled).
 */
export async function runDeviceLogin(opts: LoginDriverOptions): Promise<string | null> {
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let grant: DeviceCodeGrant;
  try {
    grant = await requestDeviceCode(opts.authBase, f);
  } catch (e) {
    opts.onEvent({ type: "error", message: e instanceof Error ? e.message : String(e) });
    return null;
  }
  opts.onEvent({ type: "code", grant });
  let interval = grant.intervalSeconds;
  const deadline = Date.now() + grant.expiresInSeconds * 1000;
  // NOTE: Date.now() here is runtime-only (browser), not in a workflow script.
  while (Date.now() < deadline) {
    if (opts.shouldStop?.()) return null;
    await sleep(interval * 1000);
    let result: PollResult;
    try {
      result = await pollAccessToken(opts.authBase, grant.deviceCode, f);
    } catch (e) {
      opts.onEvent({ type: "error", message: e instanceof Error ? e.message : String(e) });
      return null;
    }
    switch (result.status) {
      case "authorized":
        opts.onEvent({ type: "authorized", token: result.token });
        return result.token;
      case "pending":
        break;
      case "slow_down":
        interval = result.intervalSeconds;
        break;
      case "denied":
        opts.onEvent({ type: "denied" });
        return null;
      case "expired":
        opts.onEvent({ type: "expired" });
        return null;
    }
  }
  opts.onEvent({ type: "expired" });
  return null;
}
