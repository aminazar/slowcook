import { describe, it, expect } from "vitest";
import { mapReviewsToApprovals } from "./github.js";

describe("mapReviewsToApprovals", () => {
  it("maps states + lowercases handles", () => {
    const out = mapReviewsToApprovals([
      { user: { login: "Designer1", type: "User" }, state: "APPROVED" },
      { user: { login: "qaPerson", type: "User" }, state: "CHANGES_REQUESTED" },
    ]);
    expect(out).toEqual([
      { byHandle: "designer1", state: "approved", identityType: "human" },
      { byHandle: "qaperson", state: "rejected", identityType: "human" },
    ]);
  });

  it("classifies bots by type, [bot] suffix, and known-login list", () => {
    const out = mapReviewsToApprovals([
      { user: { login: "slowcook-brew[bot]", type: "Bot" }, state: "APPROVED" },
      { user: { login: "dependabot[bot]", type: "User" }, state: "APPROVED" },
      { user: { login: "github-actions", type: "User" }, state: "APPROVED" },
    ]);
    expect(out.every((a) => a.identityType === "bot")).toBe(true);
  });

  it("drops dismissed/pending and keeps only the latest review per author", () => {
    const out = mapReviewsToApprovals([
      { user: { login: "pm", type: "User" }, state: "CHANGES_REQUESTED" },
      { user: { login: "pm", type: "User" }, state: "APPROVED" }, // supersedes
      { user: { login: "x", type: "User" }, state: "DISMISSED" },
      { user: { login: "y", type: "User" }, state: "PENDING" },
    ]);
    expect(out).toEqual([{ byHandle: "pm", state: "approved", identityType: "human" }]);
  });

  it("ignores reviews with no author", () => {
    expect(mapReviewsToApprovals([{ state: "APPROVED" }])).toEqual([]);
  });
});
