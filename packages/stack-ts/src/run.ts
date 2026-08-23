// Actually run the test suite and parse results. Separate from discovery
// (discover.ts) because run is heavier and used only by brewing / CI; discovery
// is cheap and used on every manifest verify.

import { execSync } from "node:child_process";
import { relative as pathRelative, isAbsolute } from "node:path";
import type { TestEntry } from "@slowcook-ai/core";
import { resolveSuiteEnv, type StackConfig } from "./stack-config.js";

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
  /** Per-suite runner failures, so callers can act on ONE broken suite
   * without discarding the verdicts of the suites that ran (the story-016
   * lesson: a broken acceptance runner waived the whole final gate and a
   * schema story shipped with no migration). */
  suiteErrors?: { suite: string; error: string }[];
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
  exec?: (cmd: string, cwd: string, env?: Record<string, string>) => { stdout: string; stderr: string; code: number };
  /**
   * 0.11.16+ — when set, append these test file paths to the run
   * command so vitest only runs the named files. Used by brew's
   * per-iter loop for bounded-attention scoped runs (run only tests
   * relevant to the current story / files brew touched). Falls
   * through to a full-suite run when undefined or empty.
   *
   * Path semantics: vitest accepts file paths (relative to cwd) as
   * positional arguments; matched by glob-substring against
   * test files.
   */
  scopeFiles?: string[];
}

