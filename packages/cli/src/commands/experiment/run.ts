/**
 * `slowcook experiment run --story <id> --arm <name> [--exp <id>] [--seed k]`
 *
 * One run = one story × one arm × one seed, in its own tree, with
 * SLOWCOOK_RUN_ID / SLOWCOOK_ARM set so every ledger row, halt and
 * summary the arm produces carries the run id. Everything the report
 * needs is copied into the run dir when the arm finishes (records.ts).
 *
 *   plain  → a detached worktree at --base; the story's spec, manifest and
 *            tests are REMOVED and committed away (ruling 3: issue text
 *            only); claude runs headless with native tools; the result is
 *            committed; the artifacts are restored from base and
 *            `slowcook verify --json` runs as the hidden oracle.
 *   brew   → `slowcook brew` in the MAIN checkout (brews run the db suite,
 *            and the local database stack is a per-directory singleton — a
 *            worktree spawns an orphan container fleet; lanes.ts lesson),
 *            checkout detached at --base first and the previous branch
 *            restored after. Refuses a dirty checkout. Timer must be OFF.
 *
 * `--dry-run` prints the plan (argv, env NAMES, paths) and writes nothing.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { costEntryUsd } from "@slowcook-ai/llm-anthropic";
import { ARM_ENV, RUN_ID_ENV, costSidecarPath, filterEntries, readCostTotal } from "../../cost-store.js";
import { resolveModel } from "../../lib/model-defaults.js";
import { importSpecifiers } from "../taste/head-files.js";
import { loadArms, resolveArm, runIdFor, type ArmConfig } from "./arms.js";
import { runPlainArm, type PlainIssue } from "./arm-plain.js";
import { baseVerifyName, runDirFor, type RunRecord } from "./records.js";
import {
  changedFiles, commitAll, currentBranch, defaultExec, ensureTree, gitSha, hideArtifacts, isClean,
  newestFile, readManifestTests, restoreArtifacts, storyArtifactPaths, trackedFiles, type Exec,
} from "./tree.js";

export interface RunArgs {
  storyId: string;
  arm: string;
  exp: string;
  seed: number;
  repoRoot: string;
  base: string;
  budgetUsd?: number;
  issue?: number;
  dryRun: boolean;
  skipDb: boolean;
  maxSessions?: number;
  /** Limit the oracle (and the base verify) to these declared suites. */
  oracleSuites?: string[];
}

export function parseRunArgs(argv: string[], now: () => Date = () => new Date()): RunArgs {
  const a: RunArgs = {
    storyId: "", arm: "", exp: `exp-${now().toISOString().slice(0, 10)}`, seed: 1,
    repoRoot: process.cwd(), base: "main", dryRun: false, skipDb: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]; const next = argv[i + 1];
    if ((arg === "--story" || arg === "--spec") && next) { a.storyId = next.replace(/^story-/, ""); i++; }
    else if (arg === "--arm" && next) { a.arm = next; i++; }
    else if (arg === "--exp" && next) { a.exp = next; i++; }
    else if (arg === "--seed" && next) { a.seed = Number(next); i++; }
    else if (arg === "--cwd" && next) { a.repoRoot = next; i++; }
    else if (arg === "--base" && next) { a.base = next; i++; }
    else if (arg === "--budget-usd" && next) { a.budgetUsd = Number(next); i++; }
    else if (arg === "--issue" && next) { a.issue = Number(next); i++; }
    else if (arg === "--max-sessions" && next) { a.maxSessions = Number(next); i++; }
    else if (arg === "--oracle-suites" && next) { a.oracleSuites = next.split(",").map((s) => s.trim()).filter(Boolean); i++; }
    else if (arg === "--dry-run") a.dryRun = true;
    else if (arg === "--skip-db") a.skipDb = true;
    else throw new Error(`experiment run: unknown option ${arg}`);
  }
  if (!a.storyId) throw new Error("experiment run: --story <id> is required");
  if (!a.arm) throw new Error("experiment run: --arm <name> is required");
  if (!Number.isFinite(a.seed) || a.seed < 1) throw new Error("experiment run: --seed must be a positive integer");
  return a;
}

