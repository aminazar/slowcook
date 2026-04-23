import { describe, it, expect } from "vitest";
import { costMarker, parseCostMarkers, costUsdForUsage } from "./pricing.js";

describe("costMarker", () => {
  it("renders the required fields", () => {
    const m = costMarker({ agent: "refine", usd: 0.0234 });
    expect(m).toContain("<!-- slowcook:cost");
    expect(m).toContain("agent=refine");
    expect(m).toContain("usd=0.0234");
    expect(m).toContain("-->");
  });

  it("includes optional fields when provided", () => {
    const m = costMarker({
      agent: "brew",
      usd: 1.5,
      tokensIn: 12345,
      tokensOut: 6789,
      cacheRead: 8000,
      cacheCreate: 2000,
      model: "claude-sonnet-4-6",
      round: 3,
    });
    expect(m).toContain("tokens_in=12345");
    expect(m).toContain("tokens_out=6789");
    expect(m).toContain("cache_read=8000");
    expect(m).toContain("cache_create=2000");
    expect(m).toContain("model=claude-sonnet-4-6");
    expect(m).toContain("round=3");
  });

  it("omits optional fields when absent", () => {
    const m = costMarker({ agent: "testgen", usd: 0.08 });
    expect(m).not.toContain("tokens_in=");
    expect(m).not.toContain("model=");
  });
});

describe("parseCostMarkers", () => {
  it("parses a single marker from a comment body", () => {
    const body =
      "### slowcook · brew opened\n\nBody text.\n\n<!-- slowcook:cost agent=brew usd=0.35 iterations=3 model=claude-sonnet-4-6 -->";
    const parsed = parseCostMarkers(body);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      agent: "brew",
      usd: 0.35,
      model: "claude-sonnet-4-6",
    });
  });

  it("parses multiple markers from a body", () => {
    const body =
      "<!-- slowcook:cost agent=refine usd=0.02 round=1 -->\nmore\n<!-- slowcook:cost agent=refine usd=0.03 round=2 -->";
    const parsed = parseCostMarkers(body);
    expect(parsed.map((m) => m.round)).toEqual(["1", "2"]);
    expect(parsed.reduce((a, b) => a + b.usd, 0)).toBeCloseTo(0.05);
  });

  it("returns empty when no markers present", () => {
    expect(parseCostMarkers("nothing here")).toEqual([]);
    expect(parseCostMarkers("")).toEqual([]);
  });

  it("ignores malformed markers missing usd or agent", () => {
    const body =
      "<!-- slowcook:cost usd=0.5 -->\n<!-- slowcook:cost agent=brew -->\n<!-- slowcook:cost agent=brew usd=0.1 -->";
    const parsed = parseCostMarkers(body);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.agent).toBe("brew");
  });

  it("parses numeric fields into numbers", () => {
    const body =
      "<!-- slowcook:cost agent=testgen usd=0.08 tokens_in=1000 tokens_out=500 cache_read=800 cache_create=200 -->";
    const parsed = parseCostMarkers(body);
    expect(parsed[0]).toMatchObject({
      usd: 0.08,
      tokensIn: 1000,
      tokensOut: 500,
      cacheRead: 800,
      cacheCreate: 200,
    });
  });
});

describe("costUsdForUsage", () => {
  it("computes cost for a known model", () => {
    const cost = costUsdForUsage("claude-sonnet-4-6", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    });
    expect(cost).toBeCloseTo(3);
  });

  it("prices cache reads at ~10% of input", () => {
    const cost = costUsdForUsage("claude-sonnet-4-6", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreateTokens: 0,
    });
    expect(cost).toBeCloseTo(0.3);
  });

  it("prices cache creates at ~125% of input", () => {
    const cost = costUsdForUsage("claude-sonnet-4-6", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(3.75);
  });

  it("returns 0 for an unknown model (no pricing table entry)", () => {
    expect(
      costUsdForUsage("some-other-provider/model", {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      })
    ).toBe(0);
  });

  it("matches by prefix (e.g., model id with date suffix)", () => {
    const cost = costUsdForUsage("claude-sonnet-4-6-20260101", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
    });
    expect(cost).toBeCloseTo(3);
  });
});
