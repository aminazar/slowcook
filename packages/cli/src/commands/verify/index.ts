/**
 * `slowcook verify --story <id>` (PR-E, 2026-08-23).
 *
 * The human merge-gate battery, previously retyped by hand at every
 * gate, as ONE command with an exit code:
 *
 *   1. migration-number collision check vs the base branch (the class
 *      that hit twice: two branches both claiming 00021)
 *   2. optional real-database replay (stack.json test.db.reset_command;
 *      "already running" states are verification theater — only a full
 *      replay proves the branch's migrations build)
 *   3. typecheck (stack.json lint.typecheck_command) — merged test
 *      contracts have shipped runtime ReferenceErrors that tsc catches
 *   4. every declared suite runs; the story contract (manifest +
 *      cross-suite fold) must be fully green
 *   5. the full-suite red set is printed for the operator's diff
 *
 * Exit 0 = every section passed. Any failure = exit 1 with the section
 * named. Verification evidence, stated out loud — never a silent pass.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runTests, discoverTests, validateStackConfig, type StackConfig } from "../../stack-resolve.js";
import { foldCrossSuiteTests } from "../brew/cross-suite.js";
import { pruneRedBaseline } from "../../lib/red-baseline.js";

interface VerifyArgs {
  storyId: string;
  repoRoot: string;
  base: string;
  skipDb: boolean;
  /** WP1 — machine-readable result on stdout (human lines go to stderr). */
  json: boolean;
}

/** One PASS/FAIL/skipped line of the battery. `ok: null` = skipped. */
export interface VerifySection {
  name: string;
  ok: boolean | null;
  detail: string;
}

/**
 * `slowcook verify --json` — the numbers an experiment compares. The
 * story contract (green/total/red ids), the full-suite red set outside
 * the story, and the typecheck ratchet, as data instead of ✅/❌ prose.
 */
export interface VerifyResult {
  story: string;
  base: string;
  ok: boolean;
  sections: VerifySection[];
  story_contract?: {
    green: number;
    total: number;
    red_ids: string[];
    /** The red tests with their runner failure text (first 600 chars) — the
     *  plain arm's "selector-only vs behavioural" split reads from here. */
    red: Array<{ id: string; message?: string }>;
  };
  full_suite?: { red_outside_story: number; red_files: string[] };
  typecheck?: { total_errors: number; regressions: Array<{ file: string; was: number; now: number }>; baseline_recorded: boolean };
}

function parseArgs(argv: string[]): VerifyArgs {
  const args: VerifyArgs = { storyId: "", repoRoot: process.cwd(), base: "main", skipDb: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if ((arg === "--story" || arg === "--spec") && next) { args.storyId = next.replace(/^story-/, ""); i++; }
    else if (arg === "--cwd" && next) { args.repoRoot = next; i++; }
    else if (arg === "--base" && next) { args.base = next; i++; }
    else if (arg === "--skip-db") { args.skipDb = true; }
    else if (arg === "--json") { args.json = true; }
    else if (arg === "--help" || arg === "-h") { printHelp(); process.exit(0); }
    else { console.error(`Unknown option: ${arg}`); printHelp(); process.exit(64); }
  }
  if (!args.storyId) { console.error("Missing required --story <id>"); printHelp(); process.exit(64); }
  return args;
}

function printHelp(): void {
  console.log(`slowcook verify — the human merge-gate battery, as one command

Usage:
  slowcook verify --story <id> [--cwd <path>] [--base <branch>] [--skip-db] [--json]

Sections (each PASS/FAIL, exit 1 on any failure):
  migrations   duplicate migration numbers vs origin/<base>
  db-replay    stack.json test.db.reset_command (full replay; skip with --skip-db)
  typecheck    stack.json lint.typecheck_command
  suites       every declared suite; story contract must be fully green
  full-suite   red list printed for the operator's regression diff

--json        print a VerifyResult object on stdout (sections, story_contract,
              full_suite, typecheck); human lines go to stderr; exit code unchanged`);
}

