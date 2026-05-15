import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadBudgetConfig,
  currentPeriodStart,
  aggregateMonthSpend,
  aggregateSpendSince,
  classifyBudgetStatus,
  formatFuelGauge,
  formatCreditGauge,
  fuelGaugeFromRepo,
} from "./budget.js";
import { appendCostEntry } from "../cost-store.js";

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "budget-test-"));
  mkdirSync(join(root, "specs"), { recursive: true });
  mkdirSync(join(root, ".brewing"), { recursive: true });
  return root;
}

function writeBudget(repo: string, body: string): void {
  writeFileSync(join(repo, ".brewing", "budget.yaml"), body, "utf8");
}

describe("budget config (sc#66)", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });

  it("returns null when budget.yaml absent (opt-in)", () => {
    expect(loadBudgetConfig(repo)).toBe(null);
  });

  it("parses a valid config", () => {
    writeBudget(repo, "schema_version: 1\nmonthly_budget_usd: 50\nmonthly_start_day: 1\n");
    expect(loadBudgetConfig(repo)).toEqual({
      schema_version: 1,
      monthly_budget_usd: 50,
      monthly_start_day: 1,
    });
  });

  it("parses a credit-only config", () => {
    writeBudget(
      repo,
      "schema_version: 1\ncredit_balance_usd: 25\ncredit_baseline_at: 2026-05-15T00:00:00Z\n"
    );
    expect(loadBudgetConfig(repo)).toEqual({
      schema_version: 1,
      monthly_start_day: 1,
      credit_balance_usd: 25,
      credit_baseline_at: "2026-05-15T00:00:00Z",
    });
  });

  it("defaults monthly_start_day to 1 when omitted", () => {
    writeBudget(repo, "schema_version: 1\nmonthly_budget_usd: 25\n");
    expect(loadBudgetConfig(repo)?.monthly_start_day).toBe(1);
  });

  it("rejects malformed config loudly", () => {
    writeBudget(repo, "schema_version: 2\nmonthly_budget_usd: 50\n");
    expect(() => loadBudgetConfig(repo)).toThrow();
  });

  it("rejects negative budgets", () => {
    writeBudget(repo, "schema_version: 1\nmonthly_budget_usd: -1\n");
    expect(() => loadBudgetConfig(repo)).toThrow();
  });

  it("rejects config with neither monthly nor credit set", () => {
    writeBudget(repo, "schema_version: 1\nmonthly_start_day: 1\n");
    expect(() => loadBudgetConfig(repo)).toThrow();
  });
});

describe("currentPeriodStart", () => {
  it("returns this month's reset day when today is on or after it", () => {
    const out = currentPeriodStart({ monthly_start_day: 5 }, new Date("2026-05-15T12:00:00Z"));
    expect(out.toISOString()).toBe("2026-05-05T00:00:00.000Z");
  });
  it("returns last month's reset day when today is before this month's", () => {
    const out = currentPeriodStart({ monthly_start_day: 20 }, new Date("2026-05-15T12:00:00Z"));
    expect(out.toISOString()).toBe("2026-04-20T00:00:00.000Z");
  });
});

describe("aggregateMonthSpend", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });

  it("returns 0 when no sidecars exist", () => {
    const out = aggregateMonthSpend(
      repo,
      { schema_version: 1, monthly_budget_usd: 50, monthly_start_day: 1 },
      new Date("2026-05-15T12:00:00Z")
    );
    expect(out).toEqual({ usd: 0, entryCount: 0, storyCount: 0 });
  });

  it("sums entries from this period across stories", () => {
    appendCostEntry(repo, "001", { agent: "refine", usd: 1.0, at: "2026-05-10T00:00:00Z" });
    appendCostEntry(repo, "001", { agent: "vibe", usd: 0.5, at: "2026-05-12T00:00:00Z" });
    appendCostEntry(repo, "002", { agent: "refine", usd: 2.0, at: "2026-05-14T00:00:00Z" });
    const out = aggregateMonthSpend(
      repo,
      { schema_version: 1, monthly_budget_usd: 50, monthly_start_day: 1 },
      new Date("2026-05-15T12:00:00Z")
    );
    expect(out.usd).toBeCloseTo(3.5, 4);
    expect(out.entryCount).toBe(3);
    expect(out.storyCount).toBe(2);
  });

  it("excludes entries from before the period start", () => {
    appendCostEntry(repo, "001", { agent: "refine", usd: 100, at: "2026-04-15T00:00:00Z" });
    appendCostEntry(repo, "001", { agent: "refine", usd: 1, at: "2026-05-10T00:00:00Z" });
    const out = aggregateMonthSpend(
      repo,
      { schema_version: 1, monthly_budget_usd: 50, monthly_start_day: 1 },
      new Date("2026-05-15T12:00:00Z")
    );
    expect(out.usd).toBeCloseTo(1, 4);
    expect(out.entryCount).toBe(1);
  });
});

describe("classifyBudgetStatus", () => {
  it("ok under 80%", () => {
    expect(classifyBudgetStatus(39, 50)).toBe("ok");
  });
  it("warn at 80%", () => {
    expect(classifyBudgetStatus(40, 50)).toBe("warn");
  });
  it("warn 80-95%", () => {
    expect(classifyBudgetStatus(45, 50)).toBe("warn");
  });
  it("halt at 95%", () => {
    expect(classifyBudgetStatus(47.5, 50)).toBe("halt");
  });
  it("halt over budget", () => {
    expect(classifyBudgetStatus(75, 50)).toBe("halt");
  });
  it("ok when budget is zero (defensive)", () => {
    expect(classifyBudgetStatus(1, 0)).toBe("ok");
  });
});

