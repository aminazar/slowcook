// Structured logging — pino when available, else a dependency-free console-JSON
// fallback (so observe runs anywhere with zero runtime deps; the box needs no
// install). Every line auto-carries the current request's ids from
// AsyncLocalStorage. Level is runtime-mutable (dynamic verbosity — raise a
// repro to debug, revert — no restart).
import { currentContext, trace } from "./context.js";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

interface Sink { debug(o: object, m: string): void; info(o: object, m: string): void; warn(o: object, m: string): void; error(o: object, m: string): void; level: string; }

let level: Level = (process.env["LOG_LEVEL"] as Level) ?? "info";
// console-JSON fallback — the always-available sink.
const consoleSink: Sink = {
  get level() { return level; }, set level(l: string) { level = l as Level; },
  debug(o, m) { emit("debug", o, m); }, info(o, m) { emit("info", o, m); },
  warn(o, m) { emit("warn", o, m); }, error(o, m) { emit("error", o, m); },
};
function emit(l: Level, o: object, m: string) {
  if (ORDER[l] < ORDER[level]) return;
  const line = JSON.stringify({ level: l, time: new Date().toISOString(), msg: m, ...o });
  (l === "error" || l === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

let sink: Sink = consoleSink;
// upgrade to pino if it's installed (optional peer) — best-effort, async.
void (async () => {
  try {
    const pino = (await import("pino")).default;
    const p = pino({ level, ...(process.env["LOG_PRETTY"] ? { transport: { target: "pino-pretty" } } : {}) });
    sink = p as unknown as Sink;
  } catch { /* console-JSON stays — fine */ }
})();

function withCtx(): Record<string, unknown> {
  const c = currentContext();
  if (!c) return {};
  return { requestId: c.requestId, ...(c.qaSession ? { qaSession: c.qaSession } : {}) };
}

export const log = {
  debug(msg: string, data?: Record<string, unknown>) { sink.debug({ ...withCtx(), ...data }, msg); trace("log", msg, data); },
  info(msg: string, data?: Record<string, unknown>) { sink.info({ ...withCtx(), ...data }, msg); trace("log", msg, data); },
  warn(msg: string, data?: Record<string, unknown>) { sink.warn({ ...withCtx(), ...data }, msg); trace("log", msg, data); },
  error(msg: string, data?: Record<string, unknown>) { sink.error({ ...withCtx(), ...data }, msg); trace("error", msg, data); },
};

export function setLogLevel(l: Level): void { level = l; sink.level = l; }
export function getLogLevel(): string { return sink.level; }
export function _setBaseLogger(l: unknown): void { sink = l as Sink; }
