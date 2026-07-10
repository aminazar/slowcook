// the ratchet's escape hatch carries its reason (LinkedIn feedback, 2026-07-10):
// --override without a stated reason refuses; a full PR body yields the
// Override-reason line; a bare string passes through.
import { describe, it, expect } from "vitest";
import { extractReason } from "./guard.js";

describe("guard override reason extraction", () => {
  it("bare reason passes through", () => {
    expect(extractReason("spec #42 superseded the pagination contract")).toBe("spec #42 superseded the pagination contract");
  });
  it("full PR body → the Override-reason line", () => {
    const body = "This PR amends the frozen test.\n\nOverride-reason: story-042 v2 changed the sort order contract\n\ncloses #42";
    expect(extractReason(body)).toBe("story-042 v2 changed the sort order contract");
  });
  it("multi-line body WITHOUT the marker = no reason (refused later)", () => {
    expect(extractReason("just a PR body\nwith lines")).toBeNull();
  });
  it("empty/undefined = null", () => {
    expect(extractReason(undefined)).toBeNull();
    expect(extractReason("  ")).toBeNull();
  });
});
