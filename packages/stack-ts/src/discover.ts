import { execSync } from "node:child_process";
import type { TestEntry, SuiteRecord } from "@slowcook-ai/core";
import type { StackConfig } from "./stack-config.js";
import { parseByReporterFormat } from "./parsers.js";

export interface DiscoveryResult {
  tests: TestEntry[];
  suites: SuiteRecord[];
  /** Any suite-level errors we caught while discovering. Empty on success. */
  errors: { suite: string; message: string }[];
}

export interface DiscoverOptions {
  /** Working directory to run discovery commands in (usually repo root). */
  cwd: string;
  /** Max bytes to buffer per command (defaults to 64MB — vitest list can be large). */
  maxBuffer?: number;
  /** Optional custom exec (for tests). Default: execSync on Node. */
  exec?: (cmd: string, cwd: string, maxBuffer: number) => string;
}

const defaultExec = (cmd: string, cwd: string, maxBuffer: number): string =>
  execSync(cmd, { cwd, encoding: "utf8", maxBuffer });

/**
 * Run every declared test suite's discover_command and return a unified
 * list of tests plus per-suite metadata. A failing suite does not fail
 * the whole discovery — the error is captured in the result so the caller
 * can decide how strict to be.
 */
export function discoverTests(
  config: StackConfig,
  options: DiscoverOptions
): DiscoveryResult {
  const tests: TestEntry[] = [];
  const suites: SuiteRecord[] = [];
  const errors: { suite: string; message: string }[] = [];
  const exec = options.exec ?? defaultExec;
  const maxBuffer = options.maxBuffer ?? 64 * 1024 * 1024;

  if (!config.test) {
    return { tests, suites, errors };
  }

  for (const [suiteName, suite] of Object.entries(config.test)) {
    try {
      const output = exec(suite.discover_command, options.cwd, maxBuffer);
      const suiteTests = parseByReporterFormat(suite.reporter_format, output);
      tests.push(...suiteTests);
      suites.push({
        suite: suiteName,
        command: suite.discover_command,
        test_count: suiteTests.length,
      });
    } catch (e) {
      errors.push({ suite: suiteName, message: (e as Error).message });
    }
  }

  return { tests, suites, errors };
}
