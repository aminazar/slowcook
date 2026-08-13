import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { discoverTests } from "./discover.js";
import type { SolidityStackConfig } from "./stack-config.js";

const loadFixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

function mkConfig(): SolidityStackConfig {
  return {
    language: "solidity",
    test: {
      forge: {
        runner: "forge",
        run_command: "forge test --json",
        discover_command: "forge test --list --json",
        reporter_format: "forge-json",
      },
    },
  };
}

describe("discoverTests", () => {
  it("discovers tests from real forge test --list --json output", () => {
    const result = discoverTests(mkConfig(), {
      cwd: "/repo",
      exec: () => loadFixture("forge-list.json"),
    });
    expect(result.errors).toEqual([]);
    expect(result.tests).toHaveLength(5);
    expect(result.tests[0]).toEqual({
      id: "test/Smoke.t.sol > SmokeTest > test_depositCreditsMember",
      file: "test/Smoke.t.sol",
    });
    expect(result.suites).toEqual([
      {
        suite: "forge",
        command: "forge test --list --json",
        test_count: 5,
      },
    ]);
  });

  it("captures a failing suite as an error without failing the whole discovery", () => {
    const result = discoverTests(mkConfig(), {
      cwd: "/repo",
      exec: () => {
        throw new Error("forge: command not found");
      },
    });
    expect(result.tests).toEqual([]);
    expect(result.errors).toEqual([
      { suite: "forge", message: "forge: command not found" },
    ]);
  });

  it("returns empty results when no suites are declared", () => {
    const result = discoverTests({ language: "solidity" }, { cwd: "/repo" });
    expect(result).toEqual({ tests: [], suites: [], errors: [] });
  });

  it("passes the configured discover_command and cwd to exec", () => {
    const seen: { cmd: string; cwd: string }[] = [];
    discoverTests(mkConfig(), {
      cwd: "/some/repo",
      exec: (cmd, cwd) => {
        seen.push({ cmd, cwd });
        return "{}";
      },
    });
    expect(seen).toEqual([
      { cmd: "forge test --list --json", cwd: "/some/repo" },
    ]);
  });
});
