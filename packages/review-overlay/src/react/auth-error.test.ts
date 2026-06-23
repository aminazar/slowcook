// 0.8.2 — coverage for describeAuthError (shipped untested in 0.8.1). Pure
// function: maps a GitHub write/auth failure to a plain-English remedy keyed
// off HTTP status + GitHub's own message + the repo coordinate.
import { describe, it, expect } from "vitest";
import { describeAuthError } from "./overlay.js";

const repo = { owner: "delgoosh", repo: "monorepo" };

describe("describeAuthError", () => {
  it("explains the OAuth-App org restriction (the private-repo / device-flow dead-end)", () => {
    const msg = describeAuthError(403, "Although you appear to have the correct authorization credentials, the `delgoosh` organization has enabled OAuth App access restrictions", repo);
    // names the org, blames the OAuth-App restriction, prescribes a classic PAT.
    expect(msg).toContain('"delgoosh"');
    expect(msg).toContain("OAuth App");
    expect(msg).toContain("classic personal access token");
    expect(msg).toContain("`repo` scope");
  });

  it("matches the OAuth-restriction case case-insensitively", () => {
    const upper = describeAuthError(403, "OAUTH APP ACCESS RESTRICTIONS apply here", repo);
    expect(upper).toContain("OAuth App");
    expect(upper).toContain("classic personal access token");
  });

  it("gives a generic 403 remedy (private repo or org restriction) when the message is unspecific", () => {
    const msg = describeAuthError(403, "Forbidden", repo);
    expect(msg).toContain("403");
    expect(msg).toContain("delgoosh/monorepo");
    expect(msg).toContain("classic token");
    expect(msg).toContain("`repo` scope");
    // a bare 403 must NOT claim the OAuth-restriction reason.
    expect(msg).not.toContain("OAuth App access restrictions");
  });

  it("treats 401 as an expired/insufficient token → re-sign-in", () => {
    const msg = describeAuthError(401, "Bad credentials", repo);
    expect(msg).toContain("401");
    expect(msg.toLowerCase()).toMatch(/expired|missing scope/);
    expect(msg).toContain("`repo` scope");
  });

  it("treats 404 as a private-repo-invisible-to-token case", () => {
    const msg = describeAuthError(404, "Not Found", repo);
    expect(msg).toContain("delgoosh/monorepo");
    expect(msg.toLowerCase()).toContain("private");
    expect(msg).toContain("`repo`");
  });

  it("falls back to GitHub's own message for unmapped statuses", () => {
    expect(describeAuthError(500, "Server boom", repo)).toBe("Server boom");
  });

  it("falls back to a default prompt when there is neither status nor message", () => {
    expect(describeAuthError(undefined, undefined, repo)).toBe("Sign-in needed to post your comment.");
  });
});
