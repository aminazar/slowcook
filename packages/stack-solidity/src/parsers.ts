import type { TestEntry } from "@slowcook-ai/core";

/**
 * Parsers for forge (Foundry) output. Two formats matter:
 *
 *   - `forge test --json`        → run results (parseForgeJson)
 *   - `forge test --list --json` → discovery (parseForgeList)
 *
 * Fixture-verified against forge 1.3.2 (see ../fixtures/*.json — captured
 * from real forge runs, committed so tests never need forge installed).
 */

/** Mirrors stack-ts's TestResult; re-declared locally (adapters don't import each other). */
export interface TestResult {
  id: string;
  file: string;
  status: "passed" | "failed" | "skipped" | "errored";
  duration_ms?: number;
  failure_message?: string;
  /** Solidity extra: gas used (unit tests) or mean gas (fuzz tests). */
  gas?: number;
  /** Solidity extra: fuzz metadata when the test is property-based. */
  fuzz?: { runs: number; mean_gas?: number; median_gas?: number };
}

interface ForgeTestResult {
  status?: string;
  reason?: string | null;
  counterexample?: unknown;
  decoded_logs?: string[];
  kind?: {
    Unit?: { gas?: number };
    Fuzz?: { runs?: number; mean_gas?: number; median_gas?: number };
    Invariant?: { runs?: number; calls?: number; reverts?: number };
  };
  duration?: string;
}

/**
 * A suite whose `setUp()` reverted. Forge does NOT run (or report) any
 * of the suite's tests in this case — the whole contract collapses into
 * a single synthetic `"setUp()"` entry in `test_results`:
 *
 *   { "test/InsuranceFund.t.sol:InsuranceFundTest": {
 *       "test_results": { "setUp()": { "status": "Failure", "reason": "STUB", ... } } } }
 *
 * Live failure this models (Dovizir arm-B): a stub-backed acceptance
 * suite where 6 of 9 contracts' setUp() reverted — `forge test --json`
 * reported 24 rows (18 real + 6 setUp entries) while `--list --json`
 * discovered all 78 tests, so brew's manifest-drift check saw 60 story
 * tests as "invisible" and halted. run.ts re-expands these suites via
 * the discover_command so every listed test gets a failed row, matching
 * vitest semantics (a thrown beforeAll hook fails each test in the file
 * rather than hiding them).
 */
export interface SetupFailure {
  file: string;
  contract: string | null;
  /** Bounded revert reason as forge reported it, e.g. "STUB". */
  message: string;
}

export interface ForgeRunParse {
  tests: TestResult[];
  setup_failures: SetupFailure[];
}

/**
 * Parse `forge test --json` output into flat TestResult rows.
 *
 * Forge's JSON shape (1.3.x):
 *
 *   { "test/Smoke.t.sol:SmokeTest": {
 *       "duration": "5ms 707µs 750ns",
 *       "test_results": {
 *         "test_depositCreditsMember()": { "status": "Success", "reason": null,
 *           "kind": { "Unit": { "gas": 32646 } }, "duration": "797µs 917ns", ... },
 *         "testFuzz_add(uint128)": { "status": "Success",
 *           "kind": { "Fuzz": { "runs": 256, "mean_gas": 29247, "median_gas": 29403 } }, ... }
 *       },
 *       "warnings": [] } }
 *
 * Test ids are built as "<file> > <Contract> > <testName>" with the
 * Solidity signature ("(uint128)") stripped so ids line up with what
 * `forge test --list --json` reports (list output has bare names) —
 * the same id-consistency requirement that stack-ts's buildTestId
 * solves for vitest (manifest verify compares the two sets).
 *
 * Compiler errors: forge prints "Compiler run failed: ..." to stdout,
 * "Error: Compilation failed" to stderr and emits NO JSON. We return
 * empty here; run.ts turns "exit != 0 with zero parsed tests" into
 * RunResult.ran = false with the stderr excerpt.
 *
 * setUp() reverts: reported in `setup_failures` (NOT as test rows —
 * forge's synthetic `"setUp()"` entry is not a test and its id would
 * never match the manifest). run.ts expands them; see SetupFailure.
 */
