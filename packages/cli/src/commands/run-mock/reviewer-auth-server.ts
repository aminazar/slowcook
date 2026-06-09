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

export interface AuthServerHandle {
  url: string;
  port: number;
  close: () => void;
}

const DEVICE_PATH = "/__slowcook/auth/device";
const POLL_PATH = "/__slowcook/auth/poll";
const HEALTH_PATH = "/__slowcook/auth/health";

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

/** Build the request handler (exported so it can be unit-tested without a socket). */
export function makeAuthHandler(
  auth: ForgeReviewerAuth,
  clientIdSuffix: string,
): (req: IncomingMessage, res: ServerResponse) => void {
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
  opts: { clientId: string; preferredPort?: number; host?: string } ,
): Promise<AuthServerHandle> {
  const suffix = opts.clientId.slice(-4);
  const server: Server = createServer(makeAuthHandler(auth, suffix));
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