/** The models the arm will resolve, from the ladder with the arm's env applied. Pure. */
export function modelsFor(arm: ArmConfig, env: NodeJS.ProcessEnv): Record<string, string> {
  const merged = { ...env, ...arm.env };
  if (arm.kind === "plain") return { plain: arm.model ?? "claude-sonnet-5-5" };
  const flagModel = arm.flags.includes("--model") ? arm.flags[arm.flags.indexOf("--model") + 1] : undefined;
  const nav = arm.flags.includes("--navigator-model") ? arm.flags[arm.flags.indexOf("--navigator-model") + 1] : undefined;
  return {
    brew: resolveModel("brew", flagModel, merged),
    ...(nav ? { navigator: nav } : {}),
  };
}

/** The brew argv for an arm. Pure; what `--dry-run` prints. */
export function brewArgv(a: { cliEntry: string; storyId: string; tree: string; base: string; budgetUsd?: number; flags: string[] }): string[] {
  return [
    a.cliEntry, "brew", "--story", a.storyId, "--cwd", a.tree, "--base", a.base,
    ...(a.budgetUsd !== undefined ? ["--budget-usd", String(a.budgetUsd)] : []),
    ...a.flags,
  ];
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function issueNumberFromSpec(spec: { source_issue?: string } | undefined): number | undefined {
  const m = spec?.source_issue?.match(/(\d+)\s*$/);
  return m ? Number(m[1]) : undefined;
}

function readSpec(tree: string, storyId: string): { source_issue?: string; clarifications?: Array<{ session: string; entries: string[] }> } | undefined {
  const p = join(tree, "specs", `story-${storyId}.yaml`);
  if (!existsSync(p)) return undefined;
  try { return YAML.parse(readFileSync(p, "utf8")) ?? undefined; } catch { return undefined; }
}

function fetchIssue(repoRoot: string, number: number): PlainIssue {
  const r = spawnSync("gh", ["issue", "view", String(number), "--json", "number,title,body"], { cwd: repoRoot, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`gh issue view ${number} failed: ${(r.stderr ?? "").slice(0, 200)}`);
  const j = JSON.parse(r.stdout) as PlainIssue;
  return { number: j.number, title: j.title, body: j.body ?? "" };
}

/** Run `slowcook verify --json` through the same cli entry; returns the parsed object (exit code ignored). */
function runVerifyJson(cliEntry: string, tree: string, storyId: string, base: string, skipDb: boolean, log: (l: string) => void, suites?: string[]): unknown {
  const args = [cliEntry, "verify", "--story", storyId, "--cwd", tree, "--base", base, "--json", ...(skipDb ? ["--skip-db"] : []), ...(suites && suites.length ? ["--suite", suites.join(",")] : [])];
  log(`verify: ${args.slice(1).join(" ")}`);
  const r = spawnSync(process.execPath, args, { cwd: tree, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: process.env });
  const out = r.stdout ?? "";
  const start = out.indexOf("{");
  if (start < 0) return { ok: false, story: storyId, base, sections: [], error: `verify produced no JSON (exit ${r.status}): ${(r.stderr ?? "").slice(-300)}` };
  try { return JSON.parse(out.slice(start)); } catch { return { ok: false, story: storyId, base, sections: [], error: "verify JSON unparseable" }; }
}

function writeJson(p: string, v: unknown): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(v, null, 2) + "\n", "utf8");
}

