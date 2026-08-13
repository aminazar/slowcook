// Actually run forge tests and parse results. Mirrors stack-ts's run.ts
// semantics: RunResult/TestResult have the identical shape (re-declared in
// parsers.ts — adapters never import each other) so the CLI can consume
// either stack through the same code path.

import { execSync } from "node:child_process";
import type { SolidityStackConfig } from "./stack-config.js";
import { parseForgeJson, type TestResult } from "./parsers.js";

export type { TestResult } from "./parsers.js";

export interface RunResult {
  /** Aggregate: did the runner itself complete cleanly? (true even if tests failed) */
  ran: boolean;
  /** If !ran: why. E.g., "exit 1 with no JSON output — compilation failed". */
  error?: string;
  tests: TestResult[];
  /** Per-suite metadata for diagnostics. */
  suites: {
    suite: string;
    command: string;
    exit_code: number | null;
    stdout_bytes: number;
  }[];
}

export interface RunOptions {
  cwd: string;
  maxBuffer?: number;
  /** Inject for tests. Receives cmd + cwd; returns { stdout, stderr, code }. */
  exec?: (cmd: string, cwd: string) => { stdout: string; stderr: string; code: number };
  /**
   * When set, scope the run to these test file paths via forge's
   * `--match-path` glob. Mirrors stack-ts's bounded-attention scoped
   * runs (brew per-iter loop / sift regression scoping). Falls through
   * to a full-suite run when undefined or empty.
   */
  scopeFiles?: string[];
}

export function runTests(config: SolidityStackConfig, options: RunOptions): RunResult {
  const tests: TestResult[] = [];
  const suites: RunResult["suites"] = [];
  const errors: string[] = [];
  const exec = options.exec ?? defaultExec;

  if (!config.test) {
    return { ran: true, tests, suites };
  }

  for (const [suiteName, suite] of Object.entries(config.test)) {
    // For `run` we want forge's JSON output. Append `--json` to the
    // declared run_command if it's a forge command and doesn't already
    // specify it. Keep it additive (caller can override in stack.json).
    let cmd = shouldAppendJson(suite.run_command)
      ? `${suite.run_command} --json`
      : suite.run_command;

    // Bounded-attention scoped runs: forge takes a single --match-path
    // glob; multiple files become a `{a,b}` alternation (forge's glob
    // matcher supports brace sets). Skipped for non-forge runners.
    if (
      options.scopeFiles &&
      options.scopeFiles.length > 0 &&
      /\bforge\b/.test(suite.run_command)
    ) {
      const glob =
        options.scopeFiles.length === 1
          ? options.scopeFiles[0]!
          : `{${options.scopeFiles.join(",")}}`;
      cmd = `${cmd} --match-path ${shellQuote(glob)}`;
    }

    try {
      const { stdout, stderr, code } = exec(cmd, options.cwd);
      suites.push({
        suite: suiteName,
        command: cmd,
        exit_code: code,
        stdout_bytes: stdout.length,
      });
      const parsed = parseForgeJson(stdout, options.cwd);
      if (parsed.length === 0 && code !== 0) {
        // Compilation error path: forge exits non-zero, prints
        // "Compiler run failed: ..." on stdout and "Error: Compilation
        // failed" on stderr — no JSON at all. Surface both streams.
        const detail = (stderr.trim() || stdout.trim()).slice(0, 400);
        errors.push(`[${suiteName}] exit ${code}, no parsable JSON. ${detail}`);
      }
      tests.push(...parsed);
    } catch (e) {
      errors.push(`[${suiteName}] ${(e as Error).message}`);
      suites.push({
        suite: suiteName,
        command: cmd,
        exit_code: null,
        stdout_bytes: 0,
      });
    }
  }

  return errors.length === 0
    ? { ran: true, tests, suites }
    : { ran: false, error: errors.join("; "), tests, suites };
}

function shouldAppendJson(cmd: string): boolean {
  if (!/\bforge\s+test\b/.test(cmd)) return false;
  if (/--json\b/.test(cmd)) return false;
  return true;
}

/** Conservative shell quoting — bare-word paths pass through unquoted. */
function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function defaultExec(
  cmd: string,
  cwd: string
): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execSync(cmd, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 128 * 1024 * 1024,
    });
    return { stdout, stderr: "", code: 0 };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      stdout: typeof err.stdout === "string" ? err.stdout : (err.stdout?.toString("utf8") ?? ""),
      stderr: typeof err.stderr === "string" ? err.stderr : (err.stderr?.toString("utf8") ?? ""),
      code: err.status ?? 1,
    };
  }
}
