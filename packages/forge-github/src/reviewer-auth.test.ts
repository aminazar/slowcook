import { describe, it, expect } from "vitest";
import { GitHubReviewerAuth, SLOWCOOK_REVIEW_OAUTH_CLIENT_ID } from "./reviewer-auth.js";

/** Build a fetch stub that returns the given JSON for the first matching URL substring. */
function stubFetch(routes: Array<{ match: string; status?: number; json: unknown }>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    const r = routes.find((x) => u.includes(x.match));
    if (!r) throw new Error(`unexpected fetch: ${u}`);
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => r.json,
    } as Response;
  }) as typeof fetch;
}

describe("GitHubReviewerAuth", () => {
  it("defaults to the shared slowcook OAuth app when no clientId is given", () => {
    expect(SLOWCOOK_REVIEW_OAUTH_CLIENT_ID).toMatch(/^Ov23/); // OAuth App client-id format
    // sends the default client_id in the device-code request body
    let sentBody = "";
    const auth = new GitHubReviewerAuth({
      fetchImpl: (async (_u: unknown, init: RequestInit) => {
        sentBody = String(init.body);
        return { ok: true, status: 200, json: async () => ({ device_code: "d", user_code: "u", verification_uri: "v", expires_in: 1, interval: 1 }) } as Response;
      }) as typeof fetch,
    });
    return auth.requestDeviceCode().then(() => {
      expect(JSON.parse(sentBody).client_id).toBe(SLOWCOOK_REVIEW_OAUTH_CLIENT_ID);
    });
  });

  it("maps the device-code grant", async () => {
    const auth = new GitHubReviewerAuth({
      clientId: "cid",
      fetchImpl: stubFetch([
        { match: "login/device/code", json: {
          device_code: "DC", user_code: "WXYZ-1234",
          verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5,
        } },
      ]),
    });
    const g = await auth.requestDeviceCode();
    expect(g).toEqual({
      deviceCode: "DC", userCode: "WXYZ-1234",
      verificationUri: "https://github.com/login/device", intervalSeconds: 5, expiresInSeconds: 900,
    });
  });

  it("maps every poll outcome", async () => {
    const make = (json: unknown) =>
      new GitHubReviewerAuth({ clientId: "cid", fetchImpl: stubFetch([{ match: "oauth/access_token", json }]) });
    expect(await make({ access_token: "tok" }).pollAccessToken("DC")).toEqual({ status: "authorized", token: "tok" });
    expect(await make({ error: "authorization_pending" }).pollAccessToken("DC")).toEqual({ status: "pending" });
    expect(await make({ error: "slow_down", interval: 10 }).pollAccessToken("DC")).toEqual({ status: "slow_down", intervalSeconds: 10 });
    expect(await make({ error: "expired_token" }).pollAccessToken("DC")).toEqual({ status: "expired" });
    expect(await make({ error: "access_denied" }).pollAccessToken("DC")).toEqual({ status: "denied" });
  });

  it("throws on an unexpected device-flow error", async () => {
    const auth = new GitHubReviewerAuth({ clientId: "cid", fetchImpl: stubFetch([{ match: "oauth/access_token", json: { error: "weird" } }]) });
    await expect(auth.pollAccessToken("DC")).rejects.toThrow(/unexpected device-flow error/);
  });

  it("resolves identity, falling back name→login", async () => {
    const named = new GitHubReviewerAuth({ clientId: "c", fetchImpl: stubFetch([{ match: "api.github.com/user", json: { login: "ana", name: "Ana Q", avatar_url: "http://a/x.png" } }]) });
    expect(await named.identify("t")).toEqual({ login: "ana", name: "Ana Q", avatarUrl: "http://a/x.png" });
    const unnamed = new GitHubReviewerAuth({ clientId: "c", fetchImpl: stubFetch([{ match: "api.github.com/user", json: { login: "ben", name: null } }]) });
    expect(await unnamed.identify("t")).toMatchObject({ login: "ben", name: "ben" });
  });
});