export function runTests(config: StackConfig, options: RunOptions): RunResult {
  const tests: TestResult[] = [];
  const suites: RunResult["suites"] = [];
  const errors: string[] = [];
  const suiteErrors: { suite: string; error: string }[] = [];
  const exec = options.exec ?? defaultExec;
  const maxBuffer = options.maxBuffer ?? 128 * 1024 * 1024;

  if (!config.test) {
    return { ran: true, tests, suites };
  }

  for (const [suiteName, suite] of Object.entries(config.test)) {
    // tap-prove suites (pgTAP via `supabase test db` / pg_prove): the
    // runner's own line output is the result format — one line per test
    // FILE, `<path> .. ok` on pass. No JSON reporter, no vitest scoping.
    if (suite.reporter_format === "tap-prove") {
      const { stdout, stderr, code } = exec(suite.run_command, options.cwd, resolveSuiteEnv(suite.env));
      suites.push({ suite: suiteName, command: suite.run_command, exit_code: code, stdout_bytes: stdout.length });
      const proveLine = /^(\S+\.sql)\s+\.\.+\s+(\S.*)$/;
      let parsedAny = false;
      for (const raw of stdout.split("\n")) {
        const m = raw.trim().match(proveLine);
        if (!m) continue;
        parsedAny = true;
        const rel = m[1]!.startsWith(options.cwd + "/")
          ? m[1]!.slice(options.cwd.length + 1)
          : m[1]!;
        const ok = /^ok(?:\s|$)/.test(m[2]!.trim());
        tests.push({
          id: rel,
          file: rel,
          status: ok ? "passed" : "failed",
          ...(ok ? {} : { failure_message: m[2]!.trim().slice(0, 300) }),
        });
      }
      if (!parsedAny && code !== 0) {
        const msg = `exit ${code}, no parsable prove output. First 400 chars of stderr: ${stderr.slice(0, 400)}`;
        errors.push(`[${suiteName}] ${msg}`);
        suiteErrors.push({ suite: suiteName, error: msg });
      }
      continue;
    }
    // 2026-08-23 — playwright suites get their own JSON reporter + parser.
    // They previously fell through to the vitest parser, so ANY failing
    // acceptance test produced "exit 1, no parsable JSON" — a phantom
    // broken-runner that (pre fail-closed gate) waived the whole verdict.
    if (/\bplaywright\b/.test(suite.run_command)) {
      const pwCmd = /--reporter/.test(suite.run_command)
        ? suite.run_command
        : `${suite.run_command} --reporter=json`;
      const { stdout, stderr, code } = exec(pwCmd, options.cwd, resolveSuiteEnv(suite.env));
      suites.push({ suite: suiteName, command: pwCmd, exit_code: code, stdout_bytes: stdout.length });
      const parsed = parsePlaywrightRunJson(stdout);
      if (parsed.length === 0 && code !== 0) {
        const msg = `exit ${code}, no parsable playwright JSON. First 400 chars of stderr: ${stderr.slice(0, 400)}`;
        errors.push(`[${suiteName}] ${msg}`);
        suiteErrors.push({ suite: suiteName, error: msg });
      }
      tests.push(...parsed);
      continue;
    }
    // For `run`, we want vitest's JSON reporter. We append `--reporter=json`
    // to the declared run_command if it's a vitest command and doesn't already
    // specify a reporter. Keep it additive (caller can override in stack.json).
    let cmd = shouldAppendJsonReporter(suite.run_command)
      ? `${suite.run_command} --reporter=json`
      : suite.run_command;

    // 0.11.16+ — bounded-attention scoped runs. When the caller passes
    // scopeFiles, append them to the run command as positional args so
    // vitest only runs those files. Skipped for non-vitest runners
    // (Playwright etc.) — they'd need their own filtering syntax.
    if (
      options.scopeFiles &&
      options.scopeFiles.length > 0 &&
      /\bvitest\b/.test(suite.run_command)
    ) {
      const quoted = options.scopeFiles.map((f) => shellQuote(f)).join(" ");
      cmd = `${cmd} ${quoted}`;
    }

    try {
      const { stdout, stderr, code } = exec(cmd, options.cwd, resolveSuiteEnv(suite.env));
      suites.push({
        suite: suiteName,
        command: cmd,
        exit_code: code,
        stdout_bytes: stdout.length,
      });
      const parsed = parseVitestJson(stdout, suite.run_command, { cwd: options.cwd });
      if (parsed.length === 0 && code !== 0) {
        const msg = `exit ${code}, no parsable JSON. First 400 chars of stderr: ${stderr.slice(0, 400)}`;
        errors.push(`[${suiteName}] ${msg}`);
        suiteErrors.push({ suite: suiteName, error: msg });
      }
      tests.push(...parsed);
    } catch (e) {
      errors.push(`[${suiteName}] ${(e as Error).message}`);
      suiteErrors.push({ suite: suiteName, error: (e as Error).message });
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
    : { ran: false, error: errors.join("; "), suiteErrors, tests, suites };
}

function shouldAppendJsonReporter(cmd: string): boolean {
  if (!/\bvitest\b/.test(cmd)) return false;
  if (/--reporter/.test(cmd)) return false;
  return true;
}

/**
 * 0.11.16+ — quote a path for shell append. Conservative: bare-word
 * paths pass through; anything with whitespace or special chars gets
 * single-quoted. Test files in slowcook today are all `tests/...`
 * which are bare-word, so the common case is no quoting.
 */
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
  // Prefer ancestorTitles + title: vitest's JSON reporter joins describe and it
  // with a single space in `fullName` ("DescribeA test name"), but `vitest list`
  // uses " > " ("DescribeA > test name"). If a test name itself contains " > "
  // (e.g. "count > 0"), the old fullName-based path produced the wrong
  // describe/it separator and caused MANIFEST_DRIFT halts.
  const titles = (a.ancestorTitles ?? []).filter((s): s is string => typeof s === "string" && s.length > 0);
  const leaf = a.title ?? a.fullName ?? "(anonymous)";
  if (titles.length > 0 || a.title) {
    return [file, ...titles, leaf].join(" > ");
  }
  if (a.fullName && a.fullName.includes(" > ")) {
    return `${file} > ${a.fullName}`;
  }
  return `${file} > ${leaf}`;
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


/**
 * Parse `playwright test --reporter=json` output. Ids MUST match
 * parsePlaywrightList: "<file> > <titles...> [<project>]", where <file>
 * is the path as playwright prints it in list mode (testDir-prefixed).
 * The JSON's suite.file is relative to the testDir, so the file-level
 * suite title chain is dropped from titles and the config's testDir-
 * relative prefix is recovered from config.rootDir when possible.
 */
export function parsePlaywrightRunJson(stdout: string): TestResult[] {
  const start = stdout.indexOf("{");
  if (start === -1) return [];
  let doc: {
    config?: { rootDir?: string; projects?: Array<{ testDir?: string }> };
    suites?: unknown[];
  };
  try {
    doc = JSON.parse(stdout.slice(start)) as typeof doc;
  } catch {
    return [];
  }
  const results: TestResult[] = [];

  type PwSuite = {
    title?: string;
    file?: string;
    specs?: Array<{
      title?: string;
      file?: string;
      tests?: Array<{
        projectName?: string;
        status?: string;
        results?: Array<{ status?: string; duration?: number; error?: { message?: string } }>;
      }>;
    }>;
    suites?: PwSuite[];
  };

  const walk = (suite: PwSuite, titles: string[]): void => {
    const isFileSuite = suite.title !== undefined && suite.title === suite.file;
    const chain = isFileSuite ? titles : [...titles, ...(suite.title ? [suite.title] : [])];
    for (const spec of suite.specs ?? []) {
      // File paths stay exactly as playwright's JSON reports them
      // (testDir-relative) — list mode prints the same form, so the two
      // parsers agree without any prefix reconstruction (live-verified
      // on rewo: prefix recovery from rootDir produced mismatched ids).
      const file = spec.file ?? suite.file ?? "";
      for (const t of spec.tests ?? []) {
        const agg = t.status ?? "";
        const status: TestResult["status"] =
          agg === "expected" || agg === "flaky"
            ? "passed"
            : agg === "skipped"
              ? "skipped"
              : "failed";
        const firstErr = (t.results ?? []).find((r) => r.error?.message)?.error?.message;
        results.push({
          id: `${file} > ${[...chain, spec.title ?? ""].filter(Boolean).join(" > ")} [${t.projectName ?? ""}]`,
          file,
          status,
          ...(status === "failed" && firstErr ? { failure_message: firstErr.slice(0, 500) } : {}),
        });
      }
    }
    for (const sub of suite.suites ?? []) walk(sub, chain);
  };
  for (const s of (doc.suites ?? []) as PwSuite[]) walk(s, []);
  return results;
}