/** Import specifiers of each manifest test file — captured while the tree exists, for `classify`. */
export function captureTestImports(tree: string, tests: Array<{ file: string }>): Array<{ file: string; specifiers: string[] }> {
  const out: Array<{ file: string; specifiers: string[] }> = [];
  for (const file of new Set(tests.map((t) => t.file))) {
    const p = join(tree, file);
    if (!existsSync(p)) continue;
    const src = readFileSync(p, "utf8");
    // Static-check tests read a source file by PATH instead of importing it
    // (story-024's feed-list check): path literals count as reaching the file.
    const literals = src.match(/["'`]((?:src|app|lib|components|server)\/[\w\/.-]+)["'`]/g)?.map((m) => m.slice(1, -1)) ?? [];
    out.push({ file, specifiers: [...new Set([...importSpecifiers(src), ...literals])] });
  }
  return out;
}

export async function experimentRun(argv: string[]): Promise<void> {
  const args = parseRunArgs(argv);
  const log = (l: string): void => console.error(`experiment · ${l}`);
  const arms = loadArms(args.repoRoot);
  const arm = resolveArm(arms, args.arm);
  const runId = runIdFor(args.exp, args.storyId, arm.name, args.seed);
  const runDir = runDirFor(args.repoRoot, args.exp, args.storyId, arm.name, args.seed);
  const cliEntry = process.argv[1]!;
  const exec: Exec = defaultExec;
  const baseSha = gitSha(args.repoRoot, args.base.startsWith("origin/") || /^[0-9a-f]{7,40}$/.test(args.base) ? args.base : `origin/${args.base}`, exec);
  const tree = arm.kind === "plain" ? join(runDir, "tree") : args.repoRoot;
  const envForArm: NodeJS.ProcessEnv = { ...process.env, ...arm.env, [RUN_ID_ENV]: runId, [ARM_ENV]: arm.name };
  const models = modelsFor(arm, process.env);
  const brewArgs = brewArgv({ cliEntry, storyId: args.storyId, tree, base: args.base, budgetUsd: args.budgetUsd, flags: arm.flags });

  if (args.dryRun) {
    console.log(JSON.stringify({
      run_id: runId, run_dir: runDir, tree, kind: arm.kind, base: args.base, base_sha: baseSha, models,
      env_names: [...Object.keys(arm.env), RUN_ID_ENV, ARM_ENV].sort(),
      argv: arm.kind === "brew" ? [process.execPath, ...brewArgs] : ["claude", "-p", "<issue prompt>", "--allowedTools", "<native>", "--output-format", "stream-json", "--verbose", "--max-turns", "40", "--model", models["plain"]],
      oracle: `slowcook verify --story ${args.storyId} --json${args.skipDb || arm.kind === "plain" ? " --skip-db" : ""}${args.oracleSuites ? ` --suite ${args.oracleSuites.join(",")}` : ""}`,
      notes: arm.notes,
    }, null, 2));
    return;
  }

  if (existsSync(join(runDir, "run.json"))) throw new Error(`run ${runId} already exists at ${runDir} — pick another --seed or --exp`);
  mkdirSync(runDir, { recursive: true });
  const started = new Date();
  const record: RunRecord = {
    run_id: runId, exp: args.exp, story: args.storyId, arm: arm.name, kind: arm.kind, seed: args.seed,
    base_ref: args.base, base_sha: baseSha, models, env_names: [...Object.keys(arm.env), RUN_ID_ENV, ARM_ENV].sort(),
    flags: arm.flags, tree, started_at: started.toISOString(),
  };
  const specAtBase = (() => { try { return exec(`git show ${baseSha}:specs/story-${args.storyId}.yaml`, args.repoRoot); } catch { return undefined; } })();
  if (specAtBase) record.spec_sha256 = sha256(specAtBase);
  writeJson(join(runDir, "run.json"), record);
  log(`run ${runId} → ${runDir}`);

  const finish = (patch: Partial<RunRecord>): void => {
    const finished = new Date();
    Object.assign(record, patch, { finished_at: finished.toISOString(), wall_ms: finished.getTime() - started.getTime() });
    writeJson(join(runDir, "run.json"), record);
  };

  try {
    if (arm.kind === "plain") await runPlain({ args, arm, runId, runDir, tree, baseSha, cliEntry, exec, log, envForArm, record });
    else await runBrew({ args, arm, runId, runDir, tree, baseSha, cliEntry, exec, log, envForArm, brewArgs, record });
    finish({ exit_code: 0 });
  } catch (e) {
    finish({ exit_code: 1, error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
  log(`done ${runId} in ${Math.round((record.wall_ms ?? 0) / 1000)}s`);
}

interface Flow {
  args: RunArgs; arm: ArmConfig; runId: string; runDir: string; tree: string; baseSha: string; cliEntry: string;
  exec: Exec; log: (l: string) => void; envForArm: NodeJS.ProcessEnv; record: RunRecord;
}

async function runPlain(f: Flow): Promise<void> {
  const { args, arm, runDir, tree, baseSha, cliEntry, exec, log } = f;
  ensureTree(args.repoRoot, tree, baseSha, exec);
  // The hidden oracle's expectations, captured while the artifacts exist.
  const manifestTests = readManifestTests(tree, args.storyId);
  const spec = readSpec(tree, args.storyId);
  const issueNumber = args.issue ?? issueNumberFromSpec(spec);
  if (!issueNumber) throw new Error(`no issue for story-${args.storyId}: spec has no source_issue — pass --issue <n>`);
  writeJson(join(runDir, "test-imports.json"), captureTestImports(tree, manifestTests));
  writeJson(join(runDir, "clarifications.json"), (spec?.clarifications ?? []).flatMap((s) => s.entries));
  const baseVerifyPath = join(runDir, "..", baseVerifyName(args.oracleSuites));
  if (!existsSync(baseVerifyPath)) writeJson(baseVerifyPath, runVerifyJson(cliEntry, tree, args.storyId, args.base, true, log, args.oracleSuites));

  const artifacts = storyArtifactPaths(args.storyId, manifestTests, trackedFiles(tree, exec));
  hideArtifacts(tree, artifacts, exec);
  writeJson(join(runDir, "hidden-artifacts.json"), artifacts);
  const hiddenSha = gitSha(tree, "HEAD", exec);
  log(`plain: hid ${artifacts.length} artifact(s); fetching issue #${issueNumber}`);
  const issue = fetchIssue(args.repoRoot, issueNumber);
  writeJson(join(runDir, "issue.json"), issue);

  const transcripts = join(runDir, "transcripts");
  mkdirSync(transcripts, { recursive: true });
  let k = 0;
  const result = await runPlainArm({
    repoRoot: tree,
    issue,
    model: arm.model ?? "claude-sonnet-5-5",
    budgetUsd: args.budgetUsd ?? 3,
    maxSessions: args.maxSessions,
    priceFor: costEntryUsd,
    log,
    exec: (cmd, xs, cwd) => {
      const r = spawnSync(cmd, xs, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60_000, env: { ...f.envForArm } });
      const stdout = (r.stdout ?? "") + "\n" + (r.stderr ?? "");
      writeFileSync(join(transcripts, `session-${++k}.jsonl`), stdout, "utf8");
      return { stdout, status: r.status };
    },
  });
  const committed = commitAll(tree, `experiment: plain arm result for issue #${issueNumber}`, exec);
  const changed = changedFiles(tree, hiddenSha, exec);
  writeJson(join(runDir, "plain.json"), { ...result, committed, files_changed: changed });
  f.record.branch = gitSha(tree, "HEAD", exec);
  log(`plain: ${result.stop} after ${result.sessions} session(s), ${changed.length} file(s) changed; running the hidden oracle`);
  restoreArtifacts(tree, baseSha, artifacts, exec);
  writeJson(join(runDir, "verify.json"), runVerifyJson(cliEntry, tree, args.storyId, args.base, true, log, args.oracleSuites));
  f.record.oracle_skip_db = true;
  if (args.oracleSuites) f.record.oracle_suites = args.oracleSuites;
}

async function runBrew(f: Flow & { brewArgs: string[] }): Promise<void> {
  const { args, runDir, tree, baseSha, cliEntry, exec, log, envForArm, brewArgs } = f;
  if (!isClean(tree, exec)) throw new Error(`brew arms run in the main checkout and it is dirty — commit or stash first (${tree})`);
  const previous = currentBranch(tree, exec);
  const manifestTests = readManifestTests(tree, args.storyId);
  exec(`git checkout -q --detach ${baseSha}`, tree);
  try {
    writeJson(join(runDir, "test-imports.json"), captureTestImports(tree, manifestTests));
    const spec = readSpec(tree, args.storyId);
    writeJson(join(runDir, "clarifications.json"), (spec?.clarifications ?? []).flatMap((s) => s.entries));
    const baseVerifyPath = join(runDir, "..", baseVerifyName(args.oracleSuites));
    if (!existsSync(baseVerifyPath)) writeJson(baseVerifyPath, runVerifyJson(cliEntry, tree, args.storyId, args.base, args.skipDb, log, args.oracleSuites));

    log(`brew: ${brewArgs.slice(1).join(" ")}  env=${f.record.env_names.join(",")}`);
    const r = spawnSync(process.execPath, brewArgs, { cwd: tree, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: envForArm });
    writeFileSync(join(runDir, "brew.stdout.log"), (r.stdout ?? "") + "\n--- stderr ---\n" + (r.stderr ?? ""), "utf8");
    f.record.exit_code = r.status;

    // Collect what brew left behind, by run id where it carries one.
    const haltsDir = join(tree, ".brewing", "halts");
    const halt = pickByRunId(haltsDir, new RegExp(`^story-${args.storyId}-.*\\.json$`), f.runId);
    if (halt) copyFileSync(halt, join(runDir, "halt.json"));
    const runsRoot = join(tree, ".brewing", "local", "runs");
    const summaryDir = newestRunDir(runsRoot, args.storyId, f.runId);
    if (summaryDir) {
      if (existsSync(join(summaryDir, "summary.json"))) copyFileSync(join(summaryDir, "summary.json"), join(runDir, "summary.json"));
      if (existsSync(join(summaryDir, "iterations.log"))) copyFileSync(join(summaryDir, "iterations.log"), join(runDir, "iterations.log"));
    }
    const ledger = existsSync(costSidecarPath(tree, args.storyId)) ? filterEntries(readCostTotal(tree, args.storyId).entries, { run_id: f.runId }) : [];
    writeFileSync(join(runDir, "cost.jsonl"), ledger.map((e) => JSON.stringify(e)).join("\n") + (ledger.length ? "\n" : ""), "utf8");
    f.record.branch = currentBranch(tree, exec);
    log(`brew: exit ${r.status}, ${ledger.length} ledger row(s), branch ${f.record.branch}; verifying`);
    writeJson(join(runDir, "verify.json"), runVerifyJson(cliEntry, tree, args.storyId, args.base, args.skipDb, log, args.oracleSuites));
    f.record.oracle_skip_db = args.skipDb;
    if (args.oracleSuites) f.record.oracle_suites = args.oracleSuites;
  } finally {
    // Leave the main checkout as we found it. The tree was asserted CLEAN at
    // the start, so everything modified or untracked now was made by this run
    // and has been copied into the run dir: brew's uncommitted provenance
    // write and its .brewing/halts/ files blocked the next arm on the first
    // smoke run ("main checkout is dirty"). Ignored files (.brewing/local)
    // are not touched (no -x).
    try { exec("git checkout -q -- .", tree); exec("git clean -fdq", tree); } catch { log("could not clean the main checkout after brew"); }
    try { exec(`git checkout -q ${JSON.stringify(previous)}`, tree); } catch { log(`could not restore branch ${previous}; the checkout is left as brew left it`); }
  }
}

/** Newest JSON in `dir` matching `re` whose run_id is `runId`, else the newest at all. */
function pickByRunId(dir: string, re: RegExp, runId: string): string | null {
  if (!existsSync(dir)) return null;
  const newest = newestFile(dir, re);
  for (const f of readdirSync(dir).filter((x) => re.test(x))) {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as { run_id?: string };
      if (j.run_id === runId) return join(dir, f);
    } catch { /* skip */ }
  }
  return newest;
}

function newestRunDir(runsRoot: string, storyId: string, runId: string): string | null {
  if (!existsSync(runsRoot)) return null;
  const dirs = readdirSync(runsRoot).filter((d) => d.startsWith(`story-${storyId}-`)).map((d) => join(runsRoot, d));
  dirs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const d of dirs) {
    try {
      const j = JSON.parse(readFileSync(join(d, "summary.json"), "utf8")) as { run_id?: string };
      if (j.run_id === runId) return d;
    } catch { /* no summary yet */ }
  }
  return dirs[0] ?? null;
}
