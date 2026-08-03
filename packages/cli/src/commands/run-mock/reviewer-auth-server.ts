/**
 * Reviewer auth-helper server (0.6.0) — multi-person LCR review.
 *
 * GitHub's device-flow token endpoints (github.com/login/device/code +
 * /login/oauth/access_token) are NOT CORS-accessible from a browser, so the
 * overlay can't run the device dance itself. This tiny server (started by
 * run-mock in `review_mode: lcr`) does the two server-side hops on the
 * overlay's behalf and nothing else.
 *
 * Crucially it is SAFE TO EXPOSE off-host (unlike gh-proxy, which injects the
 * host's own token): it only forwards the PUBLIC client-id + a per-session
 * device code to GitHub's public device endpoints. The reviewer's resulting
 * access token is returned to whoever completed the GitHub consent — the host
 * never sees a privileged secret. So for the remote-box case it binds 0.0.0.0;
 * for local use, 127.0.0.1.
 *
 * Endpoints (all JSON, permissive CORS):
 *   POST /__slowcook/auth/device  → { userCode, verificationUri, deviceCode, intervalSeconds, expiresInSeconds }
 *   POST /__slowcook/auth/poll    { deviceCode } → PollResult
 *   GET  /__slowcook/auth/health  → { ok: true, clientIdSuffix }
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { ForgeReviewerAuth } from "@slowcook-ai/core";
import { deposit, report, loadBank, saveBank, makeIdentityResolver, type StoreIo } from "./screentime-store.js";

export interface AuthServerHandle {
  url: string;
  port: number;
  close: () => void;
}

const DEVICE_PATH = "/__slowcook/auth/device";
const POLL_PATH = "/__slowcook/auth/poll";
const HEALTH_PATH = "/__slowcook/auth/health";
// 0.28.4 — the shared screentime ledger (the overlay fetches `${base}/screentime`)
const SCREENTIME_PATH = "/screentime";

function cors(res: ServerResponse, origin: string | undefined): void {
  res.setHeader("Access-Control-Allow-Origin", origin ?? "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface ScreentimeOptions {
  io: StoreIo;
  /** Injected for tests; defaults to the GitHub /user resolver. */
  resolveLogin?: (token: string) => Promise<string | null>;
  /** Injected for tests; defaults to the wall clock's ISO date. */
  todayFn?: () => string;
}

/** Build the request handler (exported so it can be unit-tested without a socket). */
export function makeAuthHandler(
  auth: ForgeReviewerAuth,
  clientIdSuffix: string,
  screentime?: ScreentimeOptions,
): (req: IncomingMessage, res: ServerResponse) => void {
  const resolveLogin = screentime?.resolveLogin ?? makeIdentityResolver();
  const today = screentime?.todayFn ?? (() => new Date().toISOString().slice(0, 10));
  return (req, res) => {
    const origin = req.headers["origin"] as string | undefined;
    cors(res, origin);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const path = (req.url ?? "").split("?")[0];

    void (async () => {
      try {
        if (req.method === "GET" && path === HEALTH_PATH) {
          sendJson(res, 200, { ok: true, clientIdSuffix });
          return;
        }
        if (req.method === "POST" && path === DEVICE_PATH) {
          const grant = await auth.requestDeviceCode();
          sendJson(res, 200, grant);
          return;
        }
        if (req.method === "POST" && path === POLL_PATH) {
          const body = await readJson(req);
          const deviceCode = typeof body["deviceCode"] === "string" ? body["deviceCode"] : "";
          if (!deviceCode) {
            sendJson(res, 400, { error: "deviceCode required" });
            return;
          }
          const result = await auth.pollAccessToken(deviceCode);
          sendJson(res, 200, result);
          return;
        }
        // ── the screentime ledger: one book for every device and origin ──
        if (screentime && path === SCREENTIME_PATH) {
          const token = (req.headers["authorization"] as string | undefined)?.replace(/^Bearer /i, "") ?? "";
          const login = token ? await resolveLogin(token) : null;
          if (!login) {
            sendJson(res, 401, { error: "a valid GitHub token identifies whose ledger this is" });
            return;
          }
          const project = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("project") ?? "";
          if (req.method === "GET") {
            if (!project) { sendJson(res, 400, { error: "project required" }); return; }
            sendJson(res, 200, report(loadBank(screentime.io), login, project, today()));
            return;
          }
          if (req.method === "POST") {
            const body = await readJson(req);
            const proj = typeof body["project"] === "string" && body["project"] ? body["project"] : project;
            if (!proj) { sendJson(res, 400, { error: "project required" }); return; }
            const seconds = typeof body["seconds"] === "number" ? body["seconds"] : 0;
            const comments = typeof body["comments"] === "number" ? body["comments"] : 0;
            const routes = Array.isArray(body["routes"]) ? (body["routes"] as unknown[]).filter((r): r is string => typeof r === "string").slice(0, 40) : undefined;
            const at = typeof body["at"] === "string" ? body["at"] : "";
            const bank = loadBank(screentime.io);
            deposit(bank, login, proj, today(), seconds, comments, { at, routes });
            saveBank(screentime.io, bank);
            sendJson(res, 200, { ok: true });
            return;
          }
        }
        sendJson(res, 404, { error: "not found" });
      } catch (e) {
        sendJson(res, 502, { error: e instanceof Error ? e.message : String(e) });
      }
    })();
  };
}

/**
 * Start the auth helper. `host` defaults to 127.0.0.1; pass "0.0.0.0" for the
 * remote-box case so a co-worker's browser can reach it.
 */
export async function startReviewerAuthServer(
  auth: ForgeReviewerAuth,
  opts: { clientId: string; preferredPort?: number; host?: string; screentime?: ScreentimeOptions },
): Promise<AuthServerHandle> {
  const suffix = opts.clientId.slice(-4);
  const server: Server = createServer(makeAuthHandler(auth, suffix, opts.screentime));
  const host = opts.host ?? "127.0.0.1";
  const preferredPort = opts.preferredPort ?? 4200;

  return await new Promise<AuthServerHandle>((resolve, reject) => {
    const tryListen = (port: number, attemptsLeft: number) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener("error", onError);
        if (err.code === "EADDRINUSE" && attemptsLeft > 0) tryListen(port + 1, attemptsLeft - 1);
        else reject(err);
      };
      server.once("error", onError);
      server.listen(port, host, () => {
        server.removeListener("error", onError);
        resolve({
          url: `http://localhost:${port}`,
          port,
          close: () => { try { server.close(); } catch { /* ignore */ } },
        });
      });
    };
    tryListen(preferredPort, 20);
  });
}
