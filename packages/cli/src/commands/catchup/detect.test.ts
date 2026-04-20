import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { detectPipelineState, formatReport, type PipelineState } from "./detect.js";
import type {
  ForgeAdapter,
  Issue,
  PullRequestSummary,
  Comment,
} from "@slowcook-ai/core";

function mockForge(overrides: Partial<ForgeAdapter>): ForgeAdapter {
  const base = {
    repoSlug: "owner/repo",
    getIssue: async () => ({
      number: 0,
      title: "",
      body: "",
      author: "u",
      labels: [],
      state: "open" as const,
      url: "",
    }),
    listIssueComments: async () => [],
    createIssueComment: async () => ({} as Comment),
    addIssueLabels: async () => {},
    removeIssueLabel: async () => {},
    createPullRequest: async () => ({ number: 0, url: "", head_branch: "" }),
    git: {
      createBranch: async () => {},
      stage: async () => {},
      commit: async () => {},
      push: async () => {},
    },
    botUsername: async () => "github-actions[bot]",
    listBranchesMatching: async () => [],
    listIssuesByLabel: async () => [],
    findPullRequestByBranch: async () => null,
  };
  return { ...base, ...overrides } as ForgeAdapter;
}

function writeIndex(repoRoot: string, stories: Record<string, any>): void {
  mkdirSync(join(repoRoot, "specs"), { recursive: true });
  writeFileSync(
    join(repoRoot, "specs/_index.yaml"),
    YAML.stringify({ schema_version: 1, stories })
  );
}

