import { describe, it, expect } from "vitest";
import {
  parseVerdict,
  overlapCommentBody,
  contradictionCommentBody,
  followUpCommentBody,
  specRefForProse,
} from "./relationship.js";
import type { Spec } from "@slowcook-ai/core";

describe("parseVerdict", () => {
  it("parses a direct JSON object response", () => {
    const raw = `{"kind":"new_or_independent","conflicting_ids":[],"reasoning":"nothing related yet"}`;
    const v = parseVerdict(raw);
    expect(v.kind).toBe("new_or_independent");
    if (v.kind === "new_or_independent") expect(v.reasoning).toContain("nothing related");
  });

  it("parses JSON wrapped in a fenced code block", () => {
    const raw =
      "Here's my analysis:\n\n```json\n{\"kind\":\"overlap\",\"conflicting_ids\":[\"042\"],\"reasoning\":\"same endpoint\"}\n```\n";
    const v = parseVerdict(raw);
    expect(v.kind).toBe("overlap");
    if (v.kind === "overlap") {
      expect(v.conflicting_ids).toEqual(["042"]);
      expect(v.reasoning).toBe("same endpoint");
    }
  });

  it("parses JSON with surrounding prose", () => {
    const raw = `My verdict is: {"kind":"contradiction","conflicting_ids":["007","013"],"reasoning":"changes an invariant"}  That's final.`;
    const v = parseVerdict(raw);
    expect(v.kind).toBe("contradiction");
    if (v.kind === "contradiction") {
      expect(v.conflicting_ids).toEqual(["007", "013"]);
    }
  });

  it("throws a clear error on non-JSON output", () => {
    expect(() => parseVerdict("I'm not sure.")).toThrow(/non-JSON|schema/);
  });

  it("throws on malformed verdict kind", () => {
    const raw = `{"kind":"maybe","conflicting_ids":[],"reasoning":"fuzzy"}`;
    expect(() => parseVerdict(raw)).toThrow(/schema|kind/);
  });

  it("throws on missing required fields", () => {
    const raw = `{"kind":"overlap","reasoning":"missing conflicting_ids"}`;
    expect(() => parseVerdict(raw)).toThrow();
  });

  it("parses the follow_up verdict (0.7.1 — builds on top of a prior spec's non-goal)", () => {
    const raw = `{"kind":"follow_up","conflicting_ids":["005"],"reasoning":"story-005 explicitly listed handle editing as a non-goal; this issue fulfills that deferred scope."}`;
    const v = parseVerdict(raw);
    expect(v.kind).toBe("follow_up");
    if (v.kind === "follow_up") {
      expect(v.related_ids).toEqual(["005"]);
      expect(v.reasoning).toContain("non-goal");
    }
  });
});

describe("specRefForProse — GitHub-native issue-number references", () => {
  const spec = (story_id: string, source_issue?: string): Spec => ({
    story_id,
    title: "t",
    status: "active",
    created_at: "2026-04-22T00:00:00Z",
    supersedes: [],
    superseded_by: null,
    source_issue,
    refined_by: "slowcook-refine@test",
    actors: [],
    preconditions: [],
    invariants: [],
    acceptance_scenarios: [],
    non_goals: [],
  }) as unknown as Spec;

  it("uses #N (story-N) when source_issue is known — N hyperlinks in GitHub", () => {
    expect(specRefForProse(spec("005", "#45"))).toBe("#45 (story-005)");
  });

  it("accepts source_issue without the # prefix", () => {
    expect(specRefForProse(spec("005", "45"))).toBe("#45 (story-005)");
  });

  it("falls back to the story id when source_issue is missing", () => {
    expect(specRefForProse(spec("005"))).toBe("story-005");
  });
});

describe("followUpCommentBody — informational, does not halt", () => {
  it("references predecessor by #N when known, cites reasoning", () => {
    const predecessor = {
      story_id: "005",
      title: "Per-user reactions page",
      source_issue: "#45",
    } as unknown as Spec;
    const body = followUpCommentBody(
      { kind: "follow_up", related_ids: ["005"], reasoning: "prior non-goal covers this" },
      [predecessor]
    );
    expect(body).toContain("builds on top of #45 (story-005)");
    expect(body).toContain("Continuing with refinement");
    expect(body).not.toContain("pause refinement");
  });
});

describe("overlapCommentBody", () => {
  it("lists conflicting ids in markdown", () => {
    const body = overlapCommentBody({
      kind: "overlap",
      conflicting_ids: ["042", "013"],
      reasoning: "same API endpoint",
    });
    expect(body).toContain("story-042");
    expect(body).toContain("story-013");
    expect(body).toContain("same API endpoint");
    expect(body).toMatch(/Merge|Delta|Duplicate/i);
  });
});

describe("contradictionCommentBody", () => {
  it("renders a blocker when change-of-mind is absent", () => {
    const body = contradictionCommentBody(
      { kind: "contradiction", conflicting_ids: ["007"], reasoning: "flips ration" },
      false
    );
    expect(body).toContain("blocked");
    expect(body).toContain("change-of-mind");
    expect(body).toContain("story-007");
  });

  it("renders an acknowledgment when change-of-mind is present", () => {
    const body = contradictionCommentBody(
      { kind: "contradiction", conflicting_ids: ["007"], reasoning: "flips ration" },
      true
    );
    expect(body).toContain("change-of-mind authorized");
    expect(body).toContain("supersede");
    expect(body).not.toContain("refinement blocked");
  });
});
