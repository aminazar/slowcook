import { describe, it, expect } from "vitest";
import {
  getSolidityStackConfig,
  getSolidityStackFrozenFiles,
  getSolidityStackFrozenDirectories,
  STACK_ID,
} from "./templates.js";
import { validateSolidityStackConfig } from "./stack-config.js";

describe("getSolidityStackConfig", () => {
  it("emits valid JSON that passes validateSolidityStackConfig", () => {
    const raw = getSolidityStackConfig({ hasGasSnapshot: true });
    const parsed = JSON.parse(raw);
    const config = validateSolidityStackConfig(parsed);
    expect(config.language).toBe("solidity");
    expect(config.test?.["forge"]).toEqual({
      runner: "forge",
      run_command: "forge test --json",
      discover_command: "forge test --list --json",
      reporter_format: "forge-json",
    });
    expect(config.lint).toEqual({ lint_command: "forge fmt --check" });
    expect(config.gas_snapshot).toEqual({
      snapshot_command: "forge snapshot",
      snapshot_file: ".gas-snapshot",
    });
  });

  it("omits the gas_snapshot block when hasGasSnapshot is false", () => {
    const parsed = JSON.parse(getSolidityStackConfig({ hasGasSnapshot: false }));
    expect(parsed.gas_snapshot).toBeUndefined();
    expect(parsed.$doc).not.toContain("gas ratchet");
  });

  it("documents the gas ratchet when enabled", () => {
    const parsed = JSON.parse(getSolidityStackConfig({ hasGasSnapshot: true }));
    expect(parsed.$doc).toContain("gas ratchet");
  });

  it("ends with a trailing newline (file-write convention)", () => {
    expect(getSolidityStackConfig({ hasGasSnapshot: false }).endsWith("\n")).toBe(true);
  });
});

describe("frozen paths", () => {
  it("freezes foundry.toml and the gas snapshot baseline", () => {
    expect(getSolidityStackFrozenFiles()).toContain("foundry.toml");
    expect(getSolidityStackFrozenFiles()).toContain(".gas-snapshot");
  });

  it("freezes vendored deps", () => {
    expect(getSolidityStackFrozenDirectories()).toEqual(["lib/"]);
  });
});

describe("STACK_ID", () => {
  it("is 'solidity'", () => {
    expect(STACK_ID).toBe("solidity");
  });
});