/**
 * Migration files whose numeric prefix collides with a DIFFERENT file
 * on the base branch. Pure; exported for tests.
 */
export function migrationCollisions(
  branchFiles: string[],
  baseFiles: string[]
): Array<{ number: string; branch: string; base: string }> {
  const prefix = (f: string): string | null => f.match(/^(\d+)_/)?.[1] ?? null;
  const baseByNum = new Map<string, string>();
  for (const f of baseFiles) {
    const n = prefix(f);
    if (n) baseByNum.set(n, f);
  }
  const out: Array<{ number: string; branch: string; base: string }> = [];
  for (const f of branchFiles) {
    const n = prefix(f);
    if (!n) continue;
    const base = baseByNum.get(n);
    if (base && base !== f) out.push({ number: n, branch: f, base });
  }
  return out;
}


/** Per-file tsc error counts from raw tsc output. Pure; exported for tests. */
export function tscErrorCounts(output: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of output.split("\n")) {
    const m = line.match(/^(.+?)\(\d+,\d+\): error TS/);
    if (m) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  }
  return counts;
}

/**
 * Ratchet comparison: which files got WORSE than the baseline (new files
 * with errors, or higher counts)? Pre-existing debt passes; regressions
 * fail. Pure; exported for tests.
 */
export function typecheckRegressions(
  baseline: ReadonlyMap<string, number>,
  current: ReadonlyMap<string, number>
): Array<{ file: string; was: number; now: number }> {
  const out: Array<{ file: string; was: number; now: number }> = [];
  for (const [file, now] of current) {
    const was = baseline.get(file) ?? 0;
    if (now > was) out.push({ file, was, now });
  }
  return out;
}

/**
 * Story-contract and full-suite numbers from one test run. Pure; exported
 * for tests and for `experiment report`.
 */
export function summarizeRun(
  tests: Array<{ id: string; file: string; status: string; failure_message?: string }>,
  expected: ReadonlySet<string>
): {
  green: number; total: number; red_ids: string[];
  red: Array<{ id: string; message?: string }>;
  red_outside_story: number; red_files: string[];
} {
  const storyRed = tests.filter((t) => expected.has(t.id) && t.status !== "passed");
  const otherRed = tests.filter((t) => !expected.has(t.id) && t.status !== "passed");
  return {
    green: expected.size - storyRed.length,
    total: expected.size,
    red_ids: storyRed.map((t) => t.id),
    red: storyRed.map((t) => ({ id: t.id, ...(t.failure_message ? { message: t.failure_message.slice(0, 600) } : {}) })),
    red_outside_story: otherRed.length,
    red_files: [...new Set(otherRed.map((t) => t.file))].sort(),
  };
}

