import { describe, it, expect } from "vitest";
import { workspaceCandidates, gatherHistory, parseHistoryClaims, toSurveyShape, HISTORY_THEMES } from "./history.js";
import { buildHistoryPrompt } from "./history-cli.js";
import type { CtxRunner } from "../recall/ctx.js";

describe("extract --history", () => {
  it("maps a repo root to claude's transcript-dir workspace candidate", () => {
    const [repo, transcripts] = workspaceCandidates("/Users/amin/Downloads/rewo", "/Users/amin");
    expect(repo).toBe("/Users/amin/Downloads/rewo");
    expect(transcripts).toBe("/Users/amin/.claude/projects/-Users-amin-Downloads-rewo");
  });

  it("gatherHistory probes candidates, tags themes, dedupes by session+snippet", () => {
    const calls: string[][] = [];
    const run: CtxRunner = (args) => {
      calls.push(args);
      if (args[0] === "--version") return "ctx 0.20.0";
      const ws = args[args.indexOf("--workspace") + 1]!;
      if (!ws.includes(".claude")) return JSON.stringify({ results: [] }); // repo path: nothing
      return JSON.stringify({ results: [
        { item_type: "session_result", label: "message", session_id: "s1", provider: "claude", snippet: "we reverted the async unification — deadlocked under load", timestamp: "2026-06-09T10:00:00Z" },
        { item_type: "session_result", label: "message", session_id: "s1", provider: "claude", snippet: "we reverted the async unification — deadlocked under load", timestamp: "2026-06-09T10:00:00Z" }, // dup
      ] });
    };
    const { workspace, excerpts } = gatherHistory("/repo/x", run);
    expect(workspace).toContain(".claude/projects");
    // one snippet per theme-search, deduped: same (session,snippet) across the 4 themes = 1
    expect(excerpts).toHaveLength(1);
    expect(excerpts[0]!.snippet).toContain("reverted");
    // all themes were searched against the transcript workspace
    const searches = calls.filter((a) => a[0] === "search");
    expect(searches.length).toBeGreaterThanOrEqual(HISTORY_THEMES.length);
  });

  it("gatherHistory returns empty when ctx is absent (honest degradation)", () => {
    const { workspace, excerpts } = gatherHistory("/repo/x", () => { throw new Error("no ctx"); });
    expect(workspace).toBeNull();
    expect(excerpts).toEqual([]);
  });

  it("parseHistoryClaims enforces citations against REAL session ids and drops bad kinds", () => {
    const text = JSON.stringify({ claims: [
      { kind: "rejected_approach", statement: "Async unification was reverted after deadlocks; a sync check replaced it.", session: "s1", when: "2026-06-09" },
      { kind: "decision", statement: "Uncited claim that should be dropped.", session: "sFAKE" },
      { kind: "vibes", statement: "Bad kind should be dropped even with a valid session.", session: "s1" },
    ] });
    const claims = parseHistoryClaims(text, new Set(["s1"]));
    expect(claims).toHaveLength(1);
    expect(claims[0]!.kind).toBe("rejected_approach");
  });

  it("toSurveyShape emits survey-claim rows: build_history source, session evidence, honest statuses", () => {
    const rows = toSurveyShape([
      { kind: "decision", statement: "Cloudflare replaced Vercel.", session: "s1", when: "2026-04-01" },
      { kind: "known_issue", statement: "The pins route throws.", session: "s2" },
    ]);
    expect(rows[0]).toMatchObject({ source: "build_history", status: "verified", area: "architecture" });
    expect(rows[0]!.evidence["inspect"]).toBe("ctx show session s1");
    expect(rows[1]).toMatchObject({ status: "unverified", area: "quality" }); // may have been fixed since
  });

  it("buildHistoryPrompt tags each excerpt with kind | session | date", () => {
    const p = buildHistoryPrompt([{ kind: "decision", sessionId: "s1", timestamp: "2026-06-09T10:00:00Z", snippet: "chose X" }]);
    expect(p).toContain("[decision | s1 | 2026-06-09]");
    expect(p).toContain("chose X");
  });
});
