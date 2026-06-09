import { describe, it, expect, afterEach } from "vitest";
import type { ForgeReviewerAuth, DeviceCodeGrant, PollResult, ReviewerIdentity } from "@slowcook-ai/core";
import { startReviewerAuthServer, type AuthServerHandle } from "./reviewer-auth-server.js";

class FakeAuth implements ForgeReviewerAuth {
  pollResult: PollResult = { status: "pending" };
  async requestDeviceCode(): Promise<DeviceCodeGrant> {
    return { deviceCode: "DC123", userCode: "WXYZ-1234", verificationUri: "https://github.com/login/device", intervalSeconds: 5, expiresInSeconds: 900 };
  }
  async pollAccessToken(deviceCode: string): Promise<PollResult> {
    return deviceCode === "DC123" ? this.pollResult : { status: "denied" };
  }
  async identify(): Promise<ReviewerIdentity> {
    return { login: "x", name: "x" };
  }
}

describe("reviewer-auth-server", () => {
  let handle: AuthServerHandle | null = null;
  afterEach(() => { handle?.close(); handle = null; });

  it("serves health with the client-id suffix", async () => {
    handle = await startReviewerAuthServer(new FakeAuth(), { clientId: "Ov23liABCDwxyz", preferredPort: 4310 });
    const r = await fetch(`${handle.url}/__slowcook/auth/health`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, clientIdSuffix: "wxyz" });
  });

  it("starts a device grant + polls a deviceCode", async () => {
    const fake = new FakeAuth();
    fake.pollResult = { status: "authorized", token: "tok-abc" };
    handle = await startReviewerAuthServer(fake, { clientId: "cid", preferredPort: 4320 });

    const dev = await (await fetch(`${handle.url}/__slowcook/auth/device`, { method: "POST" })).json();
    expect(dev.userCode).toBe("WXYZ-1234");
    expect(dev.verificationUri).toContain("github.com/login/device");

    const poll = await (await fetch(`${handle.url}/__slowcook/auth/poll`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode: dev.deviceCode }),
    })).json();
    expect(poll).toEqual({ status: "authorized", token: "tok-abc" });
  });

  it("400s a poll with no deviceCode, 404s unknown paths", async () => {
    handle = await startReviewerAuthServer(new FakeAuth(), { clientId: "cid", preferredPort: 4330 });
    const bad = await fetch(`${handle.url}/__slowcook/auth/poll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(bad.status).toBe(400);
    const nope = await fetch(`${handle.url}/__slowcook/auth/nope`);
    expect(nope.status).toBe(404);
  });

  it("sets permissive CORS + answers preflight", async () => {
    handle = await startReviewerAuthServer(new FakeAuth(), { clientId: "cid", preferredPort: 4340 });
    const pre = await fetch(`${handle.url}/__slowcook/auth/device`, { method: "OPTIONS", headers: { Origin: "http://box:3100" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("http://box:3100");
  });
});
