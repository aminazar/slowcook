import { createHash } from "node:crypto";

/**
 * Stable hash for a fetch request: method + URL path + sorted query
 * params + sorted top-level body keys. Body order and query-param order
 * shouldn't cache-bust; different VALUES for those fields should.
 *
 * Kept intentionally coarse — two requests that differ only by a
 * timestamp in the body still hash identically, so replay returns a
 * deterministic fixture. That's the contract: record captures "what the
 * agent WOULD do if it called this endpoint with this rough shape."
 *
 * Returned string: 12-char hex (sha256 truncated). Fixture files live at
 * `tests/fixtures/<story-id>/<service>/<hash>.json`.
 */
export function hashRequest(input: {
  method: string;
  url: string;
  body?: unknown;
}): string {
  const method = input.method.toUpperCase();
  const parsed = safeParseUrl(input.url);
  const path = parsed ? parsed.pathname : input.url;
  const sortedQuery = parsed ? sortSearchParams(parsed.searchParams) : "";
  const sortedBody = canonicaliseBody(input.body);
  const signature = `${method} ${path}?${sortedQuery}\n${sortedBody}`;
  return createHash("sha256").update(signature).digest("hex").slice(0, 12);
}

function safeParseUrl(url: string): URL | null {
  try {
    // If the URL is relative (e.g. "/api/foo"), URL() throws without a
    // base. We construct a dummy base so the parser behaves.
    return url.startsWith("http") ? new URL(url) : new URL(url, "http://localhost");
  } catch {
    return null;
  }
}

function sortSearchParams(params: URLSearchParams): string {
  const entries = Array.from(params.entries()).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  return entries.map(([k, v]) => `${k}=${v}`).join("&");
}

function canonicaliseBody(body: unknown): string {
  if (body === undefined || body === null) return "";
  if (typeof body === "string") {
    // If the string is JSON, normalize key order; otherwise use as-is.
    try {
      return canonicaliseBody(JSON.parse(body));
    } catch {
      return body;
    }
  }
  if (typeof body !== "object") return String(body);
  return JSON.stringify(sortKeys(body));
}

function sortKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeys);
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortKeys((obj as Record<string, unknown>)[key]);
    }
    return out;
  }
  return obj;
}