describe("formatFuelGauge", () => {
  it("renders ok status without warning text", () => {
    const md = formatFuelGauge({ currentUsd: 10, budgetUsd: 50 });
    expect(md).toContain("⛽");
    expect(md).toContain("$10.00 of $50.00");
    expect(md).toContain("(20%)");
    expect(md).not.toContain("⚠️");
    expect(md).not.toContain("🛑");
  });

  it("renders warn at 80% with fuel GIF", () => {
    const md = formatFuelGauge({ currentUsd: 42, budgetUsd: 50 });
    expect(md).toContain("⚠️ approaching monthly budget");
    expect(md).toContain("![fuel low]");
    expect(md).toContain("giphy.com");
  });

  it("renders halt at 95% with stop sign", () => {
    const md = formatFuelGauge({ currentUsd: 49, budgetUsd: 50 });
    expect(md).toContain("🛑");
    expect(md).toContain("override-budget");
    expect(md).toContain("![fuel empty]");
  });

  it("empty string when budget <= 0", () => {
    expect(formatFuelGauge({ currentUsd: 5, budgetUsd: 0 })).toBe("");
  });
});

describe("fuelGaugeFromRepo (end-to-end)", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });

  it("returns empty string when no budget.yaml exists", () => {
    expect(fuelGaugeFromRepo(repo)).toBe("");
  });

  it("renders the gauge when budget.yaml + sidecar present", () => {
    writeBudget(repo, "schema_version: 1\nmonthly_budget_usd: 50\nmonthly_start_day: 1\n");
    appendCostEntry(repo, "001", { agent: "refine", usd: 42, at: "2026-05-10T00:00:00Z" });
    const md = fuelGaugeFromRepo(repo, new Date("2026-05-15T12:00:00Z"));
    expect(md).toContain("$42.00 of $50.00");
    expect(md).toContain("⚠️");
  });

  it("renders the credit gauge when credit_balance set", () => {
    writeBudget(
      repo,
      "schema_version: 1\ncredit_balance_usd: 25\ncredit_baseline_at: 2026-05-01T00:00:00Z\n"
    );
    appendCostEntry(repo, "001", { agent: "refine", usd: 21, at: "2026-05-10T00:00:00Z" });
    const md = fuelGaugeFromRepo(repo, new Date("2026-05-15T12:00:00Z"));
    expect(md).toContain("🪙");
    expect(md).toContain("$4.00 of $25.00 remaining");
    expect(md).toContain("⚠️");
  });

  it("renders both gauges when both fields set", () => {
    writeBudget(
      repo,
      "schema_version: 1\nmonthly_budget_usd: 50\ncredit_balance_usd: 25\ncredit_baseline_at: 2026-05-01T00:00:00Z\n"
    );
    appendCostEntry(repo, "001", { agent: "refine", usd: 5, at: "2026-05-10T00:00:00Z" });
    const md = fuelGaugeFromRepo(repo, new Date("2026-05-15T12:00:00Z"));
    expect(md).toContain("⛽");
    expect(md).toContain("🪙");
  });
});

describe("formatCreditGauge", () => {
  it("renders ok status (no warning)", () => {
    const md = formatCreditGauge({
      depositUsd: 25,
      spentUsd: 5,
      baselineAt: "2026-05-01T00:00:00Z",
    });
    expect(md).toContain("$20.00 of $25.00 remaining");
    expect(md).toContain("(80%)");
    expect(md).not.toContain("⚠️");
    expect(md).not.toContain("🛑");
  });

  it("renders warn at 80% with fuel gif", () => {
    const md = formatCreditGauge({
      depositUsd: 25,
      spentUsd: 20,
      baselineAt: "2026-05-01T00:00:00Z",
    });
    expect(md).toContain("$5.00 of $25.00 remaining");
    expect(md).toContain("⚠️");
    expect(md).toContain("approaching empty");
    expect(md).toContain("console.anthropic.com");
  });

  it("renders halt at 95%", () => {
    const md = formatCreditGauge({
      depositUsd: 25,
      spentUsd: 24,
      baselineAt: "2026-05-01T00:00:00Z",
    });
    expect(md).toContain("🛑");
    expect(md).toContain("402");
  });

  it("clamps remaining to 0 when overspent", () => {
    const md = formatCreditGauge({
      depositUsd: 25,
      spentUsd: 30,
      baselineAt: "2026-05-01T00:00:00Z",
    });
    expect(md).toContain("$0.00 of $25.00 remaining");
  });
});

describe("aggregateSpendSince", () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "agg-since-")) ;
    mkdirSync(join(repo, "specs"), { recursive: true });
  });

  it("sums entries from arbitrary baseline (not period-bound)", () => {
    appendCostEntry(repo, "001", { agent: "refine", usd: 5, at: "2026-04-01T00:00:00Z" });
    appendCostEntry(repo, "001", { agent: "refine", usd: 3, at: "2026-05-10T00:00:00Z" });
    appendCostEntry(repo, "002", { agent: "vibe", usd: 7, at: "2026-05-12T00:00:00Z" });
    const out = aggregateSpendSince(repo, new Date("2026-05-01T00:00:00Z"));
    expect(out.usd).toBeCloseTo(10, 4);
    expect(out.storyCount).toBe(2);
  });
});
