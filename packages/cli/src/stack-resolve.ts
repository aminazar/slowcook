/**
 * Stack dispatch — routes CLI commands to the right stack adapter based
 * on `.brewing/stack.json`'s `language` field:
 *
 *   "typescript" / "javascript" → @slowcook-ai/stack-ts
 *   "solidity"                  → @slowcook-ai/stack-solidity
 *
 * The adapters are shape-compatible by design (stack-solidity re-declares
 * stack-ts's RunResult/TestResult/LintResult/DiscoveryResult rather than
 * importing them), so callers keep using stack-ts's types as the lingua
 * franca. Besides `resolveStack(brewingDir)` this module exports
 * dispatching drop-ins (`runTests`, `runLint`, `validateStackConfig`,
 * `discoverTests`) so call sites only swap the import source. One
 * signature difference: `runLint` here takes the FULL stack config (it
 * needs `language` to dispatch) where stack-ts's takes just the lint block.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  runTests as runTsTests,
  runLint as runTsLint,
  discoverTests as discoverTsTests,
  validateStackConfig as validateTsStackConfig,
  type StackConfig as TsStackConfig,
  type RunOptions,
  type RunResult,
  type RunLintOptions,
  type LintResult,
  type DiscoverOptions,
  type DiscoveryResult,
} from "@slowcook-ai/stack-ts";
import {
  runTests as runSolidityTests,
  runLint as runSolidityLint,
  discoverTests as discoverSolidityTests,
  validateSolidityStackConfig,
  type SolidityStackConfig,
  type RunOptions as SolidityRunOptions,
  type RunLintOptions as SolidityRunLintOptions,
  type DiscoverOptions as SolidityDiscoverOptions,
} from "@slowcook-ai/stack-solidity";

/** Union of all supported stack configs. `language` discriminates. */
export type StackConfig = TsStackConfig | SolidityStackConfig;

export interface StackAdapter {
  /** Languages this adapter serves. */
  languages: readonly string[];
  validateStackConfig(raw: unknown): StackConfig;
  runTests(config: StackConfig, options: RunOptions): RunResult;
  /** Takes the full config (not just the lint block) so dispatch stays uniform. */
  runLint(config: StackConfig, options: RunLintOptions): LintResult;
  discoverTests(config: StackConfig, options: DiscoverOptions): DiscoveryResult;
}

const tsAdapter: StackAdapter = {
  languages: ["typescript", "javascript"],
  validateStackConfig: (raw) => validateTsStackConfig(raw),
  runTests: (config, options) => runTsTests(config as TsStackConfig, options),
  runLint: (config, options) => runTsLint((config as TsStackConfig).lint, options),
  discoverTests: (config, options) => discoverTsTests(config as TsStackConfig, options),
};

const solidityAdapter: StackAdapter = {
  languages: ["solidity"],
  validateStackConfig: (raw) => validateSolidityStackConfig(raw),
  runTests: (config, options) =>
    runSolidityTests(config as SolidityStackConfig, options as SolidityRunOptions),
  runLint: (config, options) =>
    runSolidityLint(
      (config as SolidityStackConfig).lint,
      options as SolidityRunLintOptions
    ),
  discoverTests: (config, options) =>
    discoverSolidityTests(
      config as SolidityStackConfig,
      options as SolidityDiscoverOptions
    ),
};

/**
 * Adapter for a language string. Unknown languages fall through to the
 * TS adapter so its validator produces the canonical "language must
 * be ..." error (mirrors pre-dispatch behaviour for bad configs).
 */
export function adapterForLanguage(language: unknown): StackAdapter {
  if (language === "solidity") return solidityAdapter;
  return tsAdapter;
}

/**
 * Read `<brewingDir>/stack.json` and return the adapter matching its
 * `language`. Throws (ENOENT / SyntaxError) when the file is missing or
 * malformed — same failure surface callers already handle for the file
 * read itself.
 */
export function resolveStack(brewingDir: string): StackAdapter {
  const raw = JSON.parse(
    readFileSync(join(brewingDir, "stack.json"), "utf8")
  ) as { language?: unknown };
  return adapterForLanguage(raw.language);
}

/** Dispatching drop-in for stack-ts's validateStackConfig. */
export function validateStackConfig(raw: unknown): StackConfig {
  const language =
    raw && typeof raw === "object"
      ? (raw as Record<string, unknown>)["language"]
      : undefined;
  return adapterForLanguage(language).validateStackConfig(raw);
}

/** Dispatching drop-in for stack-ts's runTests. */
export function runTests(config: StackConfig, options: RunOptions): RunResult {
  return adapterForLanguage(config.language).runTests(config, options);
}

/**
 * Dispatching lint runner. NOTE: takes the full stack config where
 * stack-ts's runLint takes `config.lint` — the language field is what
 * picks the adapter.
 */
export function runLint(config: StackConfig, options: RunLintOptions): LintResult {
  return adapterForLanguage(config.language).runLint(config, options);
}

/** Dispatching drop-in for stack-ts's discoverTests. */
export function discoverTests(
  config: StackConfig,
  options: DiscoverOptions
): DiscoveryResult {
  return adapterForLanguage(config.language).discoverTests(config, options);
}
