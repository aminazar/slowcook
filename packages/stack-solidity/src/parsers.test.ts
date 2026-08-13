import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  parseForgeJson,
  parseForgeRun,
  parseForgeList,
  parseByReporterFormat,
  parseForgeDuration,
} from "./parsers.js";

// Fixtures are REAL forge 1.3.2 output, captured from live runs and
// committed (see fixtures/ — passing set from a 5-test Foundry project,
// failure/fuzz/compile-error cases from a throwaway counter project).
// Tests never need forge installed.
const loadFixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

describe("parseForgeJson", () => {
  it("parses a real all-passing forge test --json run (5 unit tests)", () => {
    const tests = parseForgeJson(loadFixture("forge-test-pass.json"));
    expect(tests).toHaveLength(5);
    expect(tests.every((t) => t.status === "passed")).toBe(true);
    const deposit = tests.find((t) => t.id.includes("test_depositCreditsMember"));
    expect(deposit).toMatchObject({
      id: "test/Smoke.t.sol > SmokeTest > test_depositCreditsMember",
      file: "test/Smoke.t.sol",
      status: "passed",
      gas: 32646,
    });
    expect(deposit?.duration_ms).toBeGreaterThan(0);
  });

  it("parses a real mixed run: failure with reason, fuzz stats, passing unit", () => {
    const tests = parseForgeJson(loadFixture("forge-test-fail.json"));
    expect(tests).toHaveLength(3);

    const failed = tests.find((t) => t.id.includes("test_failsOnPurpose"));
    expect(failed).toMatchObject({
      id: "test/Counter.t.sol > CounterTest > test_failsOnPurpose",
      file: "test/Counter.t.sol",
      status: "failed",
      failure_message: "expected 2 but increment only adds 1",
    });

    const fuzz = tests.find((t) => t.id.includes("testFuzz_add"));
    // Signature "(uint128)" stripped so the id matches `forge test --list` names.
    expect(fuzz?.id).toBe("test/Counter.t.sol > CounterTest > testFuzz_add");
    expect(fuzz?.status).toBe("passed");
    expect(fuzz?.fuzz).toEqual({ runs: 256, mean_gas: 29247, median_gas: 29403 });
    expect(fuzz?.gas).toBe(29247);

    const unit = tests.find((t) => t.id.includes("test_incrementOnce"));
    expect(unit?.status).toBe("passed");
  });

  it("returns [] for real compile-error output (no JSON emitted)", () => {
    expect(parseForgeJson(loadFixture("compile-error.stdout.txt"))).toEqual([]);
    expect(parseForgeJson(loadFixture("compile-error.stderr.txt"))).toEqual([]);
  });

  it("returns [] for empty / garbage input", () => {
    expect(parseForgeJson("")).toEqual([]);
    expect(parseForgeJson("not json at all")).toEqual([]);
    expect(parseForgeJson("{ truncated")).toEqual([]);
  });

  it("tolerates noise before the JSON object", () => {
    const noisy = "Compiling 2 files\nwarning: blah\n" + loadFixture("forge-test-fail.json");
    expect(parseForgeJson(noisy)).toHaveLength(3);
  });

  it("includes the fuzz counterexample in the failure message when present", () => {
    const stdout = JSON.stringify({
      "test/X.t.sol:XTest": {
        test_results: {
          "testFuzz_bad(uint256)": {
            status: "Failure",
            reason: "assertion failed",
            counterexample: { Single: { calldata: "0xdead", args: ["3"] } },
            kind: { Fuzz: { runs: 12, mean_gas: 100, median_gas: 90 } },
          },
        },
      },
    });
    const tests = parseForgeJson(stdout);
    expect(tests[0]?.status).toBe("failed");
    expect(tests[0]?.failure_message).toContain("assertion failed");
    expect(tests[0]?.failure_message).toContain("counterexample");
  });

  it("maps Skipped to skipped and unknown statuses to errored", () => {
    const stdout = JSON.stringify({
      "test/X.t.sol:XTest": {
        test_results: {
          "test_a()": { status: "Skipped" },
          "test_b()": { status: "SomethingNew" },
        },
      },
    });
    const byId = Object.fromEntries(parseForgeJson(stdout).map((t) => [t.id, t.status]));
    expect(byId["test/X.t.sol > XTest > test_a"]).toBe("skipped");
    expect(byId["test/X.t.sol > XTest > test_b"]).toBe("errored");
  });
});

