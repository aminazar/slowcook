import { describe, it, expect } from "vitest";
import {
  navigatorVerdictToHookVerdict,
  extractTextFromResponse,
  parseNavigatorVerdict,
  createPairNavigatorHook,
} from "./pair-navigator.js";
import type { NavigatorVerdict } from "@slowcook-ai/llm-anthropic";

describe("navigatorVerdictToHookVerdict (#82 prompt-shape → brew-shape adapter)", () => {
  it("maps overall: approve → approve", () => {
    const v: NavigatorVerdict = {
      overall: "approve",
      axes: [],
      rationale: "looks fine",
    };
    const r = navigatorVerdictToHookVerdict(v, 0.01);
    expect(r.overall).toBe("approve");
  });

  it("maps overall: warn → approve (warn is informational, not blocking)", () => {
    const v: NavigatorVerdict = {
      overall: "warn",
      axes: [
        { axis: "code_quality", severity: "warn", summary: "name shadowing", evidence: "x", recommendation: "rename" },
      ],
      rationale: "minor",
    };
    const r = navigatorVerdictToHookVerdict(v, 0.01);
    expect(r.overall).toBe("approve");
    // Concerns still surface even on approve so the audit trail keeps them.
    expect(r.concerns).toEqual(["code_quality: name shadowing"]);
  });

  it("maps overall: block → block", () => {
    const v: NavigatorVerdict = {
      overall: "block",
      axes: [
        { axis: "responsive", severity: "blocking", summary: "no mobile breakpoint", evidence: "x", recommendation: "add" },
      ],
      rationale: "blocking",
    };
    const r = navigatorVerdictToHookVerdict(v, 0.02);
    expect(r.overall).toBe("block");
    expect(r.concerns).toEqual(["responsive: no mobile breakpoint"]);
  });

  it("sorts blocking concerns before warn ones", () => {
    const v: NavigatorVerdict = {
      overall: "block",
      axes: [
        { axis: "code_quality", severity: "warn", summary: "minor lint", evidence: "x", recommendation: "fix" },
        { axis: "responsive", severity: "blocking", summary: "broken on mobile", evidence: "x", recommendation: "fix" },
        { axis: "design_fidelity", severity: "blocking", summary: "wrong color", evidence: "x", recommendation: "fix" },
      ],
      rationale: "y",
    };
    const r = navigatorVerdictToHookVerdict(v, 0.02);
    expect(r.concerns[0]).toMatch(/^responsive:/);
    expect(r.concerns[1]).toMatch(/^design_fidelity:/);
    expect(r.concerns[2]).toMatch(/^code_quality:/);
  });

  it("attaches costUsd when > 0", () => {
    const v: NavigatorVerdict = { overall: "approve", axes: [], rationale: "" };
    const r = navigatorVerdictToHookVerdict(v, 0.0123);
    expect(r.costUsd).toBe(0.0123);
  });

  it("omits costUsd when 0 (preserves NavigatorHookVerdict optionality)", () => {
    const v: NavigatorVerdict = { overall: "approve", axes: [], rationale: "" };
    const r = navigatorVerdictToHookVerdict(v, 0);
    expect(r.costUsd).toBeUndefined();
  });

  it("handles empty axes array on approve", () => {
    const v: NavigatorVerdict = { overall: "approve", axes: [], rationale: "" };
    const r = navigatorVerdictToHookVerdict(v, 0);
    expect(r.concerns).toEqual([]);
  });
});

describe("extractTextFromResponse", () => {
  it("concatenates text-type blocks in content array", () => {
    const r = extractTextFromResponse({
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    });
    expect(r).toBe("first\nsecond");
  });

  it("ignores non-text blocks (tool_use etc.)", () => {
    const r = extractTextFromResponse({
      content: [
        { type: "text", text: "yes" },
        { type: "tool_use" },
        { type: "text", text: "no" },
      ],
    });
    expect(r).toBe("yes\nno");
  });

  it("returns empty string when content is missing or wrong type", () => {
    expect(extractTextFromResponse({ content: [] })).toBe("");
    expect(extractTextFromResponse({ content: undefined as unknown as [] })).toBe("");
  });
});

