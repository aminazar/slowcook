/**
 * `slowcook experiment run | report | classify` — the swarm-vs-plain
 * harness (2026-10-24, measure-first ruling). See
 * docs/experiments/swarm-vs-plain-2026-10-24.md for the protocol.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { costEntryUsd } from "@slowcook-ai/llm-anthropic";
import { experimentRun } from "./run.js";
import { aggregateRuns, priceBasis, renderMarkdown } from "./report.js";
import { classifyRun, writeClassification } from "./classify.js";
import { findRun, loadRuns } from "./records.js";
import { DEFAULT_ARMS, loadArms } from "./arms.js";

function help(): void {
  console.log(`slowcook experiment — compare arms (plain Claude Code · pipeline · swarm) on cost, coverage and speed

Usage:
  slowcook experiment run --story <id> --arm <name> [--exp <id>] [--seed <k>] [--base <ref>]
                          [--budget-usd <n>] [--issue <n>] [--skip-db] [--max-sessions <n>] [--dry-run] [--cwd <path>]
  slowcook experiment report [--exp <id>] [--json|--md] [--cwd <path>]
  slowcook experiment classify --run <exp/story/arm/seed> [--confirm <class> --by <name> [--note <text>]] [--cwd <path>]
  slowcook experiment arms [--cwd <path>]

Arms (defaults; override in .brewing/experiments/arms.json):
${Object.values(DEFAULT_ARMS).map((a) => `  ${a.name.padEnd(9)} ${a.kind.padEnd(6)} ${a.notes}`).join("\n")}

Runs live under .brewing/local/experiments/<exp>/<story>/<arm>-<seed>/ (run.json, verify.json,
cost.jsonl, summary.json, halt.json, plain.json, transcripts/, classification.json).
Brew arms run in the MAIN checkout (db singleton) — timer OFF, clean tree. Plain arms get a worktree.`);
}

export async function experiment(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") { help(); return; }
  const cwdIdx = argv.indexOf("--cwd");
  const repoRoot = cwdIdx >= 0 && argv[cwdIdx + 1] ? argv[cwdIdx + 1]! : process.cwd();
  switch (sub) {
    case "run":
      await experimentRun(argv.slice(1));
      return;
    case "arms": {
      const arms = loadArms(repoRoot);
      for (const a of Object.values(arms)) {
        console.log(`${a.name}  (${a.kind})  env=[${Object.keys(a.env).join(",")}]  flags=[${a.flags.join(" ")}]${a.model ? `  model=${a.model}` : ""}\n  ${a.notes}`);
      }
      return;
    }
    case "report": {
      const expIdx = argv.indexOf("--exp");
      const exp = expIdx >= 0 ? argv[expIdx + 1] : undefined;
      const runs = loadRuns(repoRoot, exp);
      const rows = aggregateRuns(runs, costEntryUsd);
      const basis = priceBasis(runs, costEntryUsd);
      if (argv.includes("--json")) { console.log(JSON.stringify({ exp: exp ?? "*", runs: runs.length, rows, price_basis: basis }, null, 2)); return; }
      if (runs.length === 0) { console.log(`no runs under .brewing/local/experiments${exp ? `/${exp}` : ""}`); return; }
      console.log(renderMarkdown(rows, basis));
      return;
    }
    case "classify": {
      const runIdx = argv.indexOf("--run");
      const runId = runIdx >= 0 ? argv[runIdx + 1] : undefined;
      if (!runId) { console.error("experiment classify: --run <exp/story/arm/seed> is required"); process.exit(64); }
      const run = findRun(repoRoot, runId);
      if (!run) { console.error(`experiment classify: no run ${runId} under .brewing/local/experiments`); process.exit(2); }
      const readJson = <T,>(name: string, fallback: T): T => {
        const p = join(run.dir, name);
        if (!existsSync(p)) return fallback;
        try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return fallback; }
      };
      const logPath = join(run.dir, "iterations.log");
      const c = classifyRun(run, {
        iterationsLog: existsSync(logPath) ? readFileSync(logPath, "utf8") : undefined,
        testImports: readJson("test-imports.json", []),
        clarifications: readJson("clarifications.json", []),
      });
      const confIdx = argv.indexOf("--confirm");
      if (confIdx >= 0 && argv[confIdx + 1]) {
        const byIdx = argv.indexOf("--by");
        const noteIdx = argv.indexOf("--note");
        c.confirmed_class = argv[confIdx + 1]!;
        c.confirmed_by = byIdx >= 0 ? argv[byIdx + 1] : undefined;
        c.note = noteIdx >= 0 ? argv[noteIdx + 1] : c.note;
      }
      const p = writeClassification(run.dir, c);
      console.log(`${runId}: draft ${c.draft_class}${c.confirmed_class ? ` · confirmed ${c.confirmed_class} by ${c.confirmed_by ?? "?"}` : " (unconfirmed — a human decides; pass --confirm)"}`);
      for (const s of c.signals) console.log(`  - ${s.kind}: ${s.evidence}`);
      if (c.signals.length === 0) console.log("  (no signals fired)");
      console.log(`  → ${p}`);
      return;
    }
    default:
      console.error(`experiment: unknown subcommand ${sub}`);
      help();
      process.exit(64);
  }
}