describe("detectPipelineState", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "slowcook-catchup-"));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("reports everything clean when index is empty and no issues/PRs", async () => {
    writeIndex(repo, {});
    const forge = mockForge({});
    const state = await detectPipelineState(forge, repo);
    expect(state.pendingRefinements).toEqual([]);
    expect(state.pendingOnSpecMerged).toEqual([]);
    expect(state.pendingTestgen).toEqual([]);
  });

  describe("pendingRefinements", () => {
    it("flags a needs-refinement issue with no agent comments as MISSED TRIGGER", async () => {
      writeIndex(repo, {});
      const forge = mockForge({
        listIssuesByLabel: async (label) => {
          if (label !== "needs-refinement") return [];
          return [{
            number: 42,
            title: "refine me",
            body: "",
            author: "user",
            labels: ["needs-refinement"],
            state: "open",
            url: "",
          }];
        },
        listIssueComments: async () => [], // no comments at all
      });
      const state = await detectPipelineState(forge, repo);
      expect(state.pendingRefinements).toHaveLength(1);
      expect(state.pendingRefinements[0]?.hasAgentComments).toBe(false);
      expect(state.pendingRefinements[0]?.reason).toMatch(/missed/i);
    });

    it("surfaces an in-progress refinement differently (agent has commented)", async () => {
      writeIndex(repo, {});
      const forge = mockForge({
        listIssuesByLabel: async () => [{
          number: 42,
          title: "refine me",
          body: "",
          author: "user",
          labels: ["needs-refinement"],
          state: "open",
          url: "",
        }],
        listIssueComments: async () => [{
          id: 1,
          author: "github-actions[bot]",
          body: "### slowcook · refinement agent 🍲\n\nasking stuff",
          created_at: "2026-04-20T00:00:00Z",
          is_bot: true,
        }],
      });
      const state = await detectPipelineState(forge, repo);
      expect(state.pendingRefinements).toHaveLength(1);
      expect(state.pendingRefinements[0]?.hasAgentComments).toBe(true);
      expect(state.pendingRefinements[0]?.reason).toMatch(/in progress/i);
    });
  });

  describe("pendingOnSpecMerged", () => {
    it("flags an active story whose source issue hasn't transitioned to spec-ready", async () => {
      writeIndex(repo, {
        "001": { title: "t", status: "active", source_issue: "#15" },
      });
      const forge = mockForge({
        getIssue: async (n) => {
          if (n === 15) return {
            number: 15,
            title: "src issue",
            body: "",
            author: "u",
            labels: ["spec-submitted"],
            state: "open",
            url: "",
          };
          throw new Error("unexpected");
        },
        findPullRequestByBranch: async (branch) => {
          if (branch === "slowcook/spec/story-001") return {
            number: 99,
            title: "spec pr",
            state: "closed",
            merged: true,
            labels: ["slowcook-spec"],
            head_branch: branch,
            body: "",
            url: "",
          };
          return null;
        },
      });
      const state = await detectPipelineState(forge, repo);
      expect(state.pendingOnSpecMerged).toHaveLength(1);
      expect(state.pendingOnSpecMerged[0]?.storyId).toBe("001");
      expect(state.pendingOnSpecMerged[0]?.prNumber).toBe(99);
    });

    it("does NOT flag a story whose issue already has spec-ready", async () => {
      writeIndex(repo, {
        "001": { title: "t", status: "active", source_issue: "#15" },
      });
      const forge = mockForge({
        getIssue: async () => ({
          number: 15,
          title: "",
          body: "",
          author: "u",
          labels: ["spec-ready"],
          state: "open",
          url: "",
        }),
      });
      const state = await detectPipelineState(forge, repo);
      expect(state.pendingOnSpecMerged).toEqual([]);
    });

    it("skips superseded stories", async () => {
      writeIndex(repo, {
        "001": { title: "t", status: "superseded", source_issue: "#15" },
      });
      const forge = mockForge({});
      const state = await detectPipelineState(forge, repo);
      expect(state.pendingOnSpecMerged).toEqual([]);
    });

    it("skips stories whose spec PR is not actually merged (still open)", async () => {
      writeIndex(repo, {
        "001": { title: "t", status: "active", source_issue: "#15" },
      });
      const forge = mockForge({
        getIssue: async () => ({
          number: 15,
          title: "",
          body: "",
          author: "u",
          labels: ["spec-submitted"],
          state: "open",
          url: "",
        }),
        findPullRequestByBranch: async () => ({
          number: 99,
          title: "",
          state: "open",
          merged: false,
          labels: [],
          head_branch: "slowcook/spec/story-001",
          body: "",
          url: "",
        }),
      });
      const state = await detectPipelineState(forge, repo);
      expect(state.pendingOnSpecMerged).toEqual([]);
    });
  });

  describe("pendingTestgen", () => {
    it("flags active specs that lack tests/integration/story-N.test.ts", async () => {
      writeIndex(repo, {
        "001": { title: "first", status: "active" },
        "002": { title: "second", status: "active" },
      });
      const forge = mockForge({});
      const state = await detectPipelineState(forge, repo);
      expect(state.pendingTestgen).toHaveLength(2);
      expect(state.pendingTestgen.map((t) => t.storyId).sort()).toEqual(["001", "002"]);
    });

    it("skips specs that already have a test file", async () => {
      writeIndex(repo, {
        "001": { title: "first", status: "active" },
        "002": { title: "second", status: "active" },
      });
      mkdirSync(join(repo, "tests/integration"), { recursive: true });
      writeFileSync(join(repo, "tests/integration/story-001.test.ts"), "// exists");
      const forge = mockForge({});
      const state = await detectPipelineState(forge, repo);
      expect(state.pendingTestgen.map((t) => t.storyId)).toEqual(["002"]);
    });

    it("skips superseded specs", async () => {
      writeIndex(repo, {
        "001": { title: "first", status: "superseded", superseded_by: "003" },
        "002": { title: "second", status: "active" },
      });
      const forge = mockForge({});
      const state = await detectPipelineState(forge, repo);
      expect(state.pendingTestgen.map((t) => t.storyId)).toEqual(["002"]);
    });
  });
});

describe("formatReport", () => {
  it("renders an all-clean state", () => {
    const state: PipelineState = {
      pendingRefinements: [],
      pendingOnSpecMerged: [],
      pendingTestgen: [],
    };
    const out = formatReport(state);
    expect(out).toContain("Pending refinements");
    expect(out).toContain("(none)");
    expect(out).toContain("Pending on-spec-merged");
    expect(out).toContain("Pending testgen");
  });

  it("flags MISSED TRIGGER for refinements with no agent comments", () => {
    const state: PipelineState = {
      pendingRefinements: [
        { issueNumber: 42, title: "t", hasAgentComments: false, reason: "missed" },
      ],
      pendingOnSpecMerged: [],
      pendingTestgen: [],
    };
    const out = formatReport(state);
    expect(out).toContain("MISSED TRIGGER");
    expect(out).toContain("#42");
  });

  it("includes story IDs for testgen", () => {
    const state: PipelineState = {
      pendingRefinements: [],
      pendingOnSpecMerged: [],
      pendingTestgen: [
        { storyId: "003", title: "KYC relaxed", reason: "no tests" },
      ],
    };
    const out = formatReport(state);
    expect(out).toContain("story-003");
    expect(out).toContain("KYC relaxed");
  });
});