describe("parseNavigatorVerdict", () => {
  it("parses bare JSON", () => {
    const text = JSON.stringify({
      overall: "approve",
      axes: [],
      rationale: "looks ok",
    });
    const v = parseNavigatorVerdict(text);
    expect(v.overall).toBe("approve");
    expect(v.rationale).toBe("looks ok");
  });

  it("parses ```json fenced JSON", () => {
    const text = '```json\n{"overall":"block","axes":[],"rationale":"x"}\n```';
    const v = parseNavigatorVerdict(text);
    expect(v.overall).toBe("block");
  });

  it("parses ``` (no json hint) fenced JSON", () => {
    const text = '```\n{"overall":"warn","axes":[],"rationale":"x"}\n```';
    const v = parseNavigatorVerdict(text);
    expect(v.overall).toBe("warn");
  });

  it("tolerates leading/trailing prose around the JSON", () => {
    const text = 'Here is my verdict:\n\n```json\n{"overall":"approve","axes":[],"rationale":"x"}\n```\n\nDone.';
    const v = parseNavigatorVerdict(text);
    expect(v.overall).toBe("approve");
  });

  it("throws on malformed JSON", () => {
    expect(() => parseNavigatorVerdict("not json")).toThrow();
  });

  it("throws when overall is wrong type", () => {
    const text = JSON.stringify({ overall: "ghost", axes: [], rationale: "x" });
    expect(() => parseNavigatorVerdict(text)).toThrow(/overall/);
  });

  it("throws when axes is not an array", () => {
    const text = JSON.stringify({ overall: "approve", axes: "x", rationale: "x" });
    expect(() => parseNavigatorVerdict(text)).toThrow(/axes/);
  });

  it("throws when rationale is missing", () => {
    const text = JSON.stringify({ overall: "approve", axes: [] });
    expect(() => parseNavigatorVerdict(text)).toThrow(/rationale/);
  });
});

describe("navigator spend reaches the ledger (WP1, 2026-10-24)", () => {
  const verdictText = JSON.stringify({ overall: "approve", axes: [], rationale: "fine" });
  // The LlmClient seam: what claude-cli or the API adapter would return.
  const fakeLlm = (text: string): import("@slowcook-ai/core").LlmClient => ({
    async complete() {
      return { text, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, cacheCreateTokens: 0 }, costUsd: 0, model: "m" };
    },
  });
  const input = {
    iteration: 4, storyId: "7", filesTouched: ["src/a.ts"], linesAdded: 1, linesRemoved: 0,
    rationale: "r", gainedTests: [], repoRoot: "/r",
  };
  const ctx = async () => ({ mockFiles: [], codeMapDigest: "", storyTestIds: [] });

  it("prices through costFor (cache tokens included) and reports usage on every call", async () => {
    const calls: Array<{ iteration: number; model: string; costUsd: number | null; cacheRead: number }> = [];
    const hook = createPairNavigatorHook({
      llm: fakeLlm(verdictText),
      model: "claude-fable-5-1",
      costFor: (u) => (u.inputTokens * 10 + u.outputTokens * 50 + u.cacheReadTokens * 1) / 1_000_000,
      onCall: (i) => calls.push({ iteration: i.iteration, model: i.model, costUsd: i.costUsd, cacheRead: i.usage.cacheReadTokens }),
      loadPromptContext: ctx,
    });
    const v = await hook.review(input);
    expect(calls).toEqual([{ iteration: 4, model: "claude-fable-5-1", costUsd: 0.0155, cacheRead: 500 }]);
    expect(v?.costUsd).toBeCloseTo(0.0155, 6);
  });

  it("an unparseable verdict still reports the spend (abstain is not free)", async () => {
    const calls: number[] = [];
    const hook = createPairNavigatorHook({
      llm: fakeLlm("not json at all"),
      model: "m",
      costFor: () => 0.02,
      onCall: (i) => calls.push(i.costUsd ?? -1),
      loadPromptContext: ctx,
    });
    expect(await hook.review(input)).toBeNull();
    expect(calls).toEqual([0.02]);
  });

  it("an unpriced model reaches the ledger as null while the budget keeps a number", async () => {
    let seen: number | null | undefined;
    const hook = createPairNavigatorHook({
      llm: fakeLlm(verdictText),
      model: "claude-unknown",
      costFor: () => null,
      onCall: (i) => { seen = i.costUsd; },
      loadPromptContext: ctx,
    });
    const v = await hook.review(input);
    expect(seen).toBeNull();
    expect(v?.costUsd).toBeUndefined();
  });
});
