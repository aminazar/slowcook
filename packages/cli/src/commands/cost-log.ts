/**
 * `slowcook cost log` — 0.19.x+
 *
 * Append a cost entry for a non-Actions agent run into the canonical
 * cost sidecar (`specs/story-<id>.cost.jsonl`).
 *
 * Why this exists: slowcook agents that run in-process emit cost
 * markers + `appendCostEntry` calls automatically. But long-lived
 * agents OUTSIDE slowcook's process (Claude Code session in a
 * consumer repo, Managed Agents, Cursor mimicking the pipeline)
 * generate no cost entries — their LLM spend is invisible to the
 * cost-store + the workflow rollup. That makes "what does the
 * methodology cost end-to-end" unanswerable, which matters for
 * 0.20's AI-native-org thesis.
 *
 * This subcommand is the explicit logging primitive for those agents.
 * Usage:
 *
 *   slowcook cost log \\
 *     --story 009 \\
 *     --usd 0.42 \\
 *     --agent local-claude-pipeline \\
 *     [--model claude-opus-4-7] \\
 *     [--source-url https://github.com/.../pull/698] \\
 *     [--round brew-iteration-3] \\
 *     [--tokens-in 12000] [--tokens-out 1500] \\
 *     [--cache-read 85000] [--cache-create 12000] \\
 *     [--apply-to-spec]
 *
 * `--apply-to-spec` recomputes spec.cost.total_usd from the full
 * sidecar after appending (same call slowcook agents make in-process).
 *
 * The convention: each session's log a single entry summarising the
 * whole session (`--usd $TOTAL`), or one entry per logical round
 * (refine-mimic, testgen-mimic, brew-mimic, …). Either works; the
 * aggregator just sums.
 */

import {
  appendCostEntry,
  applyCostToSpec,
  costSidecarPath,
  type CostEntry,
} from "../cost-store.js";

export interface CostLogArgs {
  repoRoot: string;
  storyId: string;
  entry: CostEntry;
  applyToSpec: boolean;
}

export interface CostLogResult {
  sidecarPath: string;
  appendedEntry: CostEntry;
  appliedToSpec: boolean;
}

export function costLogCore(args: CostLogArgs): CostLogResult {
  appendCostEntry(args.repoRoot, args.storyId, args.entry);
  let appliedToSpec = false;
  if (args.applyToSpec) {
    applyCostToSpec(args.repoRoot, args.storyId);
    appliedToSpec = true;
  }
  return {
    sidecarPath: costSidecarPath(args.repoRoot, args.storyId),
    appendedEntry: args.entry,
    appliedToSpec,
  };
}

interface ParsedArgs {
  storyId?: string;
  usd?: number;
  agent?: string;
  model?: string;
  sourceUrl?: string;
  round?: string;
  tokensIn?: number;
  tokensOut?: number;
  cacheRead?: number;
  cacheCreate?: number;
  applyToSpec: boolean;
  help: boolean;
}

/** Pure arg parser — exported for testing. */
export function parseCostLogArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { applyToSpec: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--story":
        if (next !== undefined) { out.storyId = next; i++; }
        break;
      case "--usd":
        if (next !== undefined) { out.usd = parseFloat(next); i++; }
        break;
      case "--agent":
        if (next !== undefined) { out.agent = next; i++; }
        break;
      case "--model":
        if (next !== undefined) { out.model = next; i++; }
        break;
      case "--source-url":
        if (next !== undefined) { out.sourceUrl = next; i++; }
        break;
      case "--round":
        if (next !== undefined) { out.round = next; i++; }
        break;
      case "--tokens-in":
        if (next !== undefined) { out.tokensIn = parseInt(next, 10); i++; }
        break;
      case "--tokens-out":
        if (next !== undefined) { out.tokensOut = parseInt(next, 10); i++; }
        break;
      case "--cache-read":
        if (next !== undefined) { out.cacheRead = parseInt(next, 10); i++; }
        break;
      case "--cache-create":
        if (next !== undefined) { out.cacheCreate = parseInt(next, 10); i++; }
        break;
      case "--apply-to-spec":
        out.applyToSpec = true;
        break;
      case "--help":
      case "-h":
        out.help = true;
        break;
    }
  }
  return out;
}

function printHelp(): void {
  console.log(`slowcook cost log — append a non-Actions agent's cost into the story sidecar

Required:
  --story <id>        story id (e.g. "009")
  --usd <amount>      cost of this run in USD (e.g. 0.42)
  --agent <name>      identifier for the emitting agent
                      (e.g. local-claude-pipeline, cursor, codex-mimic)

Optional:
  --model <id>        model used (e.g. claude-opus-4-7)
  --source-url <url>  PR / comment / run URL where the work happened
  --round <label>     round label (e.g. refine-mimic, brew-iter-3)
  --tokens-in <n>     input tokens consumed
  --tokens-out <n>    output tokens produced
  --cache-read <n>    cache-hit tokens read
  --cache-create <n>  cache-write tokens
  --apply-to-spec     after appending, recompute spec.cost.total_usd
                      from the sidecar (same call in-process agents make)
  --help, -h          show this help

Example:
  slowcook cost log --story 009 --usd 0.42 \\
    --agent local-claude-pipeline --model claude-opus-4-7 \\
    --source-url https://github.com/delgoosh/monorepo/pull/698 \\
    --apply-to-spec
`);
}

export async function costLog(argv: string[]): Promise<void> {
  const parsed = parseCostLogArgs(argv);
  if (parsed.help) { printHelp(); return; }

  const missing: string[] = [];
  if (!parsed.storyId) missing.push("--story");
  if (parsed.usd === undefined || Number.isNaN(parsed.usd)) missing.push("--usd");
  if (!parsed.agent) missing.push("--agent");
  if (missing.length > 0) {
    console.error(`slowcook cost log: missing required args: ${missing.join(", ")}`);
    console.error(`run \`slowcook cost log --help\` for usage`);
    process.exit(64);
  }

  const entry: CostEntry = {
    agent: parsed.agent!,
    usd: parsed.usd!,
    at: new Date().toISOString(),
  };
  if (parsed.model !== undefined) entry.model = parsed.model;
  if (parsed.sourceUrl !== undefined) entry.source_url = parsed.sourceUrl;
  if (parsed.round !== undefined) entry.round = parsed.round;
  if (parsed.tokensIn !== undefined) entry.tokens_in = parsed.tokensIn;
  if (parsed.tokensOut !== undefined) entry.tokens_out = parsed.tokensOut;
  if (parsed.cacheRead !== undefined) entry.cache_read = parsed.cacheRead;
  if (parsed.cacheCreate !== undefined) entry.cache_create = parsed.cacheCreate;

  const result = costLogCore({
    repoRoot: process.cwd(),
    storyId: parsed.storyId!,
    entry,
    applyToSpec: parsed.applyToSpec,
  });

  console.log(`slowcook cost log: appended ${entry.usd === null ? "unpriced" : `$${entry.usd.toFixed(4)}`} (agent=${entry.agent}) to ${result.sidecarPath}`);
  if (result.appliedToSpec) {
    console.log(`slowcook cost log: applied to spec specs/story-${parsed.storyId}.yaml`);
  }
}
