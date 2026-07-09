import { describe, it, expect, beforeEach } from "vitest";
import pino from "pino";
import { runInContext, currentContext, trace } from "./context.js";
import { bg, bgFailureCount } from "./bg.js";
import { requestContext, type CompletedTrace } from "./hono.js";
import { _setBaseLogger } from "./logger.js";

_setBaseLogger(pino({ level: "silent" }));

const ctx = () => ({ requestId: "r1", method: "GET", path: "/x", startedAt: Date.now(), events: [] as never[] });

describe("context + trace", () => {
  it("carries ids and buffers events within the run", () => {
    runInContext(ctx(), () => {
      expect(currentContext()?.requestId).toBe("r1");
      trace("event", "hello", { a: 1 });
      expect(currentContext()?.events).toHaveLength(1);
      expect(currentContext()?.events[0]!.msg).toBe("hello");
    });
    expect(currentContext()).toBeUndefined(); // no leakage outside
  });
});

describe("bg", () => {
  it("captures a failing task instead of swallowing it, preserving context", async () => {
    const before = bgFailureCount();
    await new Promise<void>((resolve) => {
      runInContext(ctx(), () => {
        bg("boom", async () => { expect(currentContext()?.requestId).toBe("r1"); throw new Error("x"); });
        setTimeout(resolve, 20);
      });
    });
    expect(bgFailureCount()).toBe(before + 1);
  });
});

describe("requestContext middleware", () => {
  it("stamps X-Request-Id and emits a trace for a QA session", async () => {
    const traces: CompletedTrace[] = [];
    let setHeader = "";
    const mw = requestContext({ onTrace: (t) => traces.push(t), genId: () => "gen1" });
    const c = {
      req: { method: "GET", path: "/p", header: (k: string) => (k === "x-qa-session" ? "qa-9" : undefined) },
      res: { headers: { set: () => {} }, status: 200 },
      header: (_k: string, v: string) => { setHeader = v; },
    };
    await mw(c as never, async () => { trace("log", "did a thing"); });
    expect(setHeader).toBe("gen1");
    expect(traces).toHaveLength(1);
    expect(traces[0]!.qaSession).toBe("qa-9");
    expect(traces[0]!.events.some((e) => e.msg === "did a thing")).toBe(true);
  });

  it("does NOT emit a trace for a plain 200 with no QA session", async () => {
    const traces: CompletedTrace[] = [];
    const mw = requestContext({ onTrace: (t) => traces.push(t) });
    const c = { req: { method: "GET", path: "/p", header: () => undefined }, res: { headers: { set: () => {} }, status: 200 }, header: () => {} };
    await mw(c as never, async () => {});
    expect(traces).toHaveLength(0);
  });
});
