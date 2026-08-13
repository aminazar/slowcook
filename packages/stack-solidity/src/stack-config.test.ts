import { describe, it, expect } from "vitest";
import {
  validateSolidityStackConfig,
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
