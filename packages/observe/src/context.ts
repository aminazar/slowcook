// Request-scoped context (the correlation spine). Every log line, DB timing,
// upstream call and breadcrumb inside one request shares its `requestId` (and,
// when a QA session is active, its `qaSession`) via Node's AsyncLocalStorage —
// so "everything that happened in that request/session" is a single query
// after the fact, no repro needed.
import { AsyncLocalStorage } from "node:async_hooks";

export interface TraceEvent {
  t: number; // ms since request start
  kind: "log" | "db" | "http" | "error" | "event";
  msg: string;
  data?: Record<string, unknown>;
}

export interface RequestContext {
  requestId: string;
  qaSession?: string;
  method: string;
  path: string;
  startedAt: number;
  memberEmail?: string;
  /** in-request event buffer — persisted on error / when a QA session is on. */
  events: TraceEvent[];
}

const als = new AsyncLocalStorage<RequestContext>();

export function runInContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return als.getStore();
}

/** append an event to the current request's trace buffer (bounded). */
export function trace(kind: TraceEvent["kind"], msg: string, data?: Record<string, unknown>): void {
  const ctx = als.getStore();
  if (!ctx) return;
  if (ctx.events.length >= 200) ctx.events.shift();
  ctx.events.push({ t: Date.now() - ctx.startedAt, kind, msg, data });
}