export function parseForgeRun(stdout: string, cwd?: string): ForgeRunParse {
  void cwd; // forge emits repo-relative paths already; kept for signature parity with stack-ts.
  const empty: ForgeRunParse = { tests: [], setup_failures: [] };
  const firstBrace = stdout.indexOf("{");
  if (firstBrace === -1) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(firstBrace));
  } catch {
    // Noise before/after the JSON object — find the matching close brace.
    const candidate = stdout.slice(firstBrace);
    const lastBrace = findMatchingClose(candidate);
    if (lastBrace === -1) return empty;
    try {
      parsed = JSON.parse(candidate.slice(0, lastBrace + 1));
    } catch {
      return empty;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;

  const out: TestResult[] = [];
  const setupFailures: SetupFailure[] = [];
  for (const [suiteKey, suite] of Object.entries(parsed as Record<string, unknown>)) {
    if (!suite || typeof suite !== "object") continue;
    const { file, contract } = splitSuiteKey(suiteKey);
    const testResults = (suite as { test_results?: Record<string, ForgeTestResult> })
      .test_results;
    if (!testResults || typeof testResults !== "object") continue;
    for (const [rawName, r] of Object.entries(testResults)) {
      const name = stripSignature(rawName);
      if (name === "setUp") {
        // Synthetic entry: setUp() reverted, suite's tests never ran.
        if (normaliseStatus(r?.status) !== "passed") {
          setupFailures.push({
            file,
            contract,
            message: buildFailureMessage({ ...r, status: "Failure" }) ??
              "(setUp failed with no reason reported)",
          });
        }
        continue;
      }
      const result: TestResult = {
        id: contract ? `${file} > ${contract} > ${name}` : `${file} > ${name}`,
        file,
        status: normaliseStatus(r?.status),
      };
      const durationMs = parseForgeDuration(r?.duration);
      if (durationMs !== undefined) result.duration_ms = durationMs;
      const failure = buildFailureMessage(r);
      if (failure) result.failure_message = failure;
      const unitGas = r?.kind?.Unit?.gas;
      if (typeof unitGas === "number") result.gas = unitGas;
      const fuzz = r?.kind?.Fuzz;
      if (fuzz && typeof fuzz.runs === "number") {
        result.fuzz = {
          runs: fuzz.runs,
          ...(typeof fuzz.mean_gas === "number" ? { mean_gas: fuzz.mean_gas } : {}),
          ...(typeof fuzz.median_gas === "number" ? { median_gas: fuzz.median_gas } : {}),
        };
        if (typeof fuzz.mean_gas === "number") result.gas = fuzz.mean_gas;
      }
      out.push(result);
    }
  }
  return { tests: out, setup_failures: setupFailures };
}

/**
 * Back-compat wrapper over parseForgeRun: just the test rows. Note
 * setUp() failures are NOT included (they aren't tests) — callers that
 * must not lose that signal (run.ts) use parseForgeRun instead.
 */
export function parseForgeJson(stdout: string, cwd?: string): TestResult[] {
  return parseForgeRun(stdout, cwd).tests;
}

/**
 * Parse `forge test --list --json` output into TestEntry rows for
 * discovery. Shape:
 *
 *   { "test/Smoke.t.sol": { "SmokeTest": ["test_depositCreditsMember", ...] } }
 *
 * Note list output uses bare test names (no signature) — parseForgeJson
 * strips signatures so run + discovery ids match.
 */
export function parseForgeList(output: string): TestEntry[] {
  const firstBrace = output.indexOf("{");
  if (firstBrace === -1) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(firstBrace));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];

  const entries: TestEntry[] = [];
  for (const [file, contracts] of Object.entries(parsed as Record<string, unknown>)) {
    if (!contracts || typeof contracts !== "object") continue;
    for (const [contract, tests] of Object.entries(contracts as Record<string, unknown>)) {
      if (!Array.isArray(tests)) continue;
      for (const t of tests) {
        if (typeof t !== "string") continue;
        entries.push({
          id: `${file} > ${contract} > ${stripSignature(t)}`,
          file,
        });
      }
    }
  }
  return entries;
}

export function parseByReporterFormat(format: string, output: string): TestEntry[] {
  switch (format) {
    case "forge-json":
    case "forge-list-json":
      return parseForgeList(output);
    default:
      throw new Error(
        `Unknown reporter_format: ${JSON.stringify(format)}. Supported: forge-json.`
      );
  }
}

/** "test/Smoke.t.sol:SmokeTest" → { file, contract }. */
function splitSuiteKey(key: string): { file: string; contract: string | null } {
  const idx = key.lastIndexOf(":");
  if (idx === -1) return { file: key, contract: null };
  return { file: key.slice(0, idx), contract: key.slice(idx + 1) };
}

/** "testFuzz_add(uint128)" → "testFuzz_add"; bare names pass through. */
function stripSignature(name: string): string {
  const paren = name.indexOf("(");
  return paren === -1 ? name : name.slice(0, paren);
}

function normaliseStatus(s?: string): TestResult["status"] {
  switch (s) {
    case "Success":
      return "passed";
    case "Failure":
      return "failed";
    case "Skipped":
      return "skipped";
    default:
      return "errored";
  }
}

/** Fold reason + fuzz counterexample into one bounded message. */
function buildFailureMessage(r?: ForgeTestResult): string | undefined {
  if (!r || normaliseStatus(r.status) !== "failed") return undefined;
  const parts: string[] = [];
  if (typeof r.reason === "string" && r.reason.length > 0) parts.push(r.reason);
  if (r.counterexample) {
    try {
      parts.push(`counterexample: ${JSON.stringify(r.counterexample)}`);
    } catch {
      /* unserialisable — skip */
    }
  }
  if (parts.length === 0) parts.push("(test failed with no reason reported)");
  return parts.join("; ").slice(0, 500);
}

/**
 * Forge durations are humanised strings like "5ms 707µs 750ns" or
 * "1s 5ms". Sum the components into milliseconds (fractional).
 */
export function parseForgeDuration(s?: string): number | undefined {
  if (typeof s !== "string" || s.length === 0) return undefined;
  const re = /(\d+(?:\.\d+)?)\s*(s|ms|µs|us|ns)\b/g;
  let ms = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const value = parseFloat(m[1]!);
    switch (m[2]) {
      case "s":
        ms += value * 1000;
        break;
      case "ms":
        ms += value;
        break;
      case "µs":
      case "us":
        ms += value / 1000;
        break;
      case "ns":
        ms += value / 1_000_000;
        break;
    }
  }
  if (!matched) return undefined;
  return Math.round(ms * 1000) / 1000;
}

function findMatchingClose(s: string): number {
  let depth = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
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
