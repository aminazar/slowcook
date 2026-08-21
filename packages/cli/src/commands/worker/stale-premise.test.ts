import { describe, it, expect } from "vitest";
import { needsTriageReply, renderTriageReply, STALE_PREMISE_MARKER } from "./stale-premise.js";

describe("stale-premise triage (D9)", () => {
  const merged = "2026-08-20T12:00:00Z";
  it("fresh human comment after merge, no bot reply → triage", () => {
    expect(
      needsTriageReply(merged, [{ isBot: false, createdAt: "2026-08-21T09:00:00Z" }])
    ).toBe(true);
  });
  it("bot already replied → no re-triage", () => {
    expect(
      needsTriageReply(merged, [
        { isBot: false, createdAt: "2026-08-21T09:00:00Z" },
        { isBot: true, createdAt: "2026-08-21T09:05:00Z" },
      ])
    ).toBe(false);
  });
  it("pre-merge comments and unmerged PRs are not triage business", () => {
    expect(needsTriageReply(merged, [{ isBot: false, createdAt: "2026-08-19T09:00:00Z" }])).toBe(false);
    expect(needsTriageReply(null, [{ isBot: false, createdAt: "2026-08-21T09:00:00Z" }])).toBe(false);
  });
  it("reply names the current artifact and routes to the live venue", () => {
    const r = renderTriageReply({ kind: "tests", storyId: "019", sourceIssue: 215, successorPr: 226 });
    expect(r).toContain(STALE_PREMISE_MARKER);
    expect(r).toContain("open successor PR #226");
    expect(r).toContain("story-019");
    const r2 = renderTriageReply({ kind: "spec", storyId: "020", sourceIssue: 216, successorPr: null });
    expect(r2).toContain("source issue #216");
    expect(r2).toContain("specs/story-020.yaml");
  });
});
