import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmClient, LlmRequest, LlmResponse } from "@slowcook-ai/core";
import {
  isBrewFeedback,
  isWritablePath,
  executeBrewResubmitTool,
  runResubmitAgent,
  buildResubmitUserPrompt,
} from "./resubmit.js";

let repoRoot: string;
beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "brew-resubmit-"));
  mkdirSync(join(repoRoot, "src"), { recursive: true });
});

describe("isBrewFeedback", () => {
  it("taste advisories and human comments are feedback; machine notices are not", () => {
    expect(isBrewFeedback("**slowcook-taste** · PR #240\n\nfindings…")).toBe(true);
    expect(isBrewFeedback("please add an index on pins.member_id")).toBe(true);
    expect(isBrewFeedback("### slowcook · shipped 🎉\n\nbill…")).toBe(false);
    expect(isBrewFeedback("### slowcook · plate amendment\n\n…")).toBe(false);
  });
});

describe("write scope — the inverse of recipe's", () => {
  it("implementation surfaces are writable", () => {
    expect(isWritablePath("src/app/api/pins/route.ts").ok).toBe(true);
    expect(isWritablePath("supabase/migrations/00025_x.sql").ok).toBe(true);
    expect(isWritablePath("mock/src/App.tsx").ok).toBe(true);
  });

  it("the frozen contract is refused with the escalation hint", () => {
    for (const p of [
      "tests/integration/story-016.test.ts",
      "specs/story-016.yaml",
      ".brewing/manifests/story-016.json",
      "supabase/tests/database/story-016-pins.test.sql",
    ]) {
      const v = isWritablePath(p);
      expect(v.ok).toBe(false);
      expect(v.reason).toContain("frozen contract");
    }
  });

  it("traversal and out-of-scope paths are refused", () => {
    expect(isWritablePath("src/../specs/x.yaml").ok).toBe(false);
    expect(isWritablePath("package.json").ok).toBe(false);
  });
});

describe("executeBrewResubmitTool", () => {
  it("write_file writes inside scope and reports the path", () => {
    const r = executeBrewResubmitTool(repoRoot, {
      id: "t1",
      name: "write_file",
      input: { path: "src/x.ts", content: "export {};\n" },
    });
    expect(r.is_error).toBe(false);
    expect(r.wrotePath).toBe("src/x.ts");
    expect(readFileSync(join(repoRoot, "src/x.ts"), "utf8")).toBe("export {};\n");
  });

  it("write_file REFUSES the frozen contract and leaves no file", () => {
    const r = executeBrewResubmitTool(repoRoot, {
      id: "t2",
      name: "write_file",
      input: { path: "tests/x.test.ts", content: "tampered" },
    });
    expect(r.is_error).toBe(true);
    expect(r.content).toContain("REFUSED");
    expect(existsSync(join(repoRoot, "tests/x.test.ts"))).toBe(false);
  });

  it("read_file reads and errors honestly on absence", () => {
    writeFileSync(join(repoRoot, "src/y.ts"), "abc", "utf8");
    expect(
      executeBrewResubmitTool(repoRoot, { id: "a", name: "read_file", input: { path: "src/y.ts" } })
        .content
    ).toBe("abc");
    expect(
      executeBrewResubmitTool(repoRoot, { id: "b", name: "read_file", input: { path: "src/none.ts" } })
        .is_error
    ).toBe(true);
  });
});

function scriptedLlm(script: LlmResponse[]): LlmClient {
  let i = 0;
  return {
    complete: async (_args: LlmRequest) => {
      const r = script[Math.min(i, script.length - 1)]!;
      i++;
      return r;
    },
  };
}

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreateTokens: 0 };

describe("runResubmitAgent", () => {
  it("executes tool rounds, tracks edits, and returns the final summary", async () => {
    const llm = scriptedLlm([
      {
        text: "",
        toolUses: [{ id: "1", name: "write_file", input: { path: "src/fix.ts", content: "ok\n" } }],
        usage,
        costUsd: 0.01,
        model: "m",
      },
      { text: "- fixed the unbounded fetch", usage, costUsd: 0.01, model: "m" },
    ]);
    const out = await runResubmitAgent({ llm, model: "m", repoRoot, userPrompt: "go" });
    expect(out.editedPaths).toEqual(["src/fix.ts"]);
    expect(out.summary).toContain("unbounded fetch");
    expect(out.escalation).toBeNull();
    expect(out.rounds).toBe(2);
  });

  it("surfaces ESCALATE paragraphs as contract escalations", async () => {
    const llm = scriptedLlm([
      {
        text: "ESCALATE: the finding requires DELETE to return 404, but tests freeze 204 — PM must rule.",
        usage,
        costUsd: 0.01,
        model: "m",
      },
    ]);
    const out = await runResubmitAgent({ llm, model: "m", repoRoot, userPrompt: "go" });
    expect(out.editedPaths).toEqual([]);
    expect(out.escalation).toContain("PM must rule");
  });

  it("prompt carries spec, feedback, and diff sections", () => {
    const p = buildResubmitUserPrompt({
      prNumber: 240,
      storyId: "016",
      specYaml: "id: story-016",
      diff: "diff --git",
      feedback: [{ author: "amin", body: "add an index", createdAt: "2026-08-23" }],
      codeMapSlice: null,
    });
    expect(p).toContain("story-016");
    expect(p).toContain("@amin");
    expect(p).toContain("add an index");
    expect(p).toContain("diff --git");
  });
});
