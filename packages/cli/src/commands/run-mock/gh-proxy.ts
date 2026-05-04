/**
 * Localhost gh-proxy — 0.18.0-α.2.
 *
 * `slowcook run-mock` spawns this proxy alongside the dev server so the
 * review overlay can submit comments without prompting the PM for a PAT.
 *
 * Flow:
 *   1. cli reads the local `gh auth token` once at startup.
 *   2. proxy listens on a free port; forwards every request body 1:1
 *      to https://api.github.com<path>, swapping the Authorization
 *      header for `Bearer <gh-token>`.
 *   3. dev process gets NEXT_PUBLIC_SLOWCOOK_GH_PROXY=http://localhost:<port>
 *      injected into env. Overlay reads it + sends API calls to the
 *      proxy instead of github.com directly.
 *
 * CORS: emits Access-Control-Allow-Origin: * + the request's
 * Access-Control-Request-Headers so the browser preflight passes.
 * The proxy only ever binds to 127.0.0.1; it is not exposed off-host.
 */
import { createServer, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { execSync } from "node:child_process";

export interface ProxyHandle {
  url: string;
  port: number;
  close: () => void;
}

/**
 * Read the gh CLI's stored token. Returns null when gh isn't installed
 * or the user hasn't run `gh auth login` — caller falls back to the
 * old PAT-prompt path.
 */
export function readGhToken(): string | null {
  try {
    const out = execSync("gh auth token", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

const GITHUB_HOST = "api.github.com";

export async function startGhProxy(token: string, preferredPort = 4100): Promise<ProxyHandle> {
  const server: Server = createServer((req, res) => {
    const origin = req.headers["origin"];
    const reqHeaders = req.headers["access-control-request-headers"];

    // CORS preflight — answer with the headers the browser asked for.
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": typeof origin === "string" ? origin : "*",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": typeof reqHeaders === "string" ? reqHeaders : "Authorization, Content-Type, Accept, X-GitHub-Api-Version",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    const url = req.url ?? "/";
    // Strip the proxy origin if present (defense-in-depth — overlay
    // sends relative-path requests but a curl-test might not).
    const path = url.replace(/^https?:\/\/[^/]+/, "");

    // Strip browser-set + client-set Authorization; substitute gh token.
    const forwardedHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      const lower = k.toLowerCase();
      if (lower === "host" || lower === "authorization" || lower === "origin" || lower === "referer") continue;
      forwardedHeaders[k] = v;
    }
    forwardedHeaders["Authorization"] = `Bearer ${token}`;
    forwardedHeaders["host"] = GITHUB_HOST;
    if (!forwardedHeaders["accept"]) forwardedHeaders["Accept"] = "application/vnd.github+json";
    if (!forwardedHeaders["x-github-api-version"]) forwardedHeaders["X-GitHub-Api-Version"] = "2022-11-28";
    if (!forwardedHeaders["user-agent"]) forwardedHeaders["User-Agent"] = "slowcook-run-mock-proxy";

    const upstream = httpsRequest(
      {
        host: GITHUB_HOST,
        port: 443,
        method: req.method,
        path,
        headers: forwardedHeaders,
      },
      (gh) => {
        // Mirror status + headers; strip upstream CORS so we don't
        // double-emit Access-Control-Allow-Origin (github sends '*'
        // for unauth'd reads, browser rejects two values).
        const outHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(gh.headers)) {
          if (v === undefined) continue;
          if (k.toLowerCase().startsWith("access-control-")) continue;
          outHeaders[k] = v;
        }
        outHeaders["Access-Control-Allow-Origin"] = typeof origin === "string" ? origin : "*";
        outHeaders["Access-Control-Expose-Headers"] = "ETag, Link, X-RateLimit-Remaining, X-RateLimit-Reset";
        res.writeHead(gh.statusCode ?? 502, outHeaders);
        gh.pipe(res);
      }
    );
    upstream.on("error", (e) => {
      res.writeHead(502, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": typeof origin === "string" ? origin : "*",
      });
      res.end(JSON.stringify({ error: `proxy upstream error: ${(e as Error).message}` }));
    });
    req.pipe(upstream);
  });

  return await new Promise<ProxyHandle>((resolve, reject) => {
    const tryListen = (port: number, attemptsLeft: number) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener("error", onError);
        if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
          tryListen(port + 1, attemptsLeft - 1);
        } else {
          reject(err);
        }
      };
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
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
