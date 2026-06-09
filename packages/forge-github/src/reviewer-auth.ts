/**
 * GitHub reviewer-identity via OAuth device flow (0.6.0).
 *
 * Implements core's `ForgeReviewerAuth` so a hosted LCR can let each reviewer
 * sign in as THEMSELVES — their comments are then attributed to their own
 * GitHub account, not a shared host token. See core/forge.ts for the seam + why
 * the token-exchange must run server-side (GitHub's token endpoints aren't
 * CORS-open to browsers; only `api.github.com` reads/writes with a user token
 * are). The cli/overlay host `requestDeviceCode` + `pollAccessToken` next to the
 * mock; the browser uses the resulting token directly.
 *
 * Needs a GitHub OAuth App **Client ID** with Device Flow enabled. No client
 * secret is used (device flow is a public-client grant).
 */
import type {
  ForgeReviewerAuth,
  DeviceCodeGrant,
  PollResult,
  ReviewerIdentity,
} from "@slowcook-ai/core";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface GitHubReviewerAuthOptions {
  /** OAuth App Client ID (Device Flow enabled). */
  clientId: string;
  /**
   * OAuth scope to request. `public_repo` lets reviewers comment on public
   * repos; private repos need `repo`. Default `public_repo`.
   */
  scope?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class GitHubReviewerAuth implements ForgeReviewerAuth {
  private readonly clientId: string;
  private readonly scope: string;
  private readonly f: typeof fetch;

  constructor(opts: GitHubReviewerAuthOptions) {
    if (!opts.clientId) throw new Error("GitHubReviewerAuth: clientId is required");
    this.clientId = opts.clientId;
    this.scope = opts.scope ?? "public_repo";
    this.f = opts.fetchImpl ?? fetch;
  }

  async requestDeviceCode(): Promise<DeviceCodeGrant> {
    const res = await this.f(DEVICE_CODE_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: this.clientId, scope: this.scope }),
    });
    if (!res.ok) throw new Error(`device code request failed: ${res.status}`);
    const j = (await res.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    };
    return {
      deviceCode: j.device_code,
      userCode: j.user_code,
      verificationUri: j.verification_uri,
      intervalSeconds: j.interval,
      expiresInSeconds: j.expires_in,
    };
  }

  async pollAccessToken(deviceCode: string): Promise<PollResult> {
    const res = await this.f(TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.clientId,
        device_code: deviceCode,
        grant_type: DEVICE_GRANT,
      }),
    });
    if (!res.ok) throw new Error(`token poll failed: ${res.status}`);
    const j = (await res.json()) as {
      access_token?: string;
      error?: string;
      interval?: number;
    };
    if (j.access_token) return { status: "authorized", token: j.access_token };
    switch (j.error) {
      case "authorization_pending":
        return { status: "pending" };
      case "slow_down":
        return { status: "slow_down", intervalSeconds: j.interval ?? 5 };
      case "expired_token":
        return { status: "expired" };
      case "access_denied":
        return { status: "denied" };
      default:
        throw new Error(`unexpected device-flow error: ${j.error ?? "unknown"}`);
    }
  }

  async identify(token: string): Promise<ReviewerIdentity> {
    const res = await this.f(USER_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) throw new Error(`identify failed: ${res.status}`);
    const j = (await res.json()) as { login: string; name: string | null; avatar_url?: string };
    return {
      login: j.login,
      name: j.name ?? j.login,
      avatarUrl: j.avatar_url,
    };
  }
}
