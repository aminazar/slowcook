import { describe, it, expect } from "vitest";
import {
  loadReviewerToken, saveReviewerToken, loadReviewerIdentity, saveReviewerIdentity,
  clearReviewerSession, runDeviceLogin, identifyReviewer, type LoginEvent,
} from "./reviewer-session.js";
import type { RepoCoord } from "./github.js";

const repo: RepoCoord = { owner: "o", repo: "r" };

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() { return m.size; },
  } as Storage;
}

describe("reviewer-session storage", () => {
  it("round-trips token + identity, scoped per repo, and clears", () => {
    const s = memStorage();
    saveReviewerToken(s, repo, "tok");
    saveReviewerIdentity(s, repo, { login: "ana", name: "Ana" });
    expect(loadReviewerToken(s, repo)).toBe("tok");
    expect(loadReviewerIdentity(s, repo)).toEqual({ login: "ana", name: "Ana" });
    expect(loadReviewerToken(s, { owner: "x", repo: "y" })).toBeNull(); // per-repo scope
    clearReviewerSession(s, repo);
    expect(loadReviewerToken(s, repo)).toBeNull();
    expect(loadReviewerIdentity(s, repo)).toBeNull();
  });
});

/** Sequence a fetch stub across the device + poll endpoints. */
function seqFetch(deviceJson: unknown, pollSequence: unknown[]): typeof fetch {
  let pi = 0;
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/auth/device")) return { ok: true, json: async () => deviceJson } as Response;
    if (u.includes("/auth/poll")) return { ok: true, json: async () => pollSequence[Math.min(pi++, pollSequence.length - 1)] } as Response;
    if (u.includes("api.github.com/user")) return { ok: true, json: async () => ({ login: "ana", name: "Ana Q" }) } as Response;
    throw new Error(`unexpected ${u}`);
  }) as typeof fetch;
}

describe("runDeviceLogin", () => {
  const grant = { deviceCode: "DC", userCode: "WXYZ-1234", verificationUri: "https://github.com/login/device", intervalSeconds: 1, expiresInSeconds: 900 };

  it("surfaces the code, honours slow_down, then authorizes", async () => {
    const events: LoginEvent[] = [];
    const token = await runDeviceLogin({
      authBase: "http://box:4200",
      onEvent: (e) => events.push(e),
      sleep: async () => {},
      fetchImpl: seqFetch(grant, [
        { status: "pending" },
        { status: "slow_down", intervalSeconds: 2 },
        { status: "authorized", token: "tok-xyz" },
      ]),
    });
    expect(token).toBe("tok-xyz");
    expect(events[0]).toEqual({ type: "code", grant });
    expect(events.at(-1)).toEqual({ type: "authorized", token: "tok-xyz" });
  });

  it("returns null + emits denied", async () => {
    const events: LoginEvent[] = [];
    const token = await runDeviceLogin({
      authBase: "http://box:4200", onEvent: (e) => events.push(e), sleep: async () => {},
      fetchImpl: seqFetch(grant, [{ status: "denied" }]),
    });
    expect(token).toBeNull();
    expect(events.at(-1)).toEqual({ type: "denied" });
  });

  it("stops when shouldStop fires", async () => {
    const token = await runDeviceLogin({
      authBase: "http://box:4200", onEvent: () => {}, sleep: async () => {}, shouldStop: () => true,
      fetchImpl: seqFetch(grant, [{ status: "pending" }]),
    });
    expect(token).toBeNull();
  });

  it("identifyReviewer maps the user, name→login fallback", async () => {
    const f = (async () => ({ ok: true, json: async () => ({ login: "ben", name: null }) } as Response)) as typeof fetch;
    expect(await identifyReviewer("t", f)).toMatchObject({ login: "ben", name: "ben" });
  });
});
