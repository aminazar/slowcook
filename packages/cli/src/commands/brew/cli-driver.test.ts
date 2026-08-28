import { describe, it, expect } from "vitest";
import { isAuthFailure } from "./cli-driver.js";

describe("isAuthFailure (rewo story-022: the word trap)", () => {
  it("does NOT fire on a SUCCESSFUL turn whose text merely discusses authentication", () => {
    const text = "Implemented the 401 path: returns unauthenticated code when there is no session; the route authenticates via cookies.";
    expect(isAuthFailure(text, false)).toBe(false);
    // even on an errored turn, product vocabulary alone is not a login failure
    expect(isAuthFailure(text, true)).toBe(false);
  });

  it("fires on real CLI login failures, only when the turn errored", () => {
    for (const t of [
      "Invalid API key · Please run /login",
      "OAuth token expired — run claude setup-token",
      "You are not logged in",
      "Authentication failed",
    ]) {
      expect(isAuthFailure(t, true)).toBe(true);
      expect(isAuthFailure(t, false)).toBe(false);
    }
  });
});
