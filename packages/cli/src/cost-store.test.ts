import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import {
  appendCostEntry,
  readCostTotal,
  applyCostToSpec,
  costSidecarPath,
} from "./cost-store.js";

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "cost-store-test-"));
  mkdirSync(join(root, "specs"), { recursive: true });
  return root;
}

function writeSpec(repoRoot: string, storyId: string, body: Record<string, unknown> = {}): void {
  const base = {
    story_id: storyId,
    title: "test",
    status: "active",
    created_at: "2026-05-15T00:00:00Z",
    supersedes: [],
    superseded_by: null,
    actors: [],
    preconditions: [],
    invariants: [],
    acceptance_scenarios: [],
    non_goals: [],
    ...body,
  };
  writeFileSync(
    join(repoRoot, "specs", `story-${storyId}.yaml`),
    YAML.stringify(base, { lineWidth: 0 }),
    "utf8"
  );
}

describe("cost-store sidecar (sc#67)", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });

  it("appends entries as one JSON line each", () => {
    appendCostEntry(repo, "001", {
      agent: "refine",
      usd: 0.42,
      at: "2026-05-15T10:00:00Z",
    });
    appendCostEntry(repo, "001", {
      agent: "refine",
      usd: 0.18,
      at: "2026-05-15T10:01:00Z",
      model: "claude-opus-4-7",
      round: "questions",
    });
    const content = readFileSync(costSidecarPath(repo, "001"), "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).usd).toBe(0.42);
    expect(JSON.parse(lines[1]).round).toBe("questions");
  });

  it("creates the specs/ directory on first append", () => {
    const root = mkdtempSync(join(tmpdir(), "cost-store-fresh-"));
    appendCostEntry(root, "002", {
      agent: "vibe",
      usd: 0.01,
      at: "2026-05-15T11:00:00Z",
    });
    expect(existsSync(costSidecarPath(root, "002"))).toBe(true);
  });

  it("readCostTotal returns 0 + [] when sidecar missing", () => {
    const out = readCostTotal(repo, "missing");
    expect(out.totalUsd).toBe(0);
    expect(out.entries).toEqual([]);
  });

  it("readCostTotal sums entries and exposes them", () => {
    appendCostEntry(repo, "003", { agent: "refine", usd: 1.0, at: "t1" });
    appendCostEntry(repo, "003", { agent: "vibe", usd: 0.5, at: "t2" });
    appendCostEntry(repo, "003", { agent: "brew", usd: 2.25, at: "t3" });
    const { totalUsd, entries } = readCostTotal(repo, "003");
    expect(totalUsd).toBeCloseTo(3.75, 4);
    expect(entries.map((e) => e.agent)).toEqual(["refine", "vibe", "brew"]);
  });

  it("readCostTotal tolerates blank + malformed lines", () => {
    const p = costSidecarPath(repo, "004");
    mkdirSync(join(repo, "specs"), { recursive: true });
    writeFileSync(
      p,
      ['{"agent":"refine","usd":0.5,"at":"t1"}', "", "not-json", '{"agent":"vibe","usd":0.25,"at":"t2"}'].join("\n") + "\n",
      "utf8"
    );
    const malformed: number[] = [];
    const { totalUsd, entries } = readCostTotal(repo, "004", (n) => malformed.push(n));
    expect(totalUsd).toBeCloseTo(0.75, 4);
    expect(entries).toHaveLength(2);
    expect(malformed).toEqual([3]);
  });

  it("applyCostToSpec is a no-op when spec missing", () => {
    appendCostEntry(repo, "no-spec", { agent: "refine", usd: 1, at: "t" });
    const out = applyCostToSpec(repo, "no-spec");
    expect(out.changed).toBe(false);
  });

  it("applyCostToSpec writes cost.total_usd + last_updated when spec present", () => {
    writeSpec(repo, "005");
    appendCostEntry(repo, "005", { agent: "refine", usd: 0.97, at: "t1" });
    appendCostEntry(repo, "005", { agent: "refine", usd: 1.26, at: "t2" });
    const out = applyCostToSpec(repo, "005", "2026-05-15T12:00:00Z");
    expect(out.changed).toBe(true);
    expect(out.totalUsd).toBeCloseTo(2.23, 4);
    const reloaded = YAML.parse(
      readFileSync(join(repo, "specs", "story-005.yaml"), "utf8")
    );
    expect(reloaded.cost.total_usd).toBeCloseTo(2.23, 4);
    expect(reloaded.cost.last_updated).toBe("2026-05-15T12:00:00Z");
  });

  it("applyCostToSpec is a no-op when total + last_updated unchanged", () => {
    writeSpec(repo, "006", { cost: { total_usd: 0.5, last_updated: "frozen" } });
    appendCostEntry(repo, "006", { agent: "refine", usd: 0.5, at: "t1" });
    const out = applyCostToSpec(repo, "006");
    expect(out.changed).toBe(false);
  });

  it("rounds totals to 4 decimal places", () => {
    writeSpec(repo, "007");
    // 0.1 + 0.2 = 0.30000000000000004 in float
    appendCostEntry(repo, "007", { agent: "refine", usd: 0.1, at: "t1" });
    appendCostEntry(repo, "007", { agent: "vibe", usd: 0.2, at: "t2" });
    const out = applyCostToSpec(repo, "007");
    expect(out.totalUsd).toBe(0.3);
  });
});
