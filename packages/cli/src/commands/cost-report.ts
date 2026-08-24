/**
 * `slowcook cost report` (2026-08-24, #501 "cost ledger needs a reader").
 *
 * The write side existed for months (`cost log`, per-story
 * specs/story-<id>.cost.jsonl sidecars, the per-story PIPELINE BILL on
 * ship notices) — but the only way to answer "what did this project's
 * pipeline cost?" was grepping iteration logs by hand, which is exactly
 * how the round-2 dollar report was produced. This is the read side:
 * one command, per-story × per-agent × per-model rollups, honest about
 * unpriced entries (unknown spend is never presented as $0).
 */

import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readCostTotal, type CostEntry } from "../cost-store.js";

interface ReportArgs {
  repoRoot: string;
  storyId: string | null;
  json: boolean;
}

export interface StoryCost {
  storyId: string;
  totalUsd: number;
  entries: number;
  unpriced: number;
  byAgent: Record<string, number>;
  byModel: Record<string, number>;
}

function parseArgs(argv: string[]): ReportArgs {
  const args: ReportArgs = { repoRoot: process.cwd(), storyId: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if ((arg === "--story" || arg === "--spec") && next) { args.storyId = next.replace(/^story-/, ""); i++; }
    else if (arg === "--cwd" && next) { args.repoRoot = next; i++; }
    else if (arg === "--json") { args.json = true; }
    else if (arg === "--help" || arg === "-h") { printHelp(); process.exit(0); }
    else { console.error(`Unknown option: ${arg}`); printHelp(); process.exit(64); }
  }
  return args;
}

function printHelp(): void {
  console.log(`slowcook cost report — read the pipeline's spend ledger

Usage:
  slowcook cost report [--story <id>] [--cwd <path>] [--json]

Without --story: every story with a cost sidecar, per-agent and
per-model rollups, grand total. With --story: that story's per-round
entries. Unpriced entries (usd: null) are counted separately — unknown
spend is never presented as \$0; settle them with \`slowcook cost reprice\`.`);
}

/** Aggregate one story's entries. Pure; exported for tests. */
export function aggregateStory(storyId: string, entries: CostEntry[], unpriced: number): StoryCost {
  const byAgent: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  let total = 0;
  for (const e of entries) {
    const usd = typeof e.usd === "number" ? e.usd : 0;
    total += usd;
    byAgent[e.agent] = (byAgent[e.agent] ?? 0) + usd;
    const model = e.model ?? "(unrecorded)";
    byModel[model] = (byModel[model] ?? 0) + usd;
  }
  return { storyId, totalUsd: total, entries: entries.length, unpriced, byAgent, byModel };
}

/** Story ids with cost sidecars under specs/. Pure over the listing. */
export function storiesWithSidecars(fileNames: string[]): string[] {
  return fileNames
    .map((f) => f.match(/^story-(.+)\.cost\.jsonl$/)?.[1])
    .filter((x): x is string => !!x)
    .sort();
}

const money = (n: number): string => `$${n.toFixed(2)}`;

export async function costReport(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const specsDir = join(args.repoRoot, "specs");
  if (!existsSync(specsDir)) {
    console.error(`No specs/ directory at ${args.repoRoot} — no cost sidecars to read.`);
    process.exit(2);
  }

  if (args.storyId) {
    const { totalUsd, entries, unpricedCount } = readCostTotal(args.repoRoot, args.storyId);
    if (entries.length === 0) {
      console.log(`No cost entries for story-${args.storyId}.`);
      return;
    }
    if (args.json) {
      console.log(JSON.stringify({ story: args.storyId, totalUsd, unpriced: unpricedCount, entries }, null, 2));
      return;
    }
    console.log(`story-${args.storyId} — ${entries.length} entr${entries.length === 1 ? "y" : "ies"}\n`);
    for (const e of entries) {
      console.log(
        `  ${e.at ?? "?"}  ${e.agent.padEnd(14)} ${(e.round ?? "").padEnd(18)} ` +
          `${e.usd === null ? "UNPRICED" : money(e.usd).padStart(8)}  ${e.model ?? ""}`
      );
    }
    console.log(
      `\n  total ${money(totalUsd)}` +
        (unpricedCount > 0 ? `  (+ ${unpricedCount} unpriced entr${unpricedCount === 1 ? "y" : "ies"} — real spend, unknown amount; run \`slowcook cost reprice\`)` : "")
    );
    return;
  }

  const ids = storiesWithSidecars(readdirSync(specsDir));
  if (ids.length === 0) {
    console.log("No cost sidecars found under specs/.");
    return;
  }
  const stories: StoryCost[] = ids.map((id) => {
    const { totalUsd, entries, unpricedCount } = readCostTotal(args.repoRoot, id);
    return aggregateStory(id, entries, unpricedCount);
  });
  if (args.json) {
    console.log(JSON.stringify({ stories }, null, 2));
    return;
  }

  const agentTotals: Record<string, number> = {};
  const modelTotals: Record<string, number> = {};
  let grand = 0;
  let unpricedTotal = 0;
  for (const s of stories) {
    grand += s.totalUsd;
    unpricedTotal += s.unpriced;
    for (const [a, v] of Object.entries(s.byAgent)) agentTotals[a] = (agentTotals[a] ?? 0) + v;
    for (const [m, v] of Object.entries(s.byModel)) modelTotals[m] = (modelTotals[m] ?? 0) + v;
  }

  console.log("story      total     agents");
  for (const s of stories) {
    const agents = Object.entries(s.byAgent)
      .sort((a, b) => b[1] - a[1])
      .map(([a, v]) => `${a} ${money(v)}`)
      .join(" · ");
    console.log(
      `${("story-" + s.storyId).padEnd(10)} ${money(s.totalUsd).padStart(8)}  ${agents}` +
        (s.unpriced > 0 ? `  (+${s.unpriced} unpriced)` : "")
    );
  }
  console.log("\nby agent:");
  for (const [a, v] of Object.entries(agentTotals).sort((x, y) => y[1] - x[1])) {
    console.log(`  ${a.padEnd(16)} ${money(v).padStart(8)}`);
  }
  console.log("by model:");
  for (const [m, v] of Object.entries(modelTotals).sort((x, y) => y[1] - x[1])) {
    console.log(`  ${m.padEnd(28)} ${money(v).padStart(8)}`);
  }
  console.log(
    `\nTOTAL ${money(grand)} across ${stories.length} stor${stories.length === 1 ? "y" : "ies"}` +
      (unpricedTotal > 0 ? `  (+ ${unpricedTotal} unpriced entr${unpricedTotal === 1 ? "y" : "ies"} — unknown spend, not $0; run \`slowcook cost reprice\`)` : "")
  );
}
