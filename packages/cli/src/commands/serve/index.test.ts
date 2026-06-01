import { describe, it, expect } from "vitest";
import { parseServeArgs } from "./index.js";

describe("parseServeArgs", () => {
  it("extracts profile + verb positionals", () => {
    const args = parseServeArgs(["dev", "sync", "--story", "042"]);
    expect(args.profile).toBe("dev");
    expect(args.verb).toBe("sync");
    expect(args.story).toBe("042");
  });

  it("accepts --branch / --service / --cwd / flags", () => {
    const args = parseServeArgs([
      "dev",
      "logs",
      "--service",
      "patient",
      "--follow",
      "--cwd",
      "/tmp/repo",
    ]);
    expect(args.profile).toBe("dev");
    expect(args.verb).toBe("logs");
    expect(args.service).toBe("patient");
    expect(args.follow).toBe(true);
    expect(args.repoRoot).toBe("/tmp/repo");
  });

  it("treats --help as verb=--help", () => {
    expect(parseServeArgs(["--help"]).verb).toBe("--help");
    expect(parseServeArgs(["dev", "-h"]).verb).toBe("--help");
  });

  it("supports --dry-run + --prune", () => {
    const args = parseServeArgs(["dev", "down", "--prune"]);
    expect(args.prune).toBe(true);
    expect(args.dryRun).toBeUndefined();
    const argsDry = parseServeArgs(["dev", "sync", "--dry-run"]);
    expect(argsDry.dryRun).toBe(true);
  });
});
