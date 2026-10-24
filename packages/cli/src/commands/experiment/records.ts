/**
 * On-disk shape of one experiment run. Everything `report` and `classify`
 * read lives under `.brewing/local/experiments/<exp>/<story>/<arm>-<seed>/`:
 *
 *   run.json          RunRecord (written at start, completed at end)
 *   verify.json       `slowcook verify --json` on the arm's result
 *   cost.jsonl        the ledger rows carrying this run_id
 *   summary.json      brew's per-run summary (brew arms)
 *   halt.json         the halt report (brew arms)
 *   plain.json        the plain arm's session record
 *   classification.json   `experiment classify` output (draft + confirmation)
 *
 * plus `<exp>/<story>/base.verify.json`, the base-branch verify shared by
 * every arm of that story (the regression columns diff against it).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CostEntry } from "../../cost-store.js";
import type { VerifyResult } from "../verify/index.js";
import type { HaltReport } from "../brew/halt.js";
import type { RunSummary } from "../brew/agent.js";
import type { PlainRunResult } from "./arm-plain.js";

export const EXPERIMENTS_DIR = join(".brewing", "local", "experiments");

export interface RunRecord {
  run_id: string;
  exp: string;
  story: string;
  arm: string;
  kind: "plain" | "brew";
  seed: number;
  base_ref: string;
  base_sha: string;
  spec_sha256?: string;
  /** Resolved model per stage at start (from the model ladder). */
  models: Record<string, string>;
  /** Names ONLY of the env vars the arm set — never values. */
  env_names: string[];
  flags: string[];
  tree: string;
  branch?: string;
  /** The hidden oracle ran with --skip-db (worktree runs). */
  oracle_skip_db?: boolean;
  started_at: string;
  finished_at?: string;
  wall_ms?: number;
  exit_code?: number | null;
  error?: string;
}

export interface Classification {
  run_id: string;
  signals: Array<{ kind: string; evidence: string }>;
  draft_class: "knowledge/re-discovery" | "knowledge/wrong-file" | "knowledge/wrong-signature" | "knowledge/lost-clarification" | "reasoning" | "harness" | "none";
  confirmed_class?: string;
  confirmed_by?: string;
  note?: string;
  generated_at: string;
}

export interface LoadedRun {
  dir: string;
  record: RunRecord;
  verify?: VerifyResult;
  baseVerify?: VerifyResult;
  cost: CostEntry[];
  summary?: RunSummary;
  halt?: HaltReport;
  plain?: PlainRunResult;
  classification?: Classification;
}

function readJson<T>(p: string): T | undefined {
  if (!existsSync(p)) return undefined;
  try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return undefined; }
}

function readJsonl<T>(p: string): T[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => {
    try { return [JSON.parse(l) as T]; } catch { return []; }
  });
}

export function runDirFor(repoRoot: string, exp: string, story: string, arm: string, seed: number): string {
  return join(repoRoot, EXPERIMENTS_DIR, exp, story, `${arm}-${seed}`);
}

export function loadRun(dir: string): LoadedRun | null {
  const record = readJson<RunRecord>(join(dir, "run.json"));
  if (!record) return null;
  return {
    dir,
    record,
    verify: readJson<VerifyResult>(join(dir, "verify.json")),
    baseVerify: readJson<VerifyResult>(join(dir, "..", "base.verify.json")),
    cost: readJsonl<CostEntry>(join(dir, "cost.jsonl")),
    summary: readJson<RunSummary>(join(dir, "summary.json")),
    halt: readJson<HaltReport>(join(dir, "halt.json")),
    plain: readJson<PlainRunResult>(join(dir, "plain.json")),
    classification: readJson<Classification>(join(dir, "classification.json")),
  };
}

/** Every run under one experiment (or all experiments when `exp` is omitted). */
export function loadRuns(repoRoot: string, exp?: string): LoadedRun[] {
  const root = join(repoRoot, EXPERIMENTS_DIR);
  if (!existsSync(root)) return [];
  const exps = exp ? [exp] : readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory());
  const out: LoadedRun[] = [];
  for (const e of exps) {
    const expDir = join(root, e);
    if (!existsSync(expDir)) continue;
    for (const story of readdirSync(expDir)) {
      const storyDir = join(expDir, story);
      if (!statSync(storyDir).isDirectory()) continue;
      for (const run of readdirSync(storyDir)) {
        const dir = join(storyDir, run);
        if (!statSync(dir).isDirectory()) continue;
        const loaded = loadRun(dir);
        if (loaded) out.push(loaded);
      }
    }
  }
  return out.sort((a, b) => a.record.run_id.localeCompare(b.record.run_id));
}

/** Find a run by id across experiments. */
export function findRun(repoRoot: string, runId: string): LoadedRun | null {
  return loadRuns(repoRoot).find((r) => r.record.run_id === runId) ?? null;
}
