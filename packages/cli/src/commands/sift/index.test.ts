import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRegressionTestForBug } from "./index.js";

function mkRepo(): string {
  return mkdtempSync(join(tmpdir(), "slowcook-sift-"));
}

describe("findRegressionTestForBug", () => {
  it("returns null when tests/regression/ doesn't exist", () => {
    const repo = mkRepo();
    try {
      expect(findRegressionTestForBug(repo, "B-1")).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns the path when a matching file exists", () => {
    const repo = mkRepo();
    try {
      const dir = join(repo, "tests/regression");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "B-1-feed-bug.test.ts"), "");
      expect(findRegressionTestForBug(repo, "B-1")).toBe(
        "tests/regression/B-1-feed-bug.test.ts"
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns the first match when multiple files share the prefix", () => {
    const repo = mkRepo();
    try {
      const dir = join(repo, "tests/regression");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "B-2-other.test.ts"), "");
      writeFileSync(join(dir, "B-1-foo.test.ts"), "");
      expect(findRegressionTestForBug(repo, "B-1")).toBe(
        "tests/regression/B-1-foo.test.ts"
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("ignores non-test-ts files even with the right prefix", () => {
    const repo = mkRepo();
    try {
      const dir = join(repo, "tests/regression");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "B-1-foo.md"), ""); // not .test.ts
      writeFileSync(join(dir, "B-1-foo.txt"), "");
      expect(findRegressionTestForBug(repo, "B-1")).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does not match a different bug id (B-1 should not match B-12)", () => {
    const repo = mkRepo();
    try {
      const dir = join(repo, "tests/regression");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "B-12-other.test.ts"), "");
      // Looking for B-1; B-12 starts with "B-1" but has a different separator.
      // The prefix in the implementation is "B-1-" so this should NOT match.
      expect(findRegressionTestForBug(repo, "B-1")).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
