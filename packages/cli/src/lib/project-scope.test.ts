// dovizir handover §3 — two projects in one repo collided on
// `slowcook/spec/story-001`. The scope fixes that WITHOUT renaming anything in
// a single-project repo, which is the property most of these tests defend.
import { describe, it, expect } from "vitest";
import {
  slugifyScope,
  deriveScope,
  scopedSpecBranch,
  specBranchPattern,
  scopedPrTitle,
} from "./project-scope.js";

describe("deriveScope", () => {
  it("is EMPTY when .brewing sits at the git root — today's names must not move", () => {
    expect(deriveScope({ repoRoot: "/w/app", gitRoot: "/w/app" })).toBe("");
    expect(deriveScope({ repoRoot: "/w/app/", gitRoot: "/w/app" })).toBe("");
  });

  it("derives from the project's path inside the worktree", () => {
    expect(deriveScope({ repoRoot: "/w/repo/packages/contracts", gitRoot: "/w/repo" }))
      .toBe("packages-contracts");
    expect(deriveScope({ repoRoot: "/w/repo/packages/notes", gitRoot: "/w/repo" }))
      .toBe("packages-notes");
  });

  it("an explicit project_id wins", () => {
    expect(deriveScope({ repoRoot: "/w/repo/packages/contracts", gitRoot: "/w/repo", projectId: "Contracts" }))
      .toBe("contracts");
  });

  it("stays empty when there is no git root, or the project is outside it", () => {
    expect(deriveScope({ repoRoot: "/w/app", gitRoot: null })).toBe("");
    expect(deriveScope({ repoRoot: "/elsewhere/app", gitRoot: "/w/repo" })).toBe("");
  });

  it("does not confuse a sibling directory with a child", () => {
    // "/w/repo-other" starts with "/w/repo" as a STRING but is not inside it.
    expect(deriveScope({ repoRoot: "/w/repo-other", gitRoot: "/w/repo" })).toBe("");
  });

  it("slugifies to branch-safe text", () => {
    expect(slugifyScope("packages/My App!")).toBe("packages-my-app");
    expect(slugifyScope("./a//b/")).toBe("a-b");
  });
});

describe("scopedSpecBranch", () => {
  it("is byte-identical to the old name when unscoped", () => {
    expect(scopedSpecBranch("", "001")).toBe("slowcook/spec/story-001");
    expect(scopedSpecBranch("", "001", "amend-123")).toBe("slowcook/spec/story-001-amend-123");
  });

  it("qualifies the namespace when scoped — the two projects no longer collide", () => {
    expect(scopedSpecBranch("packages-contracts", "001")).toBe("slowcook/spec/packages-contracts/story-001");
    expect(scopedSpecBranch("packages-notes", "001")).toBe("slowcook/spec/packages-notes/story-001");
    expect(scopedSpecBranch("packages-contracts", "001")).not.toBe(scopedSpecBranch("packages-notes", "001"));
  });
});

describe("specBranchPattern", () => {
  const any = specBranchPattern();
  it("matches scoped and unscoped branches alike", () => {
    expect(any.test("slowcook/spec/story-001")).toBe(true);
    expect(any.test("slowcook/spec/packages-contracts/story-001")).toBe(true);
    expect(any.test("slowcook/spec/story-001-amend-99")).toBe(true);
  });
  it("does not match other slowcook branches", () => {
    expect(any.test("slowcook/brew/story-001-123")).toBe(false);
    expect(any.test("slowcook/mockup/story-001")).toBe(false);
  });
  it("can target one story across scopes — collision scans must not go blind", () => {
    const one = specBranchPattern("001");
    expect(one.test("slowcook/spec/packages-notes/story-001")).toBe(true);
    expect(one.test("slowcook/spec/story-0011")).toBe(false); // not a prefix match
  });
});

describe("scopedPrTitle", () => {
  it("tags the project only when scoped", () => {
    expect(scopedPrTitle("", "001", "wallet")).toBe("spec: story-001 — wallet");
    expect(scopedPrTitle("contracts", "001", "wallet")).toBe("spec: [contracts] story-001 — wallet");
  });
});
