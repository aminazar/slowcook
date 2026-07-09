// Hono adapter: one middleware that opens a request context, stamps a request
// id (echoed as X-Request-Id so a bug report carries the exact needle), reads
// the QA session header, times the request, and on error OR when a QA session
// is present hands the completed trace to a sink (persist it for the agent).
import { runInContext, currentContext, type RequestContext, type TraceEvent } from "./context.js";
import { log } from "./logger.js";

type MiniCtx = {
  req: { method: string; path: string; header: (k: string) => string | undefined };
  res: { headers: { set: (k: string, v: string) => void }; status: number };
  header: (k: string, v: string) => void;
};
type Next = () => Promise<void>;

export interface CompletedTrace {
  requestId: string;
  qaSession?: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  memberEmail?: string;
  events: TraceEvent[];
  at: number;
}

export interface RequestIdOptions {
  /** called with the finished trace on error or when a QA session is active. */
  onTrace?: (t: CompletedTrace) => void;
  /** resolve the acting member's email for the context (best-effort). */
  resolveEmail?: (c: MiniCtx) => Promise<string | undefined> | string | undefined;
  /** id generator (default: time + random36). Injectable for tests. */
  genId?: () => string;
}

const defaultId = () => `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

export function requestContext(opts: RequestIdOptions = {}) {
  const genId = opts.genId ?? defaultId;
  return async (c: MiniCtx, next: Next): Promise<void> => {
    const requestId = c.req.header("x-request-id") || genId();
    const qaSession = c.req.header("x-qa-session") || undefined;
    const ctx: RequestContext = {
      requestId, qaSession, method: c.req.method, path: c.req.path,
      startedAt: Date.now(), events: [],
    };
    c.header("X-Request-Id", requestId);
    await runInContext(ctx, async () => {
      if (opts.resolveEmail) { try { ctx.memberEmail = await opts.resolveEmail(c); } catch { /* best-effort */ } }
      let threw: unknown;
      try {
        await next();
      } catch (e) {
        threw = e;
        log.error("request threw", { err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack : undefined });
      }
      const status = c.res.status;
      const durationMs = Date.now() - ctx.startedAt;
      const cur = currentContext()!;
      const isError = !!threw || status >= 500;
      if (opts.onTrace && (isError || cur.qaSession)) {
        opts.onTrace({
          requestId, qaSession: cur.qaSession, method: cur.method, path: cur.path,
          status, durationMs, memberEmail: cur.memberEmail, events: cur.events, at: Date.now(),
        });
      }
      if (threw) throw threw;
    });
  };
}
