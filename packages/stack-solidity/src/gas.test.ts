import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  checkGasSnapshot,
  updateGasSnapshot,
  parseSnapshotDiff,
} from "./gas.js";

const loadFixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

describe("parseSnapshotDiff", () => {
  it("parses real forge snapshot --check diff output into structured regressions", () => {
    const regressions = parseSnapshotDiff(loadFixture("snapshot-check-fail.txt"));
    expect(regressions).toEqual([
      {
        test: 'CounterTest::test_failsOnPurpose()',
        old: 28657,
        new: 31020,
        delta: 2363,
      },
      {
        test: 'CounterTest::test_incrementOnce()',
        old: 28635,
        new: 30998,
        delta: 2363,
      },
    ]);
  });

  it("returns [] when there are no diff lines", () => {
    expect(parseSnapshotDiff("Suite result: ok. 3 passed")).toEqual([]);
    expect(parseSnapshotDiff("")).toEqual([]);
  });
});

describe("checkGasSnapshot", () => {
  it("reports clean on exit 0", () => {
    const result = checkGasSnapshot("/repo", undefined, {
      exec: (cmd) => {
        expect(cmd).toBe("forge snapshot --check");
        return { stdout: "ok", stderr: "", code: 0 };
      },
    });
    expect(result).toEqual({ ran: true, clean: true, regressions: [], exit_code: 0 });
  });

  it("parses regressions from a real failing --check run", () => {
    const result = checkGasSnapshot("/repo", undefined, {
      exec: () => ({
        stdout: loadFixture("snapshot-check-fail.txt"),
        stderr: "",
        code: 1,
      }),
    });
    expect(result.ran).toBe(true);
    expect(result.clean).toBe(false);
    expect(result.regressions).toHaveLength(2);
    expect(result.regressions[0]).toEqual({
      test: 'CounterTest::test_failsOnPurpose()',
      old: 28657,
      new: 31020,
      delta: 2363,
    });
  });

  it("honours snapshot_command and snapshot_file config", () => {
    const calls: string[] = [];
    checkGasSnapshot(
      "/repo",
      { snapshot_command: "forge snapshot --isolate", snapshot_file: "gas/base.snap" },
      {
        exec: (cmd) => {
          calls.push(cmd);
          return { stdout: "", stderr: "", code: 0 };
        },
      }
    );
    expect(calls).toEqual([
      "forge snapshot --isolate --snap gas/base.snap --check",
    ]);
  });

  it("distinguishes a broken check run (no parsable diff) from a regression", () => {
    const result = checkGasSnapshot("/repo", undefined, {
      exec: () => ({
        stdout: "Compiler run failed: Error (2314)",
        stderr: "Error: Compilation failed",
        code: 1,
      }),
    });
    expect(result.ran).toBe(false);
    expect(result.clean).toBe(false);
    expect(result.regressions).toEqual([]);
    expect(result.error).toContain("no parsable diff");
    expect(result.error).toContain("Compilation failed");
  });

  it("survives an exec crash", () => {
    const result = checkGasSnapshot("/repo", undefined, {
      exec: () => {
        throw new Error("spawn forge ENOENT");
      },
    });
    expect(result.ran).toBe(false);
    expect(result.exit_code).toBeNull();
    expect(result.error).toContain("ENOENT");
  });
});

describe("updateGasSnapshot", () => {
  it("runs the snapshot command without --check", () => {
    const calls: string[] = [];
    const result = updateGasSnapshot("/repo", undefined, {
      exec: (cmd) => {
        calls.push(cmd);
        return { stdout: "", stderr: "", code: 0 };
      },
    });
    expect(calls).toEqual(["forge snapshot"]);
    expect(result).toEqual({ ok: true, exit_code: 0 });
  });

  it("surfaces a failed update", () => {
    const result = updateGasSnapshot("/repo", undefined, {
      exec: () => ({ stdout: "", stderr: "Error: Compilation failed", code: 1 }),
    });
    expect(result.ok).toBe(false);
    expect(result.exit_code).toBe(1);
    expect(result.error).toContain("Compilation failed");
  });
});
