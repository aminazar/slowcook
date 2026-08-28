import { describe, it, expect } from "vitest";
import { GitHubAdapter } from "./github-adapter.js";

describe("listPullRequestReviews (review bodies — rewo season 2026-08-28)", () => {
  it("maps submitted reviews to comments, prefixes state, and drops empty bodies", async () => {
    const adapter = new GitHubAdapter({ owner: "o", repo: "r", token: "t" });
    // The third feedback surface: a PM review body is invisible to both
    // listIssueComments and listReviewComments, so refine's resubmit
    // gatherer no-op'd forever while the derivation kept re-firing.
    (adapter as unknown as { octokit: unknown }).octokit = {
      paginate: async () => [
        {
          id: 1,
          user: { login: "amin", type: "User" },
          body: "blocking: wrong tint",
          state: "CHANGES_REQUESTED",
          submitted_at: "2026-08-28T18:40:00Z",
        },
        {
          id: 2,
          user: { login: "someone", type: "User" },
          body: "",
          state: "APPROVED",
          submitted_at: "2026-08-28T18:41:00Z",
        },
      ],
      pulls: { listReviews: () => undefined },
    };
    const out = await adapter.listPullRequestReviews(278);
    expect(out).toHaveLength(1);
    expect(out[0]!.body).toBe("[CHANGES_REQUESTED] blocking: wrong tint");
    expect(out[0]!.author).toBe("amin");
    expect(out[0]!.is_bot).toBe(false);
  });
});
