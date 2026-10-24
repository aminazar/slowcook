import { describe, it, expect } from "vitest";
import { formatWallClock, haltReportToMarkdown, type HaltReport } from "./halt.js";

const base: HaltReport = {
  story_id: "007",
  halt_reason: "BUDGET_EXHAUSTED",
  halt_timestamp: "2026-10-24T10:00:00.000Z",
  iterations_run: 3,
  checkpoints_committed: 1,
  tests_green: 2,
  tests_total: 5,
  tokens_spent_usd: 1.5,
  budget_usd: 2,
  model: "claude-haiku-5-5",
  summary_plain_english: "ran out",
  suggested_actions: [{ id: "a", label: "A", description: "do a" }],
};

describe("halt report wall-clock (WP1)", () => {
  it("formats durations the way a human reads them", () => {
    expect(formatWallClock(42_000)).toBe("42s");
    expect(formatWallClock(12 * 60_000 + 5_000)).toBe("12m 05s");
    expect(formatWallClock(63 * 60_000)).toBe("1h 03m");
  });

  it("markdown carries wall-clock and run id when the report has them, and nothing extra otherwise", () => {
    const plain = haltReportToMarkdown(base);
    expect(plain).not.toContain("wall-clock");
    const timed = haltReportToMarkdown({ ...base, started_at: "2026-10-24T09:48:00.000Z", finished_at: base.halt_timestamp, wall_ms: 12 * 60_000, run_id: "exp1/007/swarm/1" });
    expect(timed).toContain("wall-clock 12m 00s");
    expect(timed).toContain("run `exp1/007/swarm/1`");
  });
});
