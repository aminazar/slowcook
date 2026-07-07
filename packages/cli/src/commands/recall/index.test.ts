import { describe, it, expect } from "vitest";
import { ctxSearch, ctxAvailable, type CtxRunner } from "./ctx.js";
import { recallBrief, topPerSession } from "./brief.js";

// a fake ctx binary: returns canned --json for `search`, version for `--version`.
const fakeCtx = (payload: unknown): CtxRunner => (args) => {
  if (args[0] === "--version") return "ctx 0.20.0\n";
  if (args[0] === "search") return JSON.stringify(payload);
  return "";
};
const throwing: CtxRunner = () => { throw new Error("ctx not found"); };

const RESULTS = {
  results: [
    { item_type: "session_result", label: "message", session_id: "s1", event_id: "e1", provider: "claude", title: "wallet flag DCE", snippet: "  the   VITE flag  was\tnever set → canned wallet shipped ", timestamp: "2026-07-06T10:00:00Z", rank: 9, session_importance: 0.9 },
    { item_type: "session", label: "session", session_id: "s1", provider: "claude", snippet: "session-level row, should be dropped", timestamp: "2026-07-06T10:00:00Z" },
    { item_type: "session_result", label: "tool output", session_id: "s1", provider: "claude", snippet: "a weaker snippet from the same session", timestamp: "2026-07-06T09:00:00Z", rank: 3, session_importance: 0.9 },
    { item_type: "event", label: "message", session_id: "s2", provider: "cursor", title: "surface parity", snippet: "added flag-completeness gate", timestamp: "2026-07-05T12:00:00Z", rank: 5, session_importance: 0.4 },
  ],
};

describe("ctx wrapper", () => {
  it("ctxAvailable reflects whether the binary runs", () => {
    expect(ctxAvailable(fakeCtx({}))).toBe(true);
    expect(ctxAvailable(throwing)).toBe(false);
  });

  it("ctxSearch normalizes --json, drops bare session rows, collapses whitespace", () => {
    const r = ctxSearch({ query: "wallet" }, fakeCtx(RESULTS));
    expect(r).toHaveLength(3); // the item_type:"session" row is dropped
    expect(r.every((x) => x.itemType !== "session")).toBe(true);
    expect(r[0]!.snippet).toBe("the VITE flag was never set → canned wallet shipped");
    expect(r[0]!.provider).toBe("claude");
  });

  it("passes query/file/limit/workspace through as ctx flags", () => {
    let seen: string[] = [];
    const spy: CtxRunner = (a) => { seen = a; return JSON.stringify({ results: [] }); };
    ctxSearch({ query: "x", file: "server/src/http.ts", limit: 3, workspace: "/repo", since: "30d" }, spy);
    expect(seen).toEqual(["search", "--json", "x", "--file", "server/src/http.ts", "--limit", "3", "--since", "30d", "--workspace", "/repo", "--event-type", "message"]);
  });

  it("returns [] (never throws) when ctx errors or emits non-JSON", () => {
    expect(ctxSearch({ query: "x" }, throwing)).toEqual([]);
    expect(ctxSearch({ query: "x" }, () => "not json")).toEqual([]);
  });
});

describe("recall brief", () => {
  it("dedups to the highest-rank snippet per session", () => {
    const r = ctxSearch({ query: "x" }, fakeCtx(RESULTS));
    const top = topPerSession(r, 6);
    expect(top).toHaveLength(2); // s1 + s2
    expect(top.find((x) => x.sessionId === "s1")!.snippet).toContain("VITE flag"); // rank 9 beat rank 3
  });

  it("orders by session importance, then recency", () => {
    const top = topPerSession(ctxSearch({ query: "x" }, fakeCtx(RESULTS)), 6);
    expect(top[0]!.sessionId).toBe("s1"); // importance 0.9 > 0.4
  });

  it("renders a prompt-injectable brief with inspect hints", () => {
    const brief = recallBrief(ctxSearch({ query: "x" }, fakeCtx(RESULTS)), { label: '"wallet"' });
    expect(brief).toContain("Prior context (recalled from 2 past agent sessions via ctx)");
    expect(brief).toContain("wallet flag DCE");
    expect(brief).toContain("→ inspect: ctx show session s1");
  });

  it("is empty-safe: a one-liner when nothing is recalled", () => {
    expect(recallBrief([], { label: '"x"' })).toContain("No relevant prior agent sessions found");
  });
});
