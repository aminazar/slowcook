import { describe, it, expect } from "vitest";
import {
  validateSolidityStackConfig,
  resolveSuiteEnv,
  StackConfigError,
} from "./stack-config.js";

const VALID = {
  language: "solidity",
  test: {
    forge: {
      runner: "forge",
      run_command: "forge test --json",
      discover_command: "forge test --list --json",
      reporter_format: "forge-json",
    },
  },
  lint: {
    lint_command: "forge fmt --check",
  },
  gas_snapshot: {
    snapshot_command: "forge snapshot",
    snapshot_file: ".gas-snapshot",
  },
};

describe("validateSolidityStackConfig", () => {
  it("accepts a full valid config", () => {
    const config = validateSolidityStackConfig(VALID);
    expect(config.language).toBe("solidity");
    expect(config.test?.["forge"]?.runner).toBe("forge");
    expect(config.lint?.lint_command).toBe("forge fmt --check");
    expect(config.gas_snapshot?.snapshot_file).toBe(".gas-snapshot");
  });

  it("rejects non-object input", () => {
    expect(() => validateSolidityStackConfig(null)).toThrow(StackConfigError);
    expect(() => validateSolidityStackConfig("solidity")).toThrow(
      StackConfigError
    );
  });

  it("rejects wrong language", () => {
    expect(() =>
      validateSolidityStackConfig({ language: "typescript" })
    ).toThrow(/'language' must be "solidity"/);
  });

  it("rejects a suite missing required fields", () => {
    expect(() =>
      validateSolidityStackConfig({
        language: "solidity",
        test: { forge: { runner: "forge" } },
      })
    ).toThrow(/test\.forge missing required fields/);
  });

  it("accepts a minimal config (language only)", () => {
    const config = validateSolidityStackConfig({ language: "solidity" });
    expect(config).toEqual({ language: "solidity" });
  });

  it("drops an empty lint block (no command set)", () => {
    const config = validateSolidityStackConfig({
      language: "solidity",
      lint: { lint_command: "" },
    });
    expect(config.lint).toBeUndefined();
  });

  it("keeps an empty gas_snapshot block (ratchet enabled with defaults)", () => {
    const config = validateSolidityStackConfig({
      language: "solidity",
      gas_snapshot: {},
    });
    expect(config.gas_snapshot).toEqual({});
  });

  it("ignores unknown fields (forward compatibility)", () => {
    const config = validateSolidityStackConfig({
      language: "solidity",
      $doc: "hi",
      future_field: 42,
    });
    expect(config.language).toBe("solidity");
  });

  it("ignores a typecheck_command in lint (Solidity has no typecheck channel)", () => {
    const config = validateSolidityStackConfig({
      language: "solidity",
      lint: { lint_command: "forge fmt --check", typecheck_command: "tsc" },
    });
    expect(config.lint).toEqual({ lint_command: "forge fmt --check" });
  });
});

// --- suite env (the dovizir story-002 gap) --------------------------------
// The referee suite selects its implementation via vm.envOr("DOVIZIR_DEPLOYER",
// <stub>), and the stub reverts "STUB" on every call. With no way to express
// that variable, brew ran the stub forever: 9/9 red, unwinnable by any agent.
describe("suite env", () => {
  const withEnv = (env: unknown) =>
    validateSolidityStackConfig({
      language: "solidity",
      test: {
        forge: {
          runner: "forge",
          run_command: "forge test --root ../acceptance",
          discover_command: "forge test --root ../acceptance --list --json",
          reporter_format: "forge-json",
          env,
        },
      },
    });

  it("carries declared env through validation", () => {
    const c = withEnv({ DOVIZIR_DEPLOYER: "src/arm/ArmBDeployer.sol:ArmBDeployer" });
    expect(c.test!["forge"]!.env).toEqual({
      DOVIZIR_DEPLOYER: "src/arm/ArmBDeployer.sol:ArmBDeployer",
    });
  });

  it("leaves env undefined when the suite declares none (no behaviour change)", () => {
    const c = validateSolidityStackConfig({
      language: "solidity",
      test: {
        forge: {
          runner: "forge",
          run_command: "forge test",
          discover_command: "forge test --list --json",
          reporter_format: "forge-json",
        },
      },
    });
    expect(c.test!["forge"]!.env).toBeUndefined();
  });

  it("refuses non-string values instead of coercing them", () => {
    expect(() => withEnv({ RUNS: 256 })).toThrow(/env\.RUNS must be a string, got number/);
  });

  it("refuses an env that isn't an object", () => {
    expect(() => withEnv("DOVIZIR_DEPLOYER=x")).toThrow(/must be an object of string values/);
    expect(() => withEnv(["A=1"])).toThrow(/must be an object of string values/);
  });
});

describe("resolveSuiteEnv", () => {
  it("returns undefined for an undeclared env", () => {
    expect(resolveSuiteEnv(undefined)).toBeUndefined();
  });

  it("passes literal values through untouched", () => {
    expect(resolveSuiteEnv({ A: "src/arm/D.sol:D" }, {})).toEqual({ A: "src/arm/D.sol:D" });
  });

  it("expands ${VAR} from the ambient environment so secrets stay out of the repo", () => {
    expect(resolveSuiteEnv({ RPC: "${BASE_RPC}/v1" }, { BASE_RPC: "https://x" } as NodeJS.ProcessEnv))
      .toEqual({ RPC: "https://x/v1" });
  });

  it("expands several references in one value", () => {
    expect(resolveSuiteEnv({ U: "${A}-${B}" }, { A: "1", B: "2" } as NodeJS.ProcessEnv))
      .toEqual({ U: "1-2" });
  });

  it("NAMES an unset variable rather than silently expanding to empty", () => {
    // An empty value looks plausible to the runner and fails far from here.
    expect(() => resolveSuiteEnv({ RPC: "${MISSING_RPC}" }, {} as NodeJS.ProcessEnv))
      .toThrow(/RPC references \$\{MISSING_RPC\}, which is not set/);
  });

  it("an empty-string ambient value is set, and is not an error", () => {
    expect(resolveSuiteEnv({ A: "${EMPTY}" }, { EMPTY: "" } as NodeJS.ProcessEnv)).toEqual({ A: "" });
  });
});
