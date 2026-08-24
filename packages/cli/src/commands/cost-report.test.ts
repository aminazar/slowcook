import { describe, it, expect } from "vitest";
import { aggregateStory, storiesWithSidecars } from "./cost-report.js";
import type { CostEntry } from "../cost-store.js";

const e = (over: Partial<CostEntry>): CostEntry => ({
  agent: "brew",
  usd: 1,
  at: "2026-08-24T00:00:00Z",
  ...over,
});

describe("aggregateStory", () => {
  it("rolls up per agent and per model", () => {
    const got = aggregateStory(
      "017",
      [
        e({ agent: "refine", usd: 0.5, model: "claude-opus-4-8" }),
        e({ agent: "brew", usd: 2, model: "claude-sonnet-5" }),
        e({ agent: "brew", usd: 3.18, model: "claude-sonnet-5" }),
      ],
      0
    );
    expect(got.totalUsd).toBeCloseTo(5.68);
    expect(got.byAgent).toEqual({ refine: 0.5, brew: 5.18 });
    expect(got.byModel).toEqual({ "claude-opus-4-8": 0.5, "claude-sonnet-5": 5.18 });
  });

  it("unpriced entries sum as 0 but are carried as a count — never presented as free", () => {
    const got = aggregateStory("x", [e({ usd: null }), e({ usd: 1 })], 1);
    expect(got.totalUsd).toBe(1);
    expect(got.unpriced).toBe(1);
  });

  it("missing model buckets as (unrecorded)", () => {
    const got = aggregateStory("x", [e({ model: undefined })], 0);
    expect(Object.keys(got.byModel)).toEqual(["(unrecorded)"]);
  });
});

describe("storiesWithSidecars", () => {
  it("extracts sorted story ids from sidecar filenames only", () => {
    expect(
      storiesWithSidecars([
        "story-017.cost.jsonl",
        "story-016.cost.jsonl",
        "story-016.yaml",
        "_index.yaml",
        "story-019.cost.jsonl",
      ])
    ).toEqual(["016", "017", "019"]);
  });
});
