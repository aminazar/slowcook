import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readIndex,
  writeIndex,
  readSpec,
  writeSpec,
  listActiveSpecs,
  nextStoryId,
  entryFromSpec,
} from "./spec-yaml.js";
import { makeEmptyIndex, type Spec } from "@slowcook-ai/core";

function mkSpec(id: string, status: Spec["status"] = "active"): Spec {
  return {
    $schema: "./spec.schema.json",
    story_id: id,
    title: `title-${id}`,
    status,
    created_at: "2026-04-20T00:00:00.000Z",
    supersedes: [],
    superseded_by: null,
    actors: [{ name: "member" }],
    preconditions: ["pre"],
    invariants: ["inv"],
    acceptance_scenarios: ["s1"],
    non_goals: ["ng"],
  };
}

describe("spec-yaml I/O", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "slowcook-specs-"));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  describe("index", () => {
    it("returns an empty index when the file is missing", () => {
      const idx = readIndex(repoRoot);
      expect(idx.schema_version).toBe(1);
      expect(idx.stories).toEqual({});
    });

    it("round-trips through write/read", () => {
      const idx = makeEmptyIndex();
      idx.stories["042"] = { title: "forty-two", status: "active" };
      writeIndex(repoRoot, idx);
      const back = readIndex(repoRoot);
      expect(back.stories["042"]).toMatchObject({ title: "forty-two", status: "active" });
    });

    it("throws on a malformed index", () => {
      mkdirSync(join(repoRoot, "specs"), { recursive: true });
      writeFileSync(join(repoRoot, "specs/_index.yaml"), "schema_version: 2\nstories: {}\n");
      expect(() => readIndex(repoRoot)).toThrow(/Invalid/);
    });
  });

  describe("specs", () => {
    it("writes and reads a spec file at specs/story-<id>.yaml", () => {
      const spec = mkSpec("042");
      const path = writeSpec(repoRoot, spec);
      expect(path).toContain("specs/story-042.yaml");
      const back = readSpec(repoRoot, "042");
      expect(back.story_id).toBe("042");
      expect(back.actors[0]?.name).toBe("member");
    });

    it("listActiveSpecs returns only status=active", () => {
      writeSpec(repoRoot, mkSpec("001", "active"));
      writeSpec(repoRoot, mkSpec("002", "superseded"));
      writeSpec(repoRoot, mkSpec("003", "active"));
      const active = listActiveSpecs(repoRoot);
      expect(active.map((s) => s.story_id).sort()).toEqual(["001", "003"]);
    });

    it("listActiveSpecs returns [] when specs dir doesn't exist", () => {
      expect(listActiveSpecs(repoRoot)).toEqual([]);
    });
  });

  describe("nextStoryId", () => {
    it("returns 001 on a fresh repo", async () => {
      expect(await nextStoryId(repoRoot)).toBe("001");
    });

    it("increments from the highest id in the index", async () => {
      const idx = makeEmptyIndex();
      idx.stories["007"] = { title: "seven", status: "active" };
      idx.stories["013"] = { title: "thirteen", status: "superseded" };
      idx.stories["042"] = { title: "forty-two", status: "active" };
      writeIndex(repoRoot, idx);
      expect(await nextStoryId(repoRoot)).toBe("043");
    });

    it("considers story FILES when no _index.yaml exists (brownfield repos)", async () => {
      // dash dogfood regression: 58 spec files, no index → refine allocated
      // "001" and overwrote a live spec. Files are ground truth.
      mkdirSync(join(repoRoot, "specs"), { recursive: true });
      writeFileSync(join(repoRoot, "specs", "story-001.yaml"), "story_id: '001'\n");
      writeFileSync(join(repoRoot, "specs", "story-058.yaml"), "story_id: '058'\n");
      expect(await nextStoryId(repoRoot)).toBe("059");
    });

    it("also considers remote branches matching slowcook/spec/story-*", async () => {
      // Index is empty; branch has story-007 in flight.
      const mockForge = {
        listBranchesMatching: async (_prefix: string) =>
          ["slowcook/spec/story-007", "some-other-branch"],
      } as unknown as import("@slowcook-ai/core").ForgeAdapter;
      expect(await nextStoryId(repoRoot, mockForge)).toBe("008");
    });

    it("unions index and branch ids, takes max+1", async () => {
      const idx = makeEmptyIndex();
      idx.stories["003"] = { title: "three", status: "active" };
      writeIndex(repoRoot, idx);
      const mockForge = {
        listBranchesMatching: async (_prefix: string) =>
          ["slowcook/spec/story-005", "slowcook/spec/story-001"],
      } as unknown as import("@slowcook-ai/core").ForgeAdapter;
      // max(3, 5, 1) + 1 = 6
      expect(await nextStoryId(repoRoot, mockForge)).toBe("006");
    });

    it("falls back to index-only if the forge call fails", async () => {
      const idx = makeEmptyIndex();
      idx.stories["042"] = { title: "forty-two", status: "active" };
      writeIndex(repoRoot, idx);
      const brokenForge = {
        listBranchesMatching: async () => {
          throw new Error("rate limited");
        },
      } as unknown as import("@slowcook-ai/core").ForgeAdapter;
      expect(await nextStoryId(repoRoot, brokenForge)).toBe("043");
    });
  });

  describe("entryFromSpec", () => {
    it("derives a summary from the first acceptance scenario", () => {
      const spec = mkSpec("042");
      spec.acceptance_scenarios = [
        "Given a member with 14 reactions, when they add a 15th, then ration shows 15/15",
      ];
      const entry = entryFromSpec(spec);
      expect(entry.title).toBe("title-042");
      expect(entry.status).toBe("active");
      expect(entry.summary).toMatch(/Given a member/);
    });
  });
});

// ── #236 regression: repo-local spec fields survive the round-trip ──
describe("repo-local field passthrough", () => {
  it("preserves fields outside the core schema (e.g. prd_ref) through parse", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "sy-pt-"));
    mkdirSync(join(repoRoot, "specs"), { recursive: true });
    const raw = [
      'story_id: "071"',
      "title: t",
      "status: active",
      "created_at: 2026-07-03T00:00:00.000Z",
      "supersedes: []",
      "superseded_by: null",
      "actors: []",
      "preconditions: []",
      "invariants: []",
      "acceptance_scenarios: []",
      "non_goals: []",
      "prd_ref:",
      "  file: docs/PRD.md",
      "  anchor: surface-billing",
      'epic: "Backend"',
    ].join("\n");
    writeFileSync(join(repoRoot, "specs", "story-071.yaml"), raw + "\n");
    const spec = readSpec(repoRoot, "071") as unknown as Record<string, unknown>;
    expect(spec.prd_ref).toEqual({ file: "docs/PRD.md", anchor: "surface-billing" });
    expect(spec.epic).toBe("Backend");
    rmSync(repoRoot, { recursive: true, force: true });
  });
});
