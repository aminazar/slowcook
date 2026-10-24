import { describe, it, expect } from "vitest";
import type { LlmClient, LlmResponse } from "@slowcook-ai/core";
import type { CostEntry } from "../cost-store.js";
import { withLedger, ledgerRow } from "./ledger-client.js";

const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50, cacheCreateTokens: 10 };
const fake: LlmClient = {
  async complete(args) {
    return { text: "ok", usage, costUsd: 0, model: args.model } as LlmResponse;
  },
};

describe("withLedger", () => {
  it("appends exactly one row per complete(), with timing and tokens", async () => {
    const rows: Array<{ story: string; entry: CostEntry }> = [];
    let t = 0;
    const llm = withLedger(fake, {
      repoRoot: "/r",
      storyId: "007",
      agent: "taste",
      priceFor: () => 0.0123,
      append: (_root, story, entry) => rows.push({ story, entry }),
      now: () => new Date(1_700_000_000_000 + (t += 1000)),
    });
    await llm.complete({ system: "s", messages: [], model: "m" });
    await llm.complete({ system: "s", messages: [], model: "m" });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.story).toBe("007");
    const e = rows[0]!.entry;
    expect(e.agent).toBe("taste");
    expect(e.usd).toBe(0.0123);
    expect(e.tokens_in).toBe(1000);
    expect(e.cache_read).toBe(50);
    expect(e.round).toBe("call-1");
    expect(rows[1]!.entry.round).toBe("call-2");
    expect(new Date(e.finished_at!).getTime() - new Date(e.started_at!).getTime()).toBe(1000);
  });

  it("an unpriced model lands as usd: null, never 0", () => {
    const row = ledgerRow(
      { agent: "vibe", priceFor: () => null },
      { model: "claude-unknown", usage, round: "r", startedAt: new Date(0), finishedAt: new Date(1) }
    );
    expect(row.usd).toBeNull();
    expect(row.tokens_out).toBe(200);
  });

  it("a failing append never fails the call", async () => {
    const llm = withLedger(fake, {
      repoRoot: "/r",
      storyId: "1",
      agent: "x",
      priceFor: () => 1,
      append: () => { throw new Error("disk full"); },
    });
    await expect(llm.complete({ system: "s", messages: [], model: "m" })).resolves.toMatchObject({ text: "ok" });
  });
});
