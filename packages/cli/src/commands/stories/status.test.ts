import { describe, it, expect } from "vitest";
import type { SpecIndex } from "@slowcook-ai/core";
import {
  buildStoriesStatus,
  renderStoriesStatusTable,
  type PullRequestFact,
} from "./status.js";

function index(stories: Record<string, { title: string; status?: "draft" | "active" | "superseded"; source_issue?: string }>): SpecIndex {
  const out: SpecIndex = { schema_version: 1, stories: {} };
  for (const [k, v] of Object.entries(stories)) {
    out.stories[k] = {
      title: v.title,
      status: v.status ?? "active",
      source_issue: v.source_issue,
      supersedes: [],
      superseded_by: null,
    };
  }
  return out;
}

function pr(opts: Partial<PullRequestFact> & { number: number }): PullRequestFact {
  return {
    number: opts.number,
    title: opts.title ?? "",
    labels: opts.labels ?? [],
    headBranch: opts.headBranch ?? "",
    state: opts.state ?? "open",
    merged: opts.merged ?? false,
  };
}

describe("buildStoriesStatus — sc#146 #6", () => {
  it("returns an empty table when the index has no stories", () => {
    const rows = buildStoriesStatus(index({}), []);
    expect(rows).toEqual([]);
  });

  it("marks every stage absent when no PRs match the story", () => {
    const rows = buildStoriesStatus(
      index({ "006": { title: "Peer chat" } }),
      []
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.storyId).toBe("006");
    expect(rows[0]!.stages).toEqual({
      refine: "absent",
      testgen: "absent",
      vibe: "absent",
      brew: "absent",
      chef: "absent",
    });
  });

  it("marks a stage 'merged' when a labelled merged PR matches by title", () => {
    const rows = buildStoriesStatus(
      index({ "006": { title: "Peer chat" } }),
      [
        pr({
          number: 727,
          title: "feat(back): brew story-006 — peer-chat backend",
          labels: ["slowcook-brew"],
          headBranch: "slowcook/brew/story-006-1234",
          state: "closed",
          merged: true,
        }),
      ]
    );
    expect(rows[0]!.stages.brew).toBe("merged");
    expect(rows[0]!.stages.testgen).toBe("absent");
  });

  it("marks a stage 'open' when the matching PR is open + not merged", () => {
    const rows = buildStoriesStatus(
      index({ "010": { title: "Therapist calendar" } }),
      [
        pr({
          number: 800,
          title: "tests: story-010 — therapist calendar",
          labels: ["slowcook-tests"],
          headBranch: "slowcook/tests/story-010",
          state: "open",
          merged: false,
        }),
      ]
    );
    expect(rows[0]!.stages.testgen).toBe("open");
  });

  it("marks a stage 'closed_unmerged' when the matching PR closed without merge", () => {
    const rows = buildStoriesStatus(
      index({ "007": { title: "Therapist login" } }),
      [
        pr({
          number: 692,
          title: "spec: story-007 — therapist login",
          labels: ["slowcook-spec"],
          headBranch: "slowcook/spec/story-007",
          state: "closed",
          merged: false,
        }),
      ]
    );
    expect(rows[0]!.stages.refine).toBe("closed_unmerged");
  });

  it("falls back to branch-name when labels are absent (local-pipeline pattern)", () => {
    const rows = buildStoriesStatus(
      index({ "006": { title: "Peer chat" } }),
      [
        // Local-pipeline PR may not carry slowcook-* labels — match
        // by the slowcook/<kind>/story-N branch shape instead.
        pr({
          number: 727,
          title: "feat(back): brew story-006",
          labels: [], // intentionally no slowcook-* label
          headBranch: "slowcook/brew/story-006-9999",
          state: "closed",
          merged: true,
        }),
      ]
    );
    expect(rows[0]!.stages.brew).toBe("merged");
  });

  it("matches multiple stages independently for the same story", () => {
    const rows = buildStoriesStatus(
      index({ "009": { title: "Patient appointments" } }),
      [
        pr({
          number: 688,
          title: "spec: story-009 — patient appointments",
          labels: ["slowcook-spec"],
          headBranch: "slowcook/spec/story-009",
          state: "closed",
          merged: true,
        }),
        pr({
          number: 696,
          title: "tests: story-009 — patient appointments",
          labels: ["slowcook-tests"],
          headBranch: "slowcook/tests/story-009",
          state: "closed",
          merged: true,
        }),
        pr({
          number: 701,
          title: "feat(patient): brew story-009",
          labels: ["slowcook-brew"],
          headBranch: "slowcook/brew/story-009-1234",
          state: "closed",
          merged: true,
        }),
      ]
    );
    expect(rows[0]!.stages).toEqual({
      refine: "merged",
      testgen: "merged",
      vibe: "absent",
      brew: "merged",
      chef: "absent",
    });
  });

  it("doesn't cross-match — a PR for story-006 doesn't bleed into story-016 row", () => {
    const rows = buildStoriesStatus(
      index({ "006": { title: "Six" }, "016": { title: "Sixteen" } }),
      [
        pr({
          number: 727,
          title: "feat: brew story-006",
          labels: ["slowcook-brew"],
          headBranch: "slowcook/brew/story-006-1234",
          state: "closed",
          merged: true,
        }),
      ]
    );
    const r006 = rows.find((r) => r.storyId === "006")!;
    const r016 = rows.find((r) => r.storyId === "016")!;
    expect(r006.stages.brew).toBe("merged");
    expect(r016.stages.brew).toBe("absent");
  });

  it("sorts rows by story id lexicographically", () => {
    const rows = buildStoriesStatus(
      index({ "017": { title: "X" }, "005": { title: "Y" }, "010": { title: "Z" } }),
      []
    );
    expect(rows.map((r) => r.storyId)).toEqual(["005", "010", "017"]);
  });
});

describe("renderStoriesStatusTable", () => {
  it("renders an empty-state line when no rows", () => {
    expect(renderStoriesStatusTable([])).toMatch(/no stories/);
  });

  it("renders a header row + a divider + one line per story", () => {
    const out = renderStoriesStatusTable(
      buildStoriesStatus(
        index({ "006": { title: "Peer chat" } }),
        [
          pr({
            number: 727,
            title: "feat: brew story-006",
            labels: ["slowcook-brew"],
            headBranch: "slowcook/brew/story-006-x",
            state: "closed",
            merged: true,
          }),
        ]
      )
    );
    expect(out).toMatch(/Story/);
    expect(out).toMatch(/refine/);
    expect(out).toMatch(/006/);
    expect(out).toMatch(/Peer chat/);
    // Brew column for story 006 should have ✓ (merged glyph).
    expect(out).toMatch(/✓/);
    expect(out).toMatch(/Legend/);
  });
});
