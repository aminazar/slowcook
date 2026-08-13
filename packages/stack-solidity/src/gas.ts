// Gas-snapshot ratchet for Foundry projects.
//
// `forge snapshot` writes per-test gas usage to `.gas-snapshot`;
// `forge snapshot --check` re-runs the suite and exits non-zero when any
// test's gas differs from the committed snapshot. That exit code is the
// ratchet: brew can treat a gas regression as a hard signal the same way
// a red test is. When regressions are found we parse forge's diff lines
//
//   Diff in "CounterTest::test_incrementOnce()": consumed "(gas: 30998)" gas, expected "(gas: 28635)" gas
//
// into structured { test, old, new, delta } rows for the next-iter prompt.

import { execSync } from "node:child_process";
import type { GasSnapshotConfig } from "./stack-config.js";

export interface GasRegression {
  /** "Contract::test_name()" as forge prints it. */
  test: string;
  /** Gas recorded in the committed snapshot. */
  old: number;
  /** Gas consumed by the current code. */
  new: number;
  /** new - old. Positive = regression, negative = improvement. */
  delta: number;
}

export interface GasSnapshotResult {
  /** Did the snapshot command itself run? False on exec crash (forge missing etc.). */
  ran: boolean;
  /** True when the current gas usage matches the committed snapshot. */
  clean: boolean;
  regressions: GasRegression[];
  /** If !ran: why. */
  error?: string;
  /** Snapshot command exit code (null when exec crashed). */
  exit_code: number | null;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

type Exec = (cmd: string, cwd: string) => ExecResult;

const defaultExec: Exec = (cmd, cwd) => {
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
};

export interface GasSnapshotOptions {
  /** Inject for tests. */
  exec?: Exec;
}

/** Build the base snapshot command from config (defaults: "forge snapshot", forge's own snapshot file). */
function baseCommand(config?: GasSnapshotConfig): string {
  let cmd = config?.snapshot_command ?? "forge snapshot";
  if (config?.snapshot_file) {
    cmd += ` --snap ${config.snapshot_file}`;
  }
  return cmd;
}

/**
 * Run `forge snapshot --check` and report gas regressions against the
 * committed snapshot. Exit 0 = clean; non-zero exit with "Diff in ..."
 * lines = regressions (parsed); non-zero without diff lines = the run
 * itself failed (compile error, missing snapshot file) → ran=false.
 */
export function checkGasSnapshot(
  cwd: string,
  config?: GasSnapshotConfig,
  options?: GasSnapshotOptions
): GasSnapshotResult {
  const exec = options?.exec ?? defaultExec;
  const cmd = `${baseCommand(config)} --check`;
  let out: ExecResult;
  try {
    out = exec(cmd, cwd);
  } catch (e) {
    return {
      ran: false,
      clean: false,
      regressions: [],
      error: (e as Error).message,
      exit_code: null,
    };
  }
  if (out.code === 0) {
    return { ran: true, clean: true, regressions: [], exit_code: 0 };
  }
  const regressions = parseSnapshotDiff(out.stdout + "\n" + out.stderr);
  if (regressions.length === 0) {
    // Non-zero exit with no parseable diff — the check itself failed
    // (compile error, corrupt snapshot). Distinct from a regression.
    const detail = (out.stderr.trim() || out.stdout.trim()).slice(0, 400);
    return {
      ran: false,
      clean: false,
      regressions: [],
      error: `snapshot --check exit ${out.code} with no parsable diff. ${detail}`,
      exit_code: out.code,
    };
  }
  return { ran: true, clean: false, regressions, exit_code: out.code };
}

/**
 * Re-baseline: run the snapshot command WITHOUT --check so forge
 * rewrites the snapshot file with current gas numbers. Caller commits
 * the file. Returns the exec result so the caller can surface failures.
 */
export function updateGasSnapshot(
  cwd: string,
  config?: GasSnapshotConfig,
  options?: GasSnapshotOptions
): { ok: boolean; exit_code: number | null; error?: string } {
  const exec = options?.exec ?? defaultExec;
  const cmd = baseCommand(config);
  try {
    const out = exec(cmd, cwd);
    if (out.code === 0) return { ok: true, exit_code: 0 };
    return {
      ok: false,
      exit_code: out.code,
      error: (out.stderr.trim() || out.stdout.trim()).slice(0, 400),
    };
  } catch (e) {
    return { ok: false, exit_code: null, error: (e as Error).message };
  }
}

/**
 * Parse forge's snapshot diff lines into structured regressions.
 * Fixture-verified format (forge 1.3.2):
 *
 *   Diff in "CounterTest::test_failsOnPurpose()": consumed "(gas: 31020)" gas, expected "(gas: 28657)" gas
 */
export function parseSnapshotDiff(output: string): GasRegression[] {
  const regressions: GasRegression[] = [];
  const re =
    /Diff in "([^"]+)":\s*consumed\s*"\(gas:\s*(\d+)\)"\s*gas,\s*expected\s*"\(gas:\s*(\d+)\)"\s*gas/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const newGas = parseInt(m[2]!, 10);
    const oldGas = parseInt(m[3]!, 10);
    regressions.push({
      test: m[1]!,
      old: oldGas,
      new: newGas,
      delta: newGas - oldGas,
    });
  }
  return regressions;
}
