// Shape of .brewing/stack.json as consumed by the stack-solidity adapter.
// Mirrors @slowcook-ai/stack-ts's stack-config.ts; additional fields in the
// file are allowed and ignored (forward compatibility).

export type ReporterFormat = "forge-json";

export interface SuiteConfig {
  runner: string;
  run_command: string;
  discover_command: string;
  reporter_format: ReporterFormat | string;
}

/**
 * Lint config for Foundry projects. Solidity has no separate typecheck
 * step (the compiler IS the typecheck, and it runs as part of
 * `forge test`), so unlike stack-ts there is no typecheck_command.
 * Default lint_command in the init template is `forge fmt --check`.
 */
export interface SolidityLintConfig {
  /** Optional. Shell command run after each successful brew edit. Errors fold into the next-iter prompt. */
  lint_command?: string;
}

/**
 * Gas-snapshot ratchet block. Optional — projects that don't track a
 * `.gas-snapshot` file simply omit it.
 */
export interface GasSnapshotConfig {
  /** Base snapshot command. Default: "forge snapshot". `--check` is appended for the ratchet check. */
  snapshot_command?: string;
  /** Snapshot file path (forge's `--snap <file>`). Default: forge's own ".gas-snapshot". */
  snapshot_file?: string;
}

export interface SolidityStackConfig {
  language: "solidity";
  package_manager?: string;
  test?: Record<string, SuiteConfig>;
  /** Optional lint command. Missing or empty means brew skips lint signals (no-op). */
  lint?: SolidityLintConfig;
  /** Optional gas-snapshot ratchet configuration. */
  gas_snapshot?: GasSnapshotConfig;
}

export class StackConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StackConfigError";
  }
}

export function validateSolidityStackConfig(raw: unknown): SolidityStackConfig {
  if (!raw || typeof raw !== "object") {
    throw new StackConfigError("stack.json must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const language = obj["language"];
  if (language !== "solidity") {
    throw new StackConfigError(
      `stack.json 'language' must be "solidity", got ${JSON.stringify(language)}`
    );
  }
  const config: SolidityStackConfig = {
    language,
  };
  if (typeof obj["package_manager"] === "string") {
    config.package_manager = obj["package_manager"];
  }
  if (obj["test"] && typeof obj["test"] === "object") {
    const suites: Record<string, SuiteConfig> = {};
    for (const [name, suite] of Object.entries(obj["test"] as Record<string, unknown>)) {
      if (!suite || typeof suite !== "object") continue;
      const s = suite as Record<string, unknown>;
      if (
        typeof s["runner"] !== "string" ||
        typeof s["run_command"] !== "string" ||
        typeof s["discover_command"] !== "string" ||
        typeof s["reporter_format"] !== "string"
      ) {
        throw new StackConfigError(
          `stack.json test.${name} missing required fields (runner, run_command, discover_command, reporter_format)`
        );
      }
      suites[name] = {
        runner: s["runner"],
        run_command: s["run_command"],
        discover_command: s["discover_command"],
        reporter_format: s["reporter_format"] as ReporterFormat,
      };
    }
    config.test = suites;
  }
  // Lint block. Tolerate missing or partial blocks; the command is
  // optional. Brew uses what's set and skips what isn't.
  if (obj["lint"] && typeof obj["lint"] === "object") {
    const l = obj["lint"] as Record<string, unknown>;
    const lint: SolidityLintConfig = {};
    if (typeof l["lint_command"] === "string" && l["lint_command"].length > 0) {
      lint.lint_command = l["lint_command"];
    }
    if (lint.lint_command) {
      config.lint = lint;
    }
  }
  // Gas-snapshot ratchet block. Both fields optional; an empty object
  // still counts as "ratchet enabled with defaults".
  if (obj["gas_snapshot"] && typeof obj["gas_snapshot"] === "object") {
    const g = obj["gas_snapshot"] as Record<string, unknown>;
    const gas: GasSnapshotConfig = {};
    if (typeof g["snapshot_command"] === "string" && g["snapshot_command"].length > 0) {
      gas.snapshot_command = g["snapshot_command"];
    }
    if (typeof g["snapshot_file"] === "string" && g["snapshot_file"].length > 0) {
      gas.snapshot_file = g["snapshot_file"];
    }
    config.gas_snapshot = gas;
  }
  return config;
}
