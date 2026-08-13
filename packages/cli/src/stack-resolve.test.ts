import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import {
  resolveStack,
  adapterForLanguage,
  validateStackConfig,
  runTests,
  runLint,
  discoverTests,
} from "./stack-resolve.js";

const TS_CONFIG = {
  language: "typescript" as const,
  test: {
    backend: {
      runner: "vitest",
      run_command: "npx vitest run",
      discover_command: "npx vitest list",
      reporter_format: "vitest-list-lines",
    },
  },
  lint: { lint_command: "npm run lint" },
};

const SOLIDITY_CONFIG = {
  language: "solidity" as const,
  test: {
    forge: {
      runner: "forge",
      run_command: "forge test --json",
      discover_command: "forge test --list --json",
      reporter_format: "forge-json",
    },
  },
  lint: { lint_command: "forge fmt --check" },
};

// Minimal real forge JSON (shape fixture-verified in stack-solidity).
const FORGE_JSON = JSON.stringify({
  "test/A.t.sol:ATest": {
    test_results: {
      "test_ok()": { status: "Success", kind: { Unit: { gas: 100 } } },
    },
  },
});

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function mkBrewingDir(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "stack-resolve-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "stack.json"), JSON.stringify(config));
  return dir;
}

describe("resolveStack", () => {
  it("routes typescript to the TS adapter", () => {
    const adapter = resolveStack(mkBrewingDir(TS_CONFIG));
    expect(adapter.languages).toContain("typescript");
  });

  it("routes solidity to the Solidity adapter", () => {
    const adapter = resolveStack(mkBrewingDir(SOLIDITY_CONFIG));
    expect(adapter.languages).toEqual(["solidity"]);
  });

  it("throws when stack.json is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "stack-resolve-empty-"));
    tempDirs.push(dir);
    expect(() => resolveStack(dir)).toThrow();
  });
});

describe("validateStackConfig (dispatching)", () => {
  it("validates a TS config via stack-ts", () => {
    const config = validateStackConfig(TS_CONFIG);
    expect(config.language).toBe("typescript");
  });

  it("validates a Solidity config via stack-solidity (gas_snapshot survives)", () => {
    const config = validateStackConfig({
      ...SOLIDITY_CONFIG,
      gas_snapshot: { snapshot_file: ".gas-snapshot" },
    });
    expect(config.language).toBe("solidity");
    expect((config as { gas_snapshot?: unknown }).gas_snapshot).toEqual({
      snapshot_file: ".gas-snapshot",
    });
  });

  it("falls through to the TS validator's canonical error for unknown languages", () => {
    expect(() => validateStackConfig({ language: "cobol" })).toThrow(
      /'language' must be "typescript" or "javascript"/
    );
  });
});

describe("runTests (dispatching)", () => {
  it("uses forge semantics for solidity configs (appends --json, parses forge output)", () => {
    const calls: string[] = [];
    const result = runTests(validateStackConfig(SOLIDITY_CONFIG), {
      cwd: "/repo",
      exec: (cmd) => {
        calls.push(cmd);
        return { stdout: FORGE_JSON, stderr: "", code: 0 };
      },
    });
    expect(calls).toEqual(["forge test --json"]);
    expect(result.ran).toBe(true);
    expect(result.tests[0]).toMatchObject({
      id: "test/A.t.sol > ATest > test_ok",
      status: "passed",
    });
  });

  it("uses vitest semantics for typescript configs (appends --reporter=json)", () => {
    const calls: string[] = [];
    runTests(validateStackConfig(TS_CONFIG), {
      cwd: "/repo",
      exec: (cmd) => {
        calls.push(cmd);
        return { stdout: "{}", stderr: "", code: 0 };
      },
    });
    expect(calls).toEqual(["npx vitest run --reporter=json"]);
  });
});

describe("runLint (dispatching, takes the full config)", () => {
  it("runs the solidity lint command and adapts fmt diffs to LintResult", () => {
    const result = runLint(validateStackConfig(SOLIDITY_CONFIG), {
      cwd: "/repo",
      exec: (cmd) => {
        expect(cmd).toBe("forge fmt --check");
        return { stdout: "Diff in src/Messy.sol:\n1 | x\n", stderr: "", code: 1 };
      },
    });
    expect(result.ran).toBe(true);
    expect(result.clean).toBe(false);
    expect(result.issues[0]).toMatchObject({
      source: "lint",
      file: "src/Messy.sol",
      severity: "error",
    });
  });

  it("is a no-op when the config has no lint block", () => {
    const result = runLint(validateStackConfig({ language: "solidity" }), {
      cwd: "/repo",
    });
    expect(result).toEqual({ ran: false, clean: true, issues: [], duration_ms: 0 });
  });
});

describe("discoverTests (dispatching)", () => {
  it("parses forge list output for solidity configs", () => {
    const result = discoverTests(validateStackConfig(SOLIDITY_CONFIG), {
      cwd: "/repo",
      exec: () => JSON.stringify({ "test/A.t.sol": { ATest: ["test_ok"] } }),
    });
    expect(result.errors).toEqual([]);
    expect(result.tests).toEqual([
      { id: "test/A.t.sol > ATest > test_ok", file: "test/A.t.sol" },
    ]);
  });
});

describe("adapterForLanguage", () => {
  it("defaults unknown languages to the TS adapter", () => {
    expect(adapterForLanguage("go").languages).toContain("typescript");
    expect(adapterForLanguage(undefined).languages).toContain("typescript");
  });
});
