import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashRequest } from "./hash.js";
import { scrub, type ScrubConfig } from "./scrub.js";

export type RecorderMode = "record" | "replay" | "passthrough";

export interface RecorderOptions {
  /** Root directory where fixtures live. Default `tests/fixtures`. */
  fixturesRoot?: string;
  /** Story id scope for this recorder instance. Fixtures land under
   *  `<fixturesRoot>/story-<id>/<service>/<hash>.json`. */
  storyId: string;
  /** Service bucket (`supabase`, `openai`, etc.). Keeps providers apart. */
  service: string;
  /** Mode. Defaults from env: SLOWCOOK_RECORD=1 → record,
   *  SLOWCOOK_REPLAY=1 → replay, else passthrough (unchanged fetch). */
  mode?: RecorderMode;
  /** Passed to scrub() before writing fixtures. */
  scrubConfig?: ScrubConfig;
  /** Underlying fetch to wrap. Defaults to globalThis.fetch. */
  baseFetch?: typeof fetch;
}

interface FixtureShape {
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  };
  recorded_at: string;
  slowcook_version: string;
}

function envMode(): RecorderMode {
  if (process.env.SLOWCOOK_REPLAY === "1") return "replay";
  if (process.env.SLOWCOOK_RECORD === "1") return "record";
  return "passthrough";
}

/**
 * Wrap a fetch-compatible function with record/replay behaviour.
 *
 * - `record` — calls the real fetch, saves the request + response pair
 *   to disk (after scrubbing), then returns the real response.
 * - `replay` — hashes the request, loads the matching fixture, returns
 *   it as a `Response` object. Throws if no fixture matches (forces the
 *   operator to re-record rather than silently hit the live service).
 * - `passthrough` — returns the base fetch unchanged. Development mode.
 *
 * Integration: the consumer exports a Supabase client factory that uses
 * the returned fetch. Example:
 *
 *   const recording = createRecordingFetch({ storyId: "005", service: "supabase" });
 *   const client = createSupabaseClient(url, key, { global: { fetch: recording } });
 */
export function createRecordingFetch(options: RecorderOptions): typeof fetch {
  const mode = options.mode ?? envMode();
  if (mode === "passthrough") {
    return options.baseFetch ?? globalThis.fetch;
  }
  const baseFetch = options.baseFetch ?? globalThis.fetch;
  const fixturesRoot = options.fixturesRoot ?? "tests/fixtures";
  const dir = join(fixturesRoot, `story-${options.storyId}`, options.service);

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = typeof input === "string" ? input : input.toString();
    const rawBody = init?.body;
    const body = await bodyToJson(rawBody);
    const hash = hashRequest({ method, url, body });
    const fixturePath = join(dir, `${hash}.json`);

    if (mode === "replay") {
      if (!existsSync(fixturePath)) {
        throw new Error(
          `slowcook recorder: no fixture at ${fixturePath} for ${method} ${url}. ` +
          `Run tests with SLOWCOOK_RECORD=1 to capture it against the real service, then re-run with SLOWCOOK_REPLAY=1. ` +
          `If the request shape shifted recently, the old fixture's hash won't match; re-record to refresh.`
        );
      }
      const fixture: FixtureShape = JSON.parse(readFileSync(fixturePath, "utf8"));
      return new Response(
        typeof fixture.response.body === "string"
          ? fixture.response.body
          : JSON.stringify(fixture.response.body),
        {
          status: fixture.response.status,
          headers: fixture.response.headers,
        }
      );
    }

    // record mode: do the real request, save result.
    const response = await baseFetch(input as RequestInfo, init);
    const clone = response.clone();
    const responseBody = await bodyToJson(clone.body ? await clone.text() : "");
    const fixture: FixtureShape = {
      request: {
        method,
        url,
        headers: headersToRecord(init?.headers),
        body: body ?? null,
      },
      response: {
        status: response.status,
        headers: headersToRecord(response.headers),
        body: responseBody,
      },
      recorded_at: new Date().toISOString(),
      slowcook_version: "0.9.1",
    };
    const scrubbed = scrub(fixture, options.scrubConfig) as FixtureShape;
    mkdirSync(dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, JSON.stringify(scrubbed, null, 2) + "\n");
    return response;
  }) as typeof fetch;
}

async function bodyToJson(body: unknown): Promise<unknown> {
  if (body === undefined || body === null || body === "") return null;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  return body;
}

function headersToRecord(headers: HeadersInit | Headers | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) out[k] = v;
    return out;
  }
  return { ...(headers as Record<string, string>) };
}
