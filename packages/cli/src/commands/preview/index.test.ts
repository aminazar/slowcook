import { describe, it, expect } from "vitest";
import { parseDeployArgs } from "./deploy.js";
import { parseTeardownArgs } from "./teardown.js";

describe("parseDeployArgs", () => {
  it("parses --pr as a number", () => {
    const a = parseDeployArgs(["--pr", "42"]);
    expect(a.pr).toBe(42);
  });

  it("captures --ssh-key, --owner, --repo, --cwd, --dry-run", () => {
    const a = parseDeployArgs([
      "--pr", "7",
      "--ssh-key", "/tmp/id_slowcook",
      "--owner", "aminazar",
      "--repo", "slowcook",
      "--cwd", "/repo",
      "--dry-run",
    ]);
    expect(a).toEqual({
      pr: 7,
      keyPath: "/tmp/id_slowcook",
      owner: "aminazar",
      repo: "slowcook",
      repoRoot: "/repo",
      dryRun: true,
    });
  });

  it("leaves pr undefined when --pr is missing", () => {
    const a = parseDeployArgs(["--cwd", "/x"]);
    expect(a.pr).toBeUndefined();
  });

  it("dryRun defaults to false", () => {
    const a = parseDeployArgs(["--pr", "1"]);
    expect(a.dryRun).toBe(false);
  });
});

describe("parseTeardownArgs", () => {
  it("captures --prune-image", () => {
    const a = parseTeardownArgs(["--pr", "9", "--prune-image"]);
    expect(a.pr).toBe(9);
    expect(a.pruneImage).toBe(true);
  });

  it("pruneImage defaults to false (we keep images for fast redeploy)", () => {
    const a = parseTeardownArgs(["--pr", "9"]);
    expect(a.pruneImage).toBe(false);
  });

  it("captures the same shared flags as deploy", () => {
    const a = parseTeardownArgs([
      "--pr", "11",
      "--ssh-key", "/k",
      "--owner", "o",
      "--repo", "r",
      "--cwd", "/repo",
    ]);
    expect(a).toEqual({
      pr: 11,
      keyPath: "/k",
      owner: "o",
      repo: "r",
      repoRoot: "/repo",
      pruneImage: false,
      dryRun: false,
    });
  });
});
