import { describe, it, expect } from "vitest";
import {
  parseVerdict,
  overlapCommentBody,
  contradictionCommentBody,
} from "./relationship.js";

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
