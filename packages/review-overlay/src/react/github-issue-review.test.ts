// The turnkey adapter's pure transport layer.
import { describe, it, expect } from "vitest";
import { parseAgentReply, buildIssueBody, parseIssue, type IssueLike } from "./github-issue-review.js";
import type { ReviewComment } from "./review-shell.js";

const comment: ReviewComment = {
  id: "c1", node: "pass/needs-you", label: "needs you", text: "line one\nline two",
  author: "Amin", createdAt: 1,
};

describe("GitHubIssueReview transport", () => {
  it("issue body round-trips through parseIssue", () => {
    const body = buildIssueBody(comment, "staging — /app");
    const issue: IssueLike = {
      number: 42, title: "[review] needs you — line one", body, state: "open",
      html_url: "https://github.com/o/r/issues/42", created_at: "2026-07-26T00:00:00Z",
      user: { login: "amin" }, comments: 2, labels: [{ name: "agent-working" }],
    };
    const parsed = parseIssue(issue)!;
    expect(parsed.node).toBe("pass/needs-you");
    expect(parsed.label).toBe("needs you");
    expect(parsed.text).toBe("line one\nline two");
    expect(parsed.remoteId).toBe(42);
    expect(parsed.working).toBe(true);
  });

  it("parses the legacy overlay Element format", () => {
    const issue: IssueLike = {
      number: 7, title: "t", state: "closed", html_url: "u", created_at: "2026-07-26T00:00:00Z",
      user: { login: "x" }, comments: 0,
      body: '**Element:** `[data-testid="money/ledger"] > div`\n\n> old pin',
    };
    expect(parseIssue(issue)!.node).toBe("money/ledger");
  });

  it("returns null for bodies without an anchor", () => {
    const issue: IssueLike = {
      number: 8, title: "t", state: "open", html_url: "u", created_at: "2026-07-26T00:00:00Z",
      user: { login: "x" }, comments: 0, body: "free-form issue, not a pin",
    };
    expect(parseIssue(issue)).toBeNull();
  });

  it("agent markers become identity + a money line", () => {
    const r = parseAgentReply("aminazar", '<!-- slowcook:agent wireframe -->\n<!-- slowcook:cost cents=85 basis="apply + deploy" -->\n**Done.**');
    expect(r.author).toBe("wireframe · agent");
    expect(r.text).toContain("**Done.**");
    expect(r.text).toContain("*cost: ~$0.85 (apply + deploy)*");
  });

  it("plain replies keep their login and body", () => {
    const r = parseAgentReply("hpezeshki", "looks good");
    expect(r).toEqual({ author: "hpezeshki", text: "looks good" });
  });
});