// Fixtures forge-root-sibling-{run,list}.json are REAL forge 1.3.2 output
// captured from the Dovizir acceptance project (78 tests: unit + fuzz +
// invariants across 9 contracts) run with `--root <sibling dir>` from a
// separate cwd — the exact layout of the live arm-B failure. 6 of the 9
// contracts' setUp() revert with "STUB", so the run output collapses to
// 24 rows (18 real tests + 6 synthetic "setUp()" entries) while the list
// output discovers all 78.
describe("parseForgeRun — setUp() collapse (root-sibling fixtures)", () => {
  it("separates setUp() failures from real test rows", () => {
    const { tests, setup_failures } = parseForgeRun(
      loadFixture("forge-root-sibling-run.json")
    );
    expect(tests).toHaveLength(18);
    expect(tests.every((t) => !t.id.endsWith(" > setUp"))).toBe(true);
    expect(setup_failures).toHaveLength(6);
    expect(setup_failures).toContainEqual({
      file: "test/InsuranceFund.t.sol",
      contract: "InsuranceFundTest",
      message: "STUB",
    });
    expect(setup_failures).toContainEqual({
      file: "test/Invariants.t.sol",
      contract: "InvariantsTest",
      message: "STUB",
    });
  });

  it("parseForgeJson (tests-only wrapper) excludes the synthetic setUp rows", () => {
    expect(parseForgeJson(loadFixture("forge-root-sibling-run.json"))).toHaveLength(18);
  });

  it("reports no setup_failures for healthy runs", () => {
    const { setup_failures } = parseForgeRun(loadFixture("forge-test-pass.json"));
    expect(setup_failures).toEqual([]);
  });
});

describe("parseForgeList", () => {
  it("discovers all 78 tests (unit + fuzz + invariant) in the root-sibling fixture", () => {
    const entries = parseForgeList(loadFixture("forge-root-sibling-list.json"));
    expect(entries).toHaveLength(78);
    const ids = entries.map((e) => e.id);
    // The exact test the live MANIFEST_DRIFT halt named as "first missing".
    expect(ids).toContain(
      "test/InsuranceFund.t.sol > InsuranceFundTest > test_feeReceipt_evenFee_splitsFiftyFifty"
    );
    expect(ids).toContain(
      "test/Invariants.t.sol > InvariantsTest > invariant_backingCoversOutstanding"
    );
  });

  it("parses real forge test --list --json output", () => {
    const tests = parseForgeList(loadFixture("forge-list.json"));
    expect(tests).toHaveLength(5);
    expect(tests[0]).toEqual({
      id: "test/Smoke.t.sol > SmokeTest > test_depositCreditsMember",
      file: "test/Smoke.t.sol",
    });
  });

  it("produces ids consistent with parseForgeJson for the same project (fuzz included)", () => {
    const listed = parseForgeList(loadFixture("forge-list-fuzz.json")).map((t) => t.id);
    const ran = parseForgeJson(loadFixture("forge-test-fail.json")).map((t) => t.id);
    expect(new Set(ran)).toEqual(new Set(listed));
  });

  it("returns [] for empty or non-JSON output", () => {
    expect(parseForgeList("")).toEqual([]);
    expect(parseForgeList("Error: something")).toEqual([]);
  });
});

describe("parseByReporterFormat", () => {
  it("routes forge-json to the list parser (discovery path)", () => {
    const tests = parseByReporterFormat("forge-json", loadFixture("forge-list.json"));
    expect(tests).toHaveLength(5);
  });

  it("throws on an unknown reporter format", () => {
    expect(() => parseByReporterFormat("vitest-list-lines", "")).toThrow(
      /Unknown reporter_format/
    );
  });
});

describe("parseForgeDuration", () => {
  it("sums forge's humanised duration components", () => {
    expect(parseForgeDuration("5ms 707µs 750ns")).toBeCloseTo(5.708, 2);
    expect(parseForgeDuration("1s 5ms")).toBe(1005);
    expect(parseForgeDuration("797µs 917ns")).toBeCloseTo(0.798, 2);
  });

  it("returns undefined for missing or unparseable input", () => {
    expect(parseForgeDuration(undefined)).toBeUndefined();
    expect(parseForgeDuration("")).toBeUndefined();
    expect(parseForgeDuration("fast")).toBeUndefined();
  });
});
