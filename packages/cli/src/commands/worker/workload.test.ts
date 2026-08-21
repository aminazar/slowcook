import { describe, it, expect } from "vitest";
import { renderWorkloadView } from "./workload.js";
import type { WorkerJob } from "./plan.js";

const job = (over: Partial<WorkerJob>): WorkerJob => ({
  issue: 215,
  issueTitle: "t",
  agent: "brew",
  triggerLabel: "agent:brew",
  storyId: "019",
  cmd: ["slowcook", "brew", "--story", "019"],
  preconditions: [
    { name: "reciped-label", status: "fail", upstream: "recipe", detail: "issue lacks agent:reciped" },
  ],
  runnable: false,
  priority: 15,
  ...over,
});

describe("renderWorkloadView (D5)", () => {
  it("prints jobs by priority with named preconditions and the next runnable", () => {
    const out = renderWorkloadView({
      identity: "slowcook-agent-reworthy[bot]",
      checkoutLine: "checkout: main @ abc123def (matches origin/main)",
      issues: [],
      jobs: [
        job({}),
        job({ issue: 226, agent: "taste", priority: 5, runnable: true, preconditions: [
          { name: "pr-open", status: "pass", detail: "PR #226 open, unreviewed" },
        ], cmd: ["slowcook", "taste", "--pr", "226", "--merge"] }),
      ],
    });
    expect(out).toContain("identity: slowcook-agent-reworthy[bot]");
    const tasteIdx = out.indexOf("taste · #226");
    const brewIdx = out.indexOf("brew · #215");
    expect(tasteIdx).toBeGreaterThan(-1);
    expect(brewIdx).toBeGreaterThan(tasteIdx); // priority order
    expect(out).toContain("✗ reciped-label (upstream: recipe): issue lacks agent:reciped");
    expect(out).toContain("✓ pr-open: PR #226 open, unreviewed");
    expect(out).toContain("next pass runs: taste · #226 (story-019)");
  });

  it("empty workload says so", () => {
    const out = renderWorkloadView({ identity: "x", checkoutLine: "checkout: y", issues: [], jobs: [] });
    expect(out).toContain("no jobs derived");
    expect(out).toContain("next pass runs: nothing");
  });
});
