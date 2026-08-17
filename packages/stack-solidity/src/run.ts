// Actually run forge tests and parse results. Mirrors stack-ts's run.ts
// semantics: RunResult/TestResult have the identical shape (re-declared in
// parsers.ts — adapters never import each other) so the CLI can consume
// either stack through the same code path.

import { execSync } from "node:child_process";
import { resolveSuiteEnv, type SolidityStackConfig, type SuiteConfig } from "./stack-config.js";
import {
  parseForgeRun,
  parseForgeList,
  type SetupFailure,
  type TestResult,
} from "./parsers.js";

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
  /** When set, a compilation failure synthesizes these ids as FAILED tests
   *  (vitest semantics) instead of a runner error (r4a dogfood). */
  expectedTestIds?: string[];
  cwd: string;
  maxBuffer?: number;
  /** Inject for tests. Receives cmd + cwd; returns { stdout, stderr, code }. */
  exec?: (cmd: string, cwd: string, env?: Record<string, string>) => { stdout: string; stderr: string; code: number };
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
    // Throws with the variable name if a ${VAR} reference is unset.
    const suiteEnv = resolveSuiteEnv(suite.env);
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
      const { stdout, stderr, code } = exec(cmd, options.cwd, suiteEnv);
      suites.push({
        suite: suiteName,
        command: cmd,
        exit_code: code,
        stdout_bytes: stdout.length,
      });
      const parsed = parseForgeRun(stdout, options.cwd);
      if (parsed.tests.length === 0 && parsed.setup_failures.length === 0 && code !== 0) {
        // Compilation error path: forge exits non-zero with no JSON at all.
        //
        // r4a dogfood (2026-08-15): when the AGENT'S OWN new module fails to
        // compile, this used to surface as a runner error → brew halted
        // TEST_RUNNER_BROKEN, throwing away the most actionable feedback a
        // turn can get. Vitest's semantics are the model: a compile error IS
        // a failing test. So every manifest-scoped test the run was asked
        // for is synthesized as FAILED, carrying the compiler's message —
        // the runner ran, honestly reporting that nothing can pass until
        // the code compiles.
        const detail = (stderr.trim() || stdout.trim()).slice(0, 1200);
        const compileFail = /compil|solc|parser error|expected/i.test(detail);
        if (compileFail && options.expectedTestIds && options.expectedTestIds.length > 0) {
          for (const id of options.expectedTestIds) {
            tests.push({
              id,
              file: id.split(" > ")[0] ?? "",
              status: "failed",
              duration_ms: 0,
              failure_message: `Compilation failed — no test can run until this is fixed:\n${detail}`,
            });
          }
        } else {
          errors.push(`[${suiteName}] exit ${code}, no parsable JSON. ${detail.slice(0, 400)}`);
        }
      }
      tests.push(...parsed.tests);
      if (parsed.setup_failures.length > 0) {
        tests.push(
          ...expandSetupFailures(parsed.setup_failures, suite, options.cwd, exec)
        );
      }
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

/**
 * When a contract's setUp() reverts, forge does not run (or report) ANY
 * of that suite's tests — `forge test --json` collapses the whole
 * contract into one synthetic `"setUp()"` failure entry. Left as-is,
 * every test in that contract silently vanishes from the RunResult while
 * `forge test --list --json` (manifest record / discovery) still reports
 * them, so brew's manifest-drift check halts with "N tests invisible".
 * Observed live on Dovizir arm-B: 78 recorded, 24 in the run (18 real +
 * 6 setUp rows), 60 "missing".
 *
 * Fix: re-list the suite's tests via its discover_command and emit a
 * failed TestResult for each test in the affected contract, carrying the
 * setUp revert reason. This mirrors stack-ts/vitest semantics, where a
 * thrown beforeAll hook fails every test in the file instead of hiding
 * them — ids stay aligned with discovery, drift check stays quiet, and
 * brew gets real red targets to fix.
 *
 * If listing fails (discover_command broken, no parsable JSON), fall
 * back to a single failed row per contract (`file > Contract > setUp`)
 * so the failure is never silently dropped.
 */
function expandSetupFailures(
  failures: SetupFailure[],
  suite: SuiteConfig,
  cwd: string,
  exec: (cmd: string, cwd: string, env?: Record<string, string>) => { stdout: string; stderr: string; code: number }
): TestResult[] {
  let listed: ReturnType<typeof parseForgeList> = [];
  try {
    const { stdout } = exec(suite.discover_command, cwd, resolveSuiteEnv(suite.env));
    listed = parseForgeList(stdout);
  } catch {
    listed = [];
  }
  const out: TestResult[] = [];
  for (const f of failures) {
    const prefix = f.contract ? `${f.file} > ${f.contract} > ` : `${f.file} > `;
    const message = `setUp() reverted: ${f.message} — every test in ${
      f.contract ?? f.file
    } failed before it could run`.slice(0, 500);
    const members = listed.filter((e) => e.id.startsWith(prefix));
    if (members.length === 0) {
      // Listing unavailable — keep one visible failed row for the suite.
      out.push({
        id: `${prefix}setUp`,
        file: f.file,
        status: "failed",
        failure_message: message,
      });
      continue;
    }
    for (const m of members) {
      out.push({
        id: m.id,
        file: m.file,
        status: "failed",
        failure_message: message,
      });
    }
  }
  return out;
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
  cwd: string,
  env?: Record<string, string>
): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execSync(cmd, {
      cwd,
      // Merged into the ambient environment rather than prefixed onto the
      // command string, so declared secrets never appear in logged commands.
      ...(env ? { env: { ...process.env, ...env } } : {}),
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
