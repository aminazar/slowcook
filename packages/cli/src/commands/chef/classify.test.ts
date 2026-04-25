import { describe, it, expect } from "vitest";
import { classifyPrFailure, originatingAgent } from "./classify.js";

describe("classifyPrFailure", () => {
  it("returns no-failure when head has no failing checks", () => {
    const r = classifyPrFailure({
      headChecks: [{ name: "tests", conclusion: "success" }],
      baseChecks: [],
      outOfDate: false,
    });
    expect(r.kind).toBe("no-failure");
  });

  it("returns self-conflict when branch is out of date (rebase needed)", () => {
    const r = classifyPrFailure({
      headChecks: [{ name: "tests", conclusion: "failure" }],
      baseChecks: [],
      outOfDate: true,
    });
    expect(r.kind).toBe("self-conflict");
    if (r.kind === "self-conflict") {
      expect(r.reason).toBe("branch-not-up-to-date");
    }
  });

  it("returns self-fail when head failures don't appear on base", () => {
    const r = classifyPrFailure({
      headChecks: [{ name: "tests", conclusion: "failure" }],
      baseChecks: [{ name: "tests", conclusion: "success" }],
      outOfDate: false,
    });
    expect(r.kind).toBe("self-fail");
    if (r.kind === "self-fail") {
      expect(r.failingChecks).toEqual(["tests"]);
    }
  });

  it("returns external-fail when ALL head failures also fail on base", () => {
    const r = classifyPrFailure({
      headChecks: [
        { name: "tests", conclusion: "failure" },
        { name: "lint", conclusion: "failure" },
      ],
      baseChecks: [
        { name: "tests", conclusion: "failure" },
        { name: "lint", conclusion: "failure" },
      ],
      outOfDate: false,
    });
    expect(r.kind).toBe("external-fail");
    if (r.kind === "external-fail") {
      expect(r.failingChecks.sort()).toEqual(["lint", "tests"]);
    }
  });

  it("returns self-fail when head has a mix (some new, some pre-existing)", () => {
    const r = classifyPrFailure({
      headChecks: [
        { name: "tests", conclusion: "failure" }, // new
        { name: "lint", conclusion: "failure" }, // pre-existing
      ],
      baseChecks: [{ name: "lint", conclusion: "failure" }],
      outOfDate: false,
    });
    expect(r.kind).toBe("self-fail");
    if (r.kind === "self-fail") {
      // Only the NEW failure counts as self-caused.
      expect(r.failingChecks).toEqual(["tests"]);
    }
  });

  it("returns infra-fail when all failures are timed_out", () => {
    const r = classifyPrFailure({
      headChecks: [{ name: "tests", conclusion: "timed_out" }],
      baseChecks: [{ name: "tests", conclusion: "success" }],
      outOfDate: false,
    });
    expect(r.kind).toBe("infra-fail");
  });

  it("treats neutral / cancelled / skipped as non-failures", () => {
    const r = classifyPrFailure({
      headChecks: [
        { name: "tests", conclusion: "neutral" },
        { name: "lint", conclusion: "cancelled" },
        { name: "build", conclusion: "skipped" },
      ],
      baseChecks: [],
      outOfDate: false,
    });
    expect(r.kind).toBe("no-failure");
  });

  it("treats action_required as a failure (needs operator attention)", () => {
    const r = classifyPrFailure({
      headChecks: [{ name: "tests", conclusion: "action_required" }],
      baseChecks: [{ name: "tests", conclusion: "success" }],
      outOfDate: false,
    });
    expect(r.kind).toBe("self-fail");
  });

  it("self-conflict takes priority over self-fail when both apply", () => {
    // Out-of-date branch + head also has failing checks → conflict
    // first; rebase usually resolves the apparent failures too.
    const r = classifyPrFailure({
      headChecks: [{ name: "tests", conclusion: "failure" }],
      baseChecks: [],
      outOfDate: true,
    });
    expect(r.kind).toBe("self-conflict");
  });
});

describe("originatingAgent", () => {
  it("maps refine spec branches", () => {
    expect(originatingAgent("slowcook/spec/story-013")).toBe("refine");
  });
  it("maps recipe / testgen test branches", () => {
    expect(originatingAgent("slowcook/tests/story-013")).toBe("recipe");
    expect(originatingAgent("slowcook/recipe/story-013")).toBe("recipe");
  });
  it("maps brew implementation branches", () => {
    expect(originatingAgent("slowcook/brew/story-013-1234")).toBe("brew");
  });
  it("maps sift bug-fix branches", () => {
    expect(originatingAgent("slowcook/sift/B-1-1234")).toBe("sift");
  });
  it("maps investigate bug-profile branches", () => {
    expect(originatingAgent("slowcook/bug-profile/B-1")).toBe("investigate");
  });
  it("returns null for non-slowcook branches", () => {
    expect(originatingAgent("main")).toBeNull();
    expect(originatingAgent("feature/foo")).toBeNull();
    expect(originatingAgent("slowcook/")).toBeNull();
    expect(originatingAgent("slowcook/unknown/x")).toBeNull();
  });
});
