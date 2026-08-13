/**
 * `slowcook cost reprice` — settle cost entries against the CURRENT pricing table.
 *
 * Why this exists (dovizir dual-build run, 2026-08-13): a real refine logged
 * `{"agent":"refine","usd":0,"model":"claude-opus-5","tokens_out":3519}` —
 * the tokens were counted, the dollars were not, because the model was
 * missing from `PRICING_PER_M_TOKENS`. Every entry already carries its token
 * counts; that is exactly what makes a pricing-table gap RECOVERABLE rather
 * than permanent data loss. This walks the sidecars and recomputes `usd`
 * from stored tokens × today's table.
 *
 * It also normalizes a price basis across runs — needed to compare two arms
 * of an experiment that ran days apart at different list prices.
 *
 *   slowcook cost reprice --story 001
 *   slowcook cost reprice --all --dry-run
 *
 * Entries with no model or no token record are left untouched (nothing to
 * recompute from). Entries whose model is still unpriced become `usd: null`
 * — unknown, never a silent $0.
 */
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { costEntryUsd } from "@slowcook-ai/llm-anthropic";
import {
  readCostTotal,
  repriceEntries,
  writeCostEntries,
  applyCostToSpec,
} from "../cost-store.js";

export interface RepriceArgs {
  story?: string;
  all?: boolean;
  dryRun?: boolean;
}

export function parseRepriceArgs(argv: string[]): RepriceArgs {
  const args: RepriceArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--story") args.story = argv[++i];
    else if (a === "--all") args.all = true;
    else if (a === "--dry-run") args.dryRun = true;
  }
  return args;
}

/** Story ids with a cost sidecar, from `specs/story-<id>.cost.jsonl`. Pure-ish
 *  (one readdir) so the command body stays a thin shell. */
export function storiesWithSidecars(repoRoot: string): string[] {
  const dir = join(repoRoot, "specs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => /^story-(.+)\.cost\.jsonl$/.exec(f)?.[1])
    .filter((id): id is string => !!id)
    .sort();
}

export async function costReprice(argv: string[], _version?: string): Promise<void> {
  const args = parseRepriceArgs(argv);
  const repoRoot = process.cwd();

  if (!args.story && !args.all) {
    console.error("slowcook cost reprice: pass --story <id> or --all (add --dry-run to preview).");
    process.exit(64);
  }

  const ids = args.story ? [args.story] : storiesWithSidecars(repoRoot);
  if (ids.length === 0) {
    console.log("cost reprice: no cost sidecars found under specs/.");
    return;
  }

  let touched = 0, stillUnpriced = 0;
  for (const id of ids) {
    const { entries } = readCostTotal(repoRoot, id);
    if (entries.length === 0) continue;
    const { entries: next, changed } = repriceEntries(entries, costEntryUsd);
    stillUnpriced += next.filter((e) => e.usd === null).length;
    if (changed.length === 0) continue;
    touched += 1;
    console.log(`story-${id}: ${changed.length} entr${changed.length === 1 ? "y" : "ies"} repriced`);
    for (const c of changed) {
      const from = c.from === null ? "unpriced" : `$${c.from.toFixed(4)}`;
      const to = c.to === null ? "unpriced" : `$${c.to.toFixed(4)}`;
      console.log(`  ${c.model}  ${from} → ${to}   (${c.at})`);
    }
    if (!args.dryRun) {
      writeCostEntries(repoRoot, id, next);
      applyCostToSpec(repoRoot, id);
    }
  }

  if (touched === 0) console.log("cost reprice: every entry already matches the current pricing table.");
  else if (args.dryRun) console.log(`\n(dry run — nothing written. Re-run without --dry-run to apply.)`);
  else console.log(`\nRepriced ${touched} sidecar${touched === 1 ? "" : "s"} and refreshed their spec totals.`);

  if (stillUnpriced > 0) {
    console.log(`${stillUnpriced} entr${stillUnpriced === 1 ? "y" : "ies"} remain unpriced — add the model(s) to PRICING_PER_M_TOKENS and re-run.`);
  }
}
