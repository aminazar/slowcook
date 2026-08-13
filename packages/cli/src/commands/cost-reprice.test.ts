// `cost reprice` + the never-silent-zero contract (dovizir handover §2).
//
// The bug it locks out: a refine run logged
//   {"agent":"refine","usd":0,"model":"claude-opus-5","tokens_out":3519}
// — tokens counted, dollars zero, because the model was missing from the
// pricing table. Zero is indistinguishable from a free call, so budgets lied.
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCostEntry, readCostTotal, repriceEntries, writeCostEntries } from "../cost-store.js";
import { parseRepriceArgs, storiesWithSidecars } from "./cost-reprice.js";

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "sc-reprice-"));
  mkdirSync(join(repo, "specs"), { recursive: true });
});

describe("the ledger records unknown, not free", () => {
  it("a null-usd entry survives the round-trip instead of being dropped as malformed", () => {
    appendCostEntry(repo, "001", { agent: "refine", usd: null, model: "claude-opus-5", at: "2026-08-13T00:00:00Z", tokens_in: 1000, tokens_out: 3519 });
    const { entries, totalUsd, unpricedCount } = readCostTotal(repo, "001");
    expect(entries).toHaveLength(1);   // the old `typeof usd !== "number"` guard ATE this line
    expect(entries[0]!.usd).toBeNull();
    expect(totalUsd).toBe(0);
    expect(unpricedCount).toBe(1);
  });

  it("a genuinely malformed line is still rejected", () => {
    const p = join(repo, "specs", "story-002.cost.jsonl");
    writeFileSync(p, '{"agent":"refine","usd":"free"}\n{"usd":1}\n', "utf8");
    const bad: number[] = [];
    const { entries } = readCostTotal(repo, "002", (n) => bad.push(n));
    expect(entries).toHaveLength(0);
    expect(bad).toEqual([1, 2]);
  });
});

describe("repriceEntries", () => {
  const priceFor = (model: string, u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number }) =>
    model === "claude-opus-5" ? (u.inputTokens / 1e6) * 5 + (u.outputTokens / 1e6) * 25 : null;

  it("settles an unpriced entry from its stored tokens — the whole point of recording them", () => {
    const entries = [{ agent: "refine", usd: null, model: "claude-opus-5", at: "t1", tokens_in: 1_000_000, tokens_out: 1_000_000 }];
    const { entries: out, changed } = repriceEntries(entries, priceFor);
    expect(out[0]!.usd).toBe(30);
    expect(changed).toEqual([{ at: "t1", model: "claude-opus-5", from: null, to: 30 }]);
  });

  it("leaves entries alone when the price is unchanged", () => {
    const entries = [{ agent: "refine", usd: 30, model: "claude-opus-5", at: "t1", tokens_in: 1_000_000, tokens_out: 1_000_000 }];
    const { changed } = repriceEntries(entries, priceFor);
    expect(changed).toHaveLength(0);
  });

  it("a still-unpriced model stays null — never coerced back to 0", () => {
    const entries = [{ agent: "brew", usd: null, model: "some-future-model", at: "t2", tokens_in: 10, tokens_out: 10 }];
    const { entries: out } = repriceEntries(entries, priceFor);
    expect(out[0]!.usd).toBeNull();
  });

  it("an entry with no token record is untouched (nothing to recompute from)", () => {
    const entries = [{ agent: "local-claude", usd: 0.42, at: "t3" }];
    const { entries: out, changed } = repriceEntries(entries, priceFor);
    expect(out[0]!.usd).toBe(0.42);
    expect(changed).toHaveLength(0);
  });

  it("round-trips through the sidecar", () => {
    appendCostEntry(repo, "003", { agent: "refine", usd: null, model: "claude-opus-5", at: "t1", tokens_in: 1_000_000, tokens_out: 1_000_000 });
    const { entries } = readCostTotal(repo, "003");
    const { entries: next } = repriceEntries(entries, priceFor);
    writeCostEntries(repo, "003", next);
    expect(readCostTotal(repo, "003").totalUsd).toBe(30);
    expect(readFileSync(join(repo, "specs", "story-003.cost.jsonl"), "utf8").endsWith("\n")).toBe(true);
  });
});

describe("cli surface", () => {
  it("parses flags", () => {
    expect(parseRepriceArgs(["--story", "001"])).toEqual({ story: "001" });
    expect(parseRepriceArgs(["--all", "--dry-run"])).toEqual({ all: true, dryRun: true });
  });

  it("discovers stories that have sidecars", () => {
    appendCostEntry(repo, "010", { agent: "a", usd: 1, at: "t" });
    appendCostEntry(repo, "002", { agent: "a", usd: 1, at: "t" });
    writeFileSync(join(repo, "specs", "story-003.yaml"), "story_id: '003'\n", "utf8"); // no sidecar
    expect(storiesWithSidecars(repo)).toEqual(["002", "010"]);
  });
});
