import { readFileSync } from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { runTests } from "./run.js";
import { parseForgeList } from "./parsers.js";
import type { SolidityStackConfig } from "./stack-config.js";

const loadFixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

function mkConfig(runCommand = "forge test"): SolidityStackConfig {
  return {
    language: "solidity",
    test: {
      forge: {
        runner: "forge",
        run_command: runCommand,
        discover_command: "forge test --list --json",
        reporter_format: "forge-json",
      },
    },
  };
}

describe("runTests", () => {
  it("runs the suite and parses a real all-passing forge run", () => {
    const calls: string[] = [];
    const result = runTests(mkConfig(), {
      cwd: "/repo",
      exec: (cmd) => {
        calls.push(cmd);
        return { stdout: loadFixture("forge-test-pass.json"), stderr: "", code: 0 };
      },
    });
    expect(result.ran).toBe(true);
    expect(result.tests).toHaveLength(5);
    expect(result.tests.every((t) => t.status === "passed")).toBe(true);
    expect(result.suites).toEqual([
      {
        suite: "forge",
        command: "forge test --json",
        exit_code: 0,
        stdout_bytes: loadFixture("forge-test-pass.json").length,
      },
    ]);
  });

  it("appends --json to a bare forge test command but not twice", () => {
    const calls: string[] = [];
    const exec = (cmd: string) => {
      calls.push(cmd);
      return { stdout: "{}", stderr: "", code: 0 };
    };
    runTests(mkConfig("forge test"), { cwd: "/repo", exec });
    runTests(mkConfig("forge test --json"), { cwd: "/repo", exec });
    expect(calls).toEqual(["forge test --json", "forge test --json"]);
  });

  it("stays ran=true when tests fail but output parses (failures are signal, not error)", () => {
    const result = runTests(mkConfig(), {
      cwd: "/repo",
      exec: () => ({ stdout: loadFixture("forge-test-fail.json"), stderr: "", code: 1 }),
    });
    expect(result.ran).toBe(true);
    expect(result.tests.filter((t) => t.status === "failed")).toHaveLength(1);
    expect(result.tests.filter((t) => t.status === "passed")).toHaveLength(2);
  });

  it("reports ran=false with the stderr excerpt on a real compile error (non-zero, no JSON)", () => {
    const result = runTests(mkConfig(), {
      cwd: "/repo",
      exec: () => ({
        stdout: loadFixture("compile-error.stdout.txt"),
        stderr: loadFixture("compile-error.stderr.txt"),
        code: 1,
      }),
    });
    expect(result.ran).toBe(false);
    expect(result.error).toContain("[forge] exit 1, no parsable JSON");
    expect(result.error).toContain("Compilation failed");
    expect(result.tests).toEqual([]);
    expect(result.suites[0]?.exit_code).toBe(1);
  });

  it("scopes the run with --match-path when scopeFiles is set", () => {
    const calls: string[] = [];
    runTests(mkConfig(), {
      cwd: "/repo",
      exec: (cmd) => {
        calls.push(cmd);
        return { stdout: "{}", stderr: "", code: 0 };
      },
      scopeFiles: ["test/Counter.t.sol"],
    });
    expect(calls[0]).toBe("forge test --json --match-path test/Counter.t.sol");
  });

  it("joins multiple scope files into a brace-set glob", () => {
    const calls: string[] = [];
    runTests(mkConfig(), {
      cwd: "/repo",
      exec: (cmd) => {
        calls.push(cmd);
        return { stdout: "{}", stderr: "", code: 0 };
      },
      scopeFiles: ["test/A.t.sol", "test/B.t.sol"],
    });
    expect(calls[0]).toBe(
      "forge test --json --match-path '{test/A.t.sol,test/B.t.sol}'"
    );
  });

  // Regression for the Dovizir arm-B live failure: a stub-backed
  // acceptance project (sibling dir, driven via `--root ../acceptance`)
  // where 6 of 9 contracts' setUp() reverts with "STUB". forge's run
  // output collapses each such contract into one synthetic "setUp()"
  // entry — 24 rows for 78 discoverable tests — which made brew's
  // manifest-drift check see 60 story tests as invisible and halt.
  // runTests must re-expand those suites via the discover_command so
  // every listed test gets a failed row with the setUp revert reason.
  describe("setUp() collapse expansion (root-sibling fixtures)", () => {
    const rootConfig: SolidityStackConfig = {
      language: "solidity",
      test: {
        forge: {
          runner: "forge",
          run_command: "forge test --root ../acceptance --json",
          discover_command: "forge test --root ../acceptance --list --json",
          reporter_format: "forge-json",
        },
      },
    };
    const fixtureExec = (calls?: string[]) => (cmd: string) => {
      calls?.push(cmd);
      return cmd.includes("--list")
        ? { stdout: loadFixture("forge-root-sibling-list.json"), stderr: "", code: 0 }
        : { stdout: loadFixture("forge-root-sibling-run.json"), stderr: "", code: 1 };
    };

    it("reports a failed row for every discoverable test when setUp() reverts", () => {
      const calls: string[] = [];
      const result = runTests(rootConfig, {
        cwd: "/repo/packages/contracts",
        exec: fixtureExec(calls),
      });
      expect(result.ran).toBe(true);
      expect(result.tests).toHaveLength(78);

      // Run ids must be EXACTLY the discovery ids (manifest-drift invariant).
      const listedIds = new Set(
        parseForgeList(loadFixture("forge-root-sibling-list.json")).map((e) => e.id)
      );
      expect(new Set(result.tests.map((t) => t.id))).toEqual(listedIds);

      // The exact test the live MANIFEST_DRIFT halt reported as missing.
      const first = result.tests.find(
        (t) =>
          t.id ===
          "test/InsuranceFund.t.sol > InsuranceFundTest > test_feeReceipt_evenFee_splitsFiftyFifty"
      );
      expect(first?.status).toBe("failed");
      expect(first?.failure_message).toContain("setUp() reverted: STUB");

      // 60 synthesized reds + 18 rows forge actually ran.
      const synthesized = result.tests.filter((t) =>
        t.failure_message?.includes("setUp() reverted")
      );
      expect(synthesized).toHaveLength(60);
      expect(synthesized.every((t) => t.status === "failed")).toBe(true);
      expect(result.tests.length - synthesized.length).toBe(18);

      // Invariant tests are expanded too, not just unit tests.
      expect(result.tests.map((t) => t.id)).toContain(
        "test/Invariants.t.sol > InvariantsTest > invariant_backingCoversOutstanding"
      );

      // One extra exec: the run itself + one discover_command listing.
      expect(calls).toEqual([
        "forge test --root ../acceptance --json",
        "forge test --root ../acceptance --list --json",
      ]);
    });

    it("keeps one visible failed setUp row per contract when listing fails", () => {
      const result = runTests(rootConfig, {
        cwd: "/repo/packages/contracts",
        exec: (cmd) =>
          cmd.includes("--list")
            ? { stdout: "Error: forge exploded", stderr: "boom", code: 1 }
            : { stdout: loadFixture("forge-root-sibling-run.json"), stderr: "", code: 1 },
      });
      expect(result.ran).toBe(true);
      const setupRows = result.tests.filter((t) => t.id.endsWith(" > setUp"));
      expect(setupRows).toHaveLength(6);
      expect(setupRows.every((t) => t.status === "failed")).toBe(true);
      expect(result.tests).toHaveLength(24);
    });
  });

  it("returns ran=true with no tests when config declares no suites", () => {
    const result = runTests({ language: "solidity" }, { cwd: "/repo" });
    expect(result).toEqual({ ran: true, tests: [], suites: [] });
  });

  it("captures exec crashes as suite errors (exit_code null)", () => {
    const result = runTests(mkConfig(), {
      cwd: "/repo",
      exec: () => {
        throw new Error("spawn forge ENOENT");
      },
    });
    expect(result.ran).toBe(false);
    expect(result.error).toContain("spawn forge ENOENT");
    expect(result.suites[0]?.exit_code).toBeNull();
  });
});

