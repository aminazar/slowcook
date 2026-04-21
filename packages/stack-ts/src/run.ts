// Actually run the test suite and parse results. Separate from discovery
// (discover.ts) because run is heavier and used only by brewing / CI; discovery
// is cheap and used on every manifest verify.

import { execSync } from "node:child_process";
import { relative as pathRelative, isAbsolute } from "node:path";
import type { TestEntry } from "@slowcook-ai/core";
import type { StackConfig } from "./stack-config.js";

export interface TestResult {
  id: string;
  file: string;
  status: "passed" | "failed" | "skipped" | "errored";
  duration_ms?: number;
  failure_message?: string;
}

export interface RunResult {
  /** Aggregate: did the runner itself complete cleanly? (true even if tests failed) */
  ran: boolean;
  /** If !ran: why. E.g., "exit 1 with no JSON output — vitest may have crashed". */
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
}

export function runTests(config: StackConfig, options: RunOptions): RunResult {
  const tests: TestResult[] = [];
  const suites: RunResult["suites"] = [];
  const errors: string[] = [];
  const exec = options.exec ?? defaultExec;
  const maxBuffer = options.maxBuffer ?? 128 * 1024 * 1024;

  if (!config.test) {
    return { ran: true, tests, suites };
  }

  for (const [suiteName, suite] of Object.entries(config.test)) {
    // For `run`, we want vitest's JSON reporter. We append `--reporter=json`
    // to the declared run_command if it's a vitest command and doesn't already
    // specify a reporter. Keep it additive (caller can override in stack.json).
    const cmd = shouldAppendJsonReporter(suite.run_command)
      ? `${suite.run_command} --reporter=json`
      : suite.run_command;

    try {
      const { stdout, stderr, code } = exec(cmd, options.cwd);
      suites.push({
        suite: suiteName,
        command: cmd,
        exit_code: code,
        stdout_bytes: stdout.length,
      });
      const parsed = parseVitestJson(stdout, suite.run_command, { cwd: options.cwd });
      if (parsed.length === 0 && code !== 0) {
        errors.push(
          `[${suiteName}] exit ${code}, no parsable JSON. First 400 chars of stderr: ${stderr.slice(0, 400)}`
        );
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

function shouldAppendJsonReporter(cmd: string): boolean {
  if (!/\bvitest\b/.test(cmd)) return false;
  if (/--reporter/.test(cmd)) return false;
  return true;
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

/**
 * Parse Vitest JSON reporter output into flat TestResult rows.
 *
 * Vitest's JSON reporter produces a top-level object with `testResults[]`,
 * each having `name` (file path) and `assertionResults[]` with `fullName` +
 * `status` + `failureMessages[]`. We sometimes get noisy stdout prefixing
 * (e.g., dev-dep warnings, --reporter output splatter) so we look for the
 * first `{` and try to parse from there.
 */
export function parseVitestJson(
  stdout: string,
  runCommand: string,
  options?: { cwd?: string }
): TestResult[] {
  void runCommand;
  const firstBrace = stdout.indexOf("{");
  if (firstBrace === -1) return [];
  const candidate = stdout.slice(firstBrace);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    // Try to locate a valid JSON object by scanning — vitest sometimes appends extra output
    const lastBrace = findMatchingClose(candidate);
    if (lastBrace === -1) return [];
    try {
      parsed = JSON.parse(candidate.slice(0, lastBrace + 1));
    } catch {
      return [];
    }
  }

  if (!parsed || typeof parsed !== "object") return [];
  const root = parsed as {
    testResults?: Array<{
      name?: string;
      assertionResults?: Array<{
        fullName?: string;
        title?: string;
        ancestorTitles?: string[];
        status?: string;
        duration?: number;
        failureMessages?: string[];
      }>;
    }>;
  };
  const out: TestResult[] = [];
  for (const fileResult of root.testResults ?? []) {
    const file = relativiseFile(fileResult.name ?? "", options?.cwd);
    for (const a of fileResult.assertionResults ?? []) {
      const status = normaliseStatus(a.status);
      const id = buildTestId(file, a);
      out.push({
        id,
        file,
        status,
        duration_ms: a.duration,
        failure_message: a.failureMessages?.[0]?.slice(0, 500),
      });
    }
  }
  return out;
}

function normaliseStatus(s?: string): TestResult["status"] {
  switch (s) {
    case "passed":
      return "passed";
    case "failed":
      return "failed";
    case "skipped":
    case "pending":
    case "todo":
      return "skipped";
    default:
      return "errored";
  }
}

/** Build "<file> > <describe> > <it>" to match `vitest list` output format. */
function buildTestId(
  file: string,
  a: { fullName?: string; title?: string; ancestorTitles?: string[] }
): string {
  if (a.fullName && a.fullName.includes(" > ")) {
    return `${file} > ${a.fullName}`;
  }
  const chain = [...(a.ancestorTitles ?? []), a.title ?? a.fullName ?? "(anonymous)"].filter(
    (s): s is string => typeof s === "string" && s.length > 0
  );
  return [file, ...chain].join(" > ");
}

/**
 * Convert absolute paths to repo-relative. Prefer `path.relative(cwd, name)`
 * when cwd is provided — this is the only reliable way to get a path that
 * matches how testgen/manifest store test file IDs. Fall back to regex
 * anchors only when cwd is unknown (older callers).
 *
 * The regex fallback intentionally excludes `app/` as an anchor: on some
 * runners (e.g., GitHub Actions on Contabo) the workspace lives under
 * `/home/runner/actions-runner/_work/app/app/...`, and anchoring on `app/`
 * produced `app/app/tests/...` instead of `tests/...`.
 */
function relativiseFile(name: string, cwd?: string): string {
  if (!name) return "(unknown)";
  if (!isAbsolute(name)) return name;
  if (cwd) {
    const rel = pathRelative(cwd, name);
    // path.relative may produce "../..." if cwd is outside the file tree —
    // only trust it if it stays inside cwd.
    if (rel && !rel.startsWith("..")) return rel;
  }
  const m = name.match(/\/((?:tests|src|packages)\/.*)$/);
  if (m && m[1]) return m[1];
  return name;
}

function findMatchingClose(s: string): number {
  let depth = 0;
  let inStr = false;
  let strCh = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === strCh) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      strCh = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