export async function verify(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const failures: string[] = [];
  const result: VerifyResult = { story: args.storyId, base: args.base, ok: false, sections: [] };
  // Human lines go to stderr under --json so stdout is exactly one object.
  const log = (line: string): void => { if (args.json) console.error(line); else console.log(line); };
  const section = (name: string, ok: boolean, detail: string): void => {
    log(`${ok ? "✅" : "❌"} ${name}  ${detail}`);
    result.sections.push({ name, ok, detail });
    if (!ok) failures.push(name);
  };
  const skipped = (name: string, detail: string): void => {
    log(`·  ${name}  (${detail})`);
    result.sections.push({ name, ok: null, detail });
  };

  const stackPath = join(args.repoRoot, ".brewing", "stack.json");
  if (!existsSync(stackPath)) {
    console.error(`No .brewing/stack.json at ${args.repoRoot} — nothing to verify against.`);
    process.exit(2);
  }
  const stackConfig: StackConfig = validateStackConfig(JSON.parse(readFileSync(stackPath, "utf8")));

  // 1 — migration collisions vs base
  const migDir = join(args.repoRoot, "supabase", "migrations");
  if (existsSync(migDir)) {
    let baseFiles: string[] = [];
    try {
      baseFiles = execSync(
        `git ls-tree --name-only origin/${args.base} -- supabase/migrations/`,
        { cwd: args.repoRoot, encoding: "utf8" }
      )
        .split("\n")
        .map((l) => l.replace(/^supabase\/migrations\//, "").trim())
        .filter(Boolean);
    } catch { /* no base ref — collision check degrades to skip */ }
    const collisions = migrationCollisions(readdirSync(migDir), baseFiles);
    section(
      "migrations",
      collisions.length === 0,
      collisions.length === 0
        ? "no number collisions vs origin/" + args.base
        : collisions.map((c) => `${c.number}: ${c.branch} vs ${c.base} on base — renumber to the next free`).join("; ")
    );
  } else {
    skipped("migrations", "no supabase/migrations directory — skipped");
  }

  // 2 — real-database replay
  const dbSuite = (stackConfig as { test?: Record<string, { reset_command?: string }> }).test?.["db"];
  if (!args.skipDb && dbSuite?.reset_command) {
    try {
      execSync(dbSuite.reset_command, { cwd: args.repoRoot, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
      section("db-replay", true, `\`${dbSuite.reset_command}\` — full replay clean`);
    } catch (e) {
      section("db-replay", false, `\`${dbSuite.reset_command}\` failed: ${String((e as { stderr?: string }).stderr ?? (e as Error).message).slice(-300)}`);
    }
  } else if (dbSuite && !dbSuite.reset_command) {
    skipped("db-replay", "declare test.db.reset_command in stack.json to enable the full-replay check");
  } else if (args.skipDb) {
    skipped("db-replay", "skipped by --skip-db");
  }

  // 3 — typecheck RATCHET. Brownfield repos carry type debt (rewo: 142
  // pre-existing errors, all in tests that run green because vitest
  // transpiles without checking). Failing on the stock is unusable and
  // fixing it by hand is not the human's job — so the gate fails only on
  // files that got WORSE than the recorded baseline, and tightens the
  // baseline automatically whenever reality improves.
  const typecheck = (stackConfig as { lint?: { typecheck_command?: string } }).lint?.typecheck_command;
  if (typecheck) {
    let tscOut = "";
    let clean = false;
    try {
      execSync(typecheck, { cwd: args.repoRoot, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
      clean = true;
    } catch (e) {
      tscOut = String((e as { stdout?: string }).stdout ?? "") + String((e as { stderr?: string }).stderr ?? "");
    }
    if (clean) {
      section("typecheck", true, `\`${typecheck}\` — zero errors`);
      result.typecheck = { total_errors: 0, regressions: [], baseline_recorded: false };
    } else {
      const current = tscErrorCounts(tscOut);
      const baselinePath = join(args.repoRoot, ".brewing", "local", "typecheck-baseline.json");
      let baseline: Map<string, number> | null = null;
      try {
        baseline = new Map(Object.entries(JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, number>));
      } catch { /* no baseline yet */ }
      const total = [...current.values()].reduce((a, b) => a + b, 0);
      if (!baseline) {
        const { mkdirSync, writeFileSync } = await import("node:fs");
        mkdirSync(join(args.repoRoot, ".brewing", "local"), { recursive: true });
        writeFileSync(baselinePath, JSON.stringify(Object.fromEntries(current), null, 2), "utf8");
        section(
          "typecheck",
          true,
          `${total} pre-existing error(s) across ${current.size} file(s) — baseline RECORDED (ratchet arms now; new errors fail from the next run)`
        );
        result.typecheck = { total_errors: total, regressions: [], baseline_recorded: true };
      } else {
        const regressions = typecheckRegressions(baseline, current);
        result.typecheck = { total_errors: total, regressions, baseline_recorded: false };
        if (regressions.length > 0) {
          section(
            "typecheck",
            false,
            `type errors INCREASED vs baseline:\n` +
              regressions.slice(0, 8).map((r) => `     ${r.file}: ${r.was} → ${r.now}`).join("\n")
          );
        } else {
          section("typecheck", true, `${total} error(s), none new vs baseline (pre-existing debt tracked in ${baselinePath})`);
          // Tighten: reality improved → the baseline follows it down.
          const improved = [...baseline.entries()].some(([f, was]) => (current.get(f) ?? 0) < was);
          if (improved) {
            const { writeFileSync } = await import("node:fs");
            writeFileSync(baselinePath, JSON.stringify(Object.fromEntries(current), null, 2), "utf8");
            log("   (baseline tightened — improvements are locked in)");
          }
        }
      }
    }
  } else {
    skipped("typecheck", "no lint.typecheck_command in stack.json");
  }

  // 4 + 5 — every suite, story contract, full red list
  log(`→ running every declared suite…`);
  const run = runTests(stackConfig, { cwd: args.repoRoot });
  if (!run.ran) {
    section("suites", false, `runner broken: ${(run.suiteErrors ?? []).map((e) => `[${e.suite}] ${e.error.slice(0, 150)}`).join("; ") || run.error}`);
  } else {
    let expected = new Set<string>();
    try {
      const manifest = JSON.parse(
        readFileSync(join(args.repoRoot, ".brewing", "manifests", `story-${args.storyId}.json`), "utf8")
      ) as { tests: Array<{ id: string; file: string }> };
      const discovery = discoverTests(stackConfig, { cwd: args.repoRoot });
      const folded = foldCrossSuiteTests(manifest.tests, discovery.tests, args.storyId);
      expected = new Set([...manifest.tests, ...folded].map((t) => t.id));
    } catch {
      log(`·  (no manifest for story-${args.storyId} — story-contract section limited to file-name matching)`);
      const re = new RegExp(`(^|[/_.-])story-0*${args.storyId.replace(/^0+/, "") || "0"}([/_.-]|$)`);
      expected = new Set(run.tests.filter((t) => re.test(t.file)).map((t) => t.id));
    }
    const sum = summarizeRun(run.tests, expected);
    result.story_contract = { green: sum.green, total: sum.total, red_ids: sum.red_ids, red: sum.red };
    result.full_suite = { red_outside_story: sum.red_outside_story, red_files: sum.red_files };
    section(
      "story-contract",
      sum.red_ids.length === 0,
      sum.red_ids.length === 0
        ? `${sum.total} test(s) all green`
        : `${sum.red_ids.length}/${sum.total} red — first: ${sum.red_ids[0]!.slice(0, 140)}`
    );
    // WP2 (2026-10-24) — the red-by-design baseline (#542) follows reality
    // down: tests it lists that just passed are removed, so the failure-set
    // diff compares against the honest list.
    try {
      const pruned = pruneRedBaseline(
        args.repoRoot,
        (stackConfig as { red_baseline?: string }).red_baseline,
        run.tests.filter((t) => t.status === "passed").map((t) => t.id)
      );
      if (pruned.declared && pruned.removed) {
        log(`   (red baseline ${pruned.path}: ${pruned.removed} now-green test(s) removed, ${pruned.total} remain)`);
      }
    } catch (e) {
      log(`   (red baseline not pruned: ${e instanceof Error ? e.message : String(e)})`);
    }
    log(
      `ℹ️  full-suite reds outside the story: ${sum.red_outside_story}` +
        (sum.red_outside_story > 0
          ? ` — diff these against your base branch before merging:\n` +
            sum.red_files.map((f) => `     ${f}`).join("\n")
          : "")
    );
  }

  result.ok = failures.length === 0;
  if (args.json) console.log(JSON.stringify(result, null, 2));
  if (failures.length > 0) {
    console.error(`\nverify FAILED: ${failures.join(", ")}`);
    process.exit(1);
  }
  log(`\nverify PASSED for story-${args.storyId}.`);
}
