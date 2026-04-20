import { describe, it, expect } from "vitest";
import { discoverTests } from "./discover.js";
import type { StackConfig } from "./stack-config.js";

const SAMPLE_VITEST_OUT = `tests/a.test.ts > d1 > t1
tests/a.test.ts > d1 > t2
tests/b.test.ts > d2 > t1
`;

function mkConfig(suites: StackConfig["test"]): StackConfig {
  return {
    language: "typescript",
    test: suites,
  };
}

describe("discoverTests", () => {
  it("runs each suite's discover_command and merges results", () => {
    const config = mkConfig({
      backend: {
        runner: "vitest",
        run_command: "…",
        discover_command: "echo backend",
        reporter_format: "vitest-list-lines",
      },
      e2e: {
        runner: "vitest",
        run_command: "…",
        discover_command: "echo e2e",
        reporter_format: "vitest-list-lines",
      },
    });

    const calls: string[] = [];
    const fakeExec = (cmd: string): string => {
      calls.push(cmd);
      return SAMPLE_VITEST_OUT;
    };

    const result = discoverTests(config, { cwd: "/tmp", exec: fakeExec });
    expect(calls).toEqual(["echo backend", "echo e2e"]);
    expect(result.tests).toHaveLength(6); // 3 per suite × 2 suites
    expect(result.suites).toEqual([
      { suite: "backend", command: "echo backend", test_count: 3 },
      { suite: "e2e", command: "echo e2e", test_count: 3 },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("records an error per failing suite but does not throw", () => {
    const config = mkConfig({
      backend: {
        runner: "vitest",
        run_command: "…",
        discover_command: "some-cmd",
        reporter_format: "vitest-list-lines",
      },
      e2e: {
        runner: "vitest",
        run_command: "…",
        discover_command: "another-cmd",
        reporter_format: "vitest-list-lines",
      },
    });

    const fakeExec = (cmd: string): string => {
      if (cmd === "some-cmd") return SAMPLE_VITEST_OUT;
      throw new Error("command failed: " + cmd);
    };

    const result = discoverTests(config, { cwd: "/tmp", exec: fakeExec });
    expect(result.tests).toHaveLength(3);
    expect(result.errors).toEqual([
      { suite: "e2e", message: "command failed: another-cmd" },
    ]);
  });

  it("returns empty result for a config with no suites", () => {
    const config = mkConfig(undefined);
    const result = discoverTests(config, { cwd: "/tmp", exec: () => "" });
    expect(result.tests).toEqual([]);
    expect(result.suites).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});
