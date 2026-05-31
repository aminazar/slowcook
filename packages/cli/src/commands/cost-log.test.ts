import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { costLogCore, parseCostLogArgs } from "./cost-log.js";

describe("parseCostLogArgs", () => {
  it("extracts all supported flags", () => {
    const args = parseCostLogArgs([
      "--story", "009",
      "--usd", "0.4234",
      "--agent", "local-claude-pipeline",
      "--model", "claude-opus-4-7",
      "--source-url", "https://github.com/x/y/pull/1",
      "--round", "brew-iter-3",
      "--tokens-in", "12000",
      "--tokens-out", "1500",
      "--cache-read", "85000",
      "--cache-create", "12000",
      "--apply-to-spec",
    ]);
    expect(args).toMatchObject({
      storyId: "009",
      usd: 0.4234,
      agent: "local-claude-pipeline",
      model: "claude-opus-4-7",
      sourceUrl: "https://github.com/x/y/pull/1",
      round: "brew-iter-3",
      tokensIn: 12000,
      tokensOut: 1500,
      cacheRead: 85000,
      cacheCreate: 12000,
      applyToSpec: true,
      help: false,
    });
  });

  it("defaults applyToSpec=false and help=false", () => {
    const args = parseCostLogArgs(["--story", "009", "--usd", "0.5", "--agent", "x"]);
    expect(args.applyToSpec).toBe(false);
    expect(args.help).toBe(false);
  });

  it("recognises --help and -h", () => {
    expect(parseCostLogArgs(["--help"]).help).toBe(true);
    expect(parseCostLogArgs(["-h"]).help).toBe(true);
  });

  it("ignores unknown flags rather than throwing", () => {
    const args = parseCostLogArgs(["--story", "009", "--usd", "0.5", "--agent", "x", "--unknown", "value"]);
    expect(args.storyId).toBe("009");
    expect(args.usd).toBe(0.5);
  });
});

describe("costLogCore — sidecar append", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "slowcook-cost-log-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends a JSONL entry to specs/story-<id>.cost.jsonl", () => {
    const result = costLogCore({
      repoRoot: tmpDir,
      storyId: "009",
      entry: {
        agent: "local-claude-pipeline",
        usd: 0.42,
        model: "claude-opus-4-7",
        at: "2026-05-31T10:00:00.000Z",
      },
      applyToSpec: false,
    });

    expect(existsSync(result.sidecarPath)).toBe(true);
    const body = readFileSync(result.sidecarPath, "utf8");
    expect(body.trim().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(body.trim());
    expect(parsed.agent).toBe("local-claude-pipeline");
    expect(parsed.usd).toBe(0.42);
    expect(parsed.model).toBe("claude-opus-4-7");
  });

  it("appends multiple entries without overwriting", () => {
    costLogCore({
      repoRoot: tmpDir,
      storyId: "009",
      entry: { agent: "a1", usd: 0.1, at: "2026-05-31T10:00:00Z" },
      applyToSpec: false,
    });
    costLogCore({
      repoRoot: tmpDir,
      storyId: "009",
      entry: { agent: "a2", usd: 0.2, at: "2026-05-31T11:00:00Z" },
      applyToSpec: false,
    });

    const sidecar = readFileSync(
      join(tmpDir, "specs/story-009.cost.jsonl"),
      "utf8"
    );
    const lines = sidecar.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).agent).toBe("a1");
    expect(JSON.parse(lines[1]!).agent).toBe("a2");
  });

  it("optionally applies cost to spec when --apply-to-spec is set", () => {
    // Pre-create a minimal spec yaml so applyCostToSpec has something to update.
    mkdirSync(join(tmpDir, "specs"), { recursive: true });
    writeFileSync(
      join(tmpDir, "specs/story-009.yaml"),
      `story_id: "009"
title: test
status: active
created_at: 2026-05-31T00:00:00Z
supersedes: []
superseded_by: null
actors: []
preconditions: []
invariants: []
acceptance_scenarios: []
non_goals: []
cost:
  total_usd: 0
  last_updated: 2026-05-31T00:00:00Z
`,
      "utf8"
    );

    const result = costLogCore({
      repoRoot: tmpDir,
      storyId: "009",
      entry: { agent: "local", usd: 0.42, at: "2026-05-31T12:00:00Z" },
      applyToSpec: true,
    });

    expect(result.appliedToSpec).toBe(true);
    const specBody = readFileSync(join(tmpDir, "specs/story-009.yaml"), "utf8");
    expect(specBody).toContain("total_usd: 0.42");
  });
});
