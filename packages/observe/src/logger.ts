// Structured logging: pino JSON to stdout (systemd/journald captures it; query
// with `journalctl -u <unit> -o cat | jq`). Every line auto-carries the current
// request's ids from AsyncLocalStorage — no manual threading. Level is mutable
// at runtime (dynamic verbosity: raise a noisy repro to debug, then revert)
// without restarting the process.
import pino, { type Logger } from "pino";
import { currentContext, trace } from "./context.js";

let base: Logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  // keep JSON in prod; pretty only when explicitly asked (dev inner loop)
  ...(process.env["LOG_PRETTY"] ? { transport: { target: "pino-pretty" } } : {}),
});

function withCtx(): Record<string, unknown> {
  const c = currentContext();
  if (!c) return {};
  return { requestId: c.requestId, ...(c.qaSession ? { qaSession: c.qaSession } : {}) };
}

export const log = {
  debug(msg: string, data?: Record<string, unknown>) { base.debug({ ...withCtx(), ...data }, msg); trace("log", msg, data); },
  info(msg: string, data?: Record<string, unknown>) { base.info({ ...withCtx(), ...data }, msg); trace("log", msg, data); },
  warn(msg: string, data?: Record<string, unknown>) { base.warn({ ...withCtx(), ...data }, msg); trace("log", msg, data); },
  error(msg: string, data?: Record<string, unknown>) { base.error({ ...withCtx(), ...data }, msg); trace("error", msg, data); },
};

/** raise/lower verbosity at runtime (dynamic instrumentation, no restart). */
export function setLogLevel(level: "debug" | "info" | "warn" | "error"): void {
  base.level = level;
}
export function getLogLevel(): string { return base.level; }

/** swap the underlying logger (tests inject a silent one). */
export function _setBaseLogger(l: Logger): void { base = l; }
