import { describe, it, expect } from "vitest";
import { pickLaneJobs, ensureLane, LANES_DIR } from "./lanes.js";
import type { WorkerJob } from "./plan.js";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function job(over: Partial<WorkerJob>): WorkerJob {
  return {
    issue: 1,
    issueTitle: "t",
    agent: "recipe",
    triggerLabel: "agent:recipe",
    cmd: ["slowcook", "recipe"],
    preconditions: [],
    runnable: true,
    ...over,
  } as WorkerJob;
}

const enable = new Set(["refine", "recipe", "brew", "taste"]);

describe("pickLaneJobs", () => {
  it("fills lanes with runnable enabled jobs on distinct stories", () => {
    const picked = pickLaneJobs(
      [
        job({ issue: 1, storyId: "016", agent: "recipe" }),
        job({ issue: 2, storyId: "017", agent: "recipe" }),
        job({ issue: 3, storyId: "018", agent: "recipe" }),
      ],
      enable,
      2
    );
    expect(picked.map((j) => j.issue)).toEqual([1, 2]);
  });

  it("never runs two jobs on one story", () => {
    const picked = pickLaneJobs(
      [
        job({ issue: 1, storyId: "016", agent: "recipe" }),
        job({ issue: 2, storyId: "016", agent: "taste" }),
        job({ issue: 3, storyId: "017", agent: "recipe" }),
      ],
      enable,
      3
    );
    expect(picked.map((j) => j.issue)).toEqual([1, 3]);
  });

  it("caps db-touching jobs at ONE per pass and puts it first (main checkout)", () => {
    const picked = pickLaneJobs(
      [
        job({ issue: 1, storyId: "016", agent: "recipe" }),
        job({ issue: 2, storyId: "017", agent: "brew" }),
        job({ issue: 3, storyId: "018", agent: "brew" }),
      ],
      enable,
      3
    );
    expect(picked.map((j) => j.agent)).toEqual(["brew", "recipe"]);
    expect(picked[0]!.issue).toBe(2);
  });

  it("skips non-runnable and disabled jobs", () => {
    const picked = pickLaneJobs(
      [
        job({ issue: 1, storyId: "016", runnable: false }),
        job({ issue: 2, storyId: "017", agent: "eye" }),
        job({ issue: 3, storyId: "018" }),
      ],
      new Set(["recipe"]),
      3
    );
    expect(picked.map((j) => j.issue)).toEqual([3]);
  });
});

describe("ensureLane", () => {
  it("lane 0 is the main checkout, untouched", () => {
    const calls: string[] = [];
    const root = mkdtempSync(join(tmpdir(), "lane-"));
    const got = ensureLane(root, 0, "main", (cmd) => {
      calls.push(cmd);
      return "";
    });
    expect(got).toBe(root);
    expect(calls).toEqual([]);
  });

  it("creates a fresh worktree lane and symlinks node_modules", () => {
    const root = mkdtempSync(join(tmpdir(), "lane-"));
    mkdirSync(join(root, "node_modules"), { recursive: true });
    const calls: Array<{ cmd: string; cwd: string }> = [];
    const lanePath = ensureLane(root, 2, "main", (cmd, cwd) => {
      calls.push({ cmd, cwd });
      if (cmd.startsWith("git worktree add")) {
        mkdirSync(join(root, LANES_DIR, "lane-2", ".git"), { recursive: true });
      }
      return "";
    });
    expect(lanePath).toBe(join(root, LANES_DIR, "lane-2"));
    expect(calls.some((c) => c.cmd.startsWith("git fetch origin"))).toBe(true);
    expect(calls.some((c) => c.cmd.startsWith("git worktree add"))).toBe(true);
    expect(lstatSync(join(lanePath, "node_modules")).isSymbolicLink()).toBe(true);
  });

  it("reuses an existing lane via fetch + hard reset + clean", () => {
    const root = mkdtempSync(join(tmpdir(), "lane-"));
    mkdirSync(join(root, LANES_DIR, "lane-1", ".git"), { recursive: true });
    const calls: Array<{ cmd: string; cwd: string }> = [];
    ensureLane(root, 1, "main", (cmd, cwd) => {
      calls.push({ cmd, cwd });
      return "";
    });
    const lane = join(root, LANES_DIR, "lane-1");
    expect(calls.some((c) => c.cmd.includes("reset --hard") && c.cwd === lane)).toBe(true);
    expect(calls.some((c) => c.cmd.includes("clean -fd") && c.cwd === lane)).toBe(true);
    expect(calls.some((c) => c.cmd.startsWith("git worktree add"))).toBe(false);
  });
});
