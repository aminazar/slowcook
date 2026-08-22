import { describe, it, expect } from "vitest";
import { parseStoryBranch } from "./story-branch.js";

describe("parseStoryBranch — the ONE branch parser (G24c)", () => {
  it("plain, amend, fix, and brew-timestamp suffixes all yield the bare id", () => {
    expect(parseStoryBranch("slowcook/spec/story-019")).toEqual({ kind: "spec", storyId: "019" });
    expect(parseStoryBranch("slowcook/spec/story-019-amend-1787404127547")).toEqual({ kind: "spec", storyId: "019" });
    expect(parseStoryBranch("slowcook/tests/story-019-fix-1")).toEqual({ kind: "tests", storyId: "019" });
    expect(parseStoryBranch("slowcook/brew/story-020-1787338062527")).toEqual({ kind: "brew", storyId: "020" });
  });
  it("non-agent branches are nobody's business", () => {
    expect(parseStoryBranch("feature/foo")).toBeNull();
    expect(parseStoryBranch("slowcook/mockup/story-018")).toBeNull();
  });
});