// True end-to-end: needs a real forge binary. Gated behind FORGE_E2E so
// CI / dev machines without Foundry stay green. Run with:
//   FORGE_E2E=1 pnpm --filter @slowcook-ai/stack-solidity test
describe.skipIf(!process.env.FORGE_E2E)("runTests (e2e, real forge)", () => {
  it("runs a throwaway foundry project end to end", () => {
    const dir = mkdtempSync(join(tmpdir(), "stack-solidity-e2e-"));
    try {
      mkdirSync(join(dir, "src"));
      mkdirSync(join(dir, "test"));
      writeFileSync(
        join(dir, "foundry.toml"),
        '[profile.default]\nsrc = "src"\ntest = "test"\nout = "out"\nlibs = []\n'
      );
      writeFileSync(
        join(dir, "src", "Box.sol"),
        "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\ncontract Box { uint256 public v; function set(uint256 x) external { v = x; } }\n"
      );
      writeFileSync(
        join(dir, "test", "Box.t.sol"),
        '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\nimport {Box} from "../src/Box.sol";\ncontract BoxTest { Box b = new Box(); function test_set() public { b.set(7); require(b.v() == 7, "v"); } }\n'
      );
      const result = runTests(mkConfig(), { cwd: dir });
      expect(result.ran).toBe(true);
      expect(result.tests).toHaveLength(1);
      expect(result.tests[0]).toMatchObject({
        id: "test/Box.t.sol > BoxTest > test_set",
        status: "passed",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
