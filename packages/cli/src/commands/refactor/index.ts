/**
 * `slowcook refactor` — α.7 (#64).
 *
 * Reads candidate refactor proposals from
 *   .brewing/refactor/proposals.json
 * Filters by --scope patterns, ranks by benefit/cost, prints a table.
 *
 * α.7 ships ranking + reporting only. LLM-backed proposal generation
 * + auto-application land in later alphas. This command's job today
 * is to give the architecture room: any proposer (hand-authored
 * JSON, recon emissions, future LLM agent) drops files into the
 * standard input path + this command consumes them.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { filterProposalsByScope, rankProposals } from "./score.js";
import type { RefactorProposal } from "./types.js";

interface Args {
  repoRoot: string;
  proposalsPath: string;
  scope: string[];
  json: boolean;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    repoRoot: process.cwd(),
    proposalsPath: ".brewing/refactor/proposals.json",
    scope: [],
    json: false,
    limit: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--cwd" && next) { args.repoRoot = next; i++; }
    else if (a === "--proposals" && next) { args.proposalsPath = next; i++; }
    else if (a === "--scope" && next) { args.scope.push(next); i++; }
    else if (a === "--json") { args.json = true; }
    else if (a === "--limit" && next) { args.limit = parseInt(next, 10); i++; }
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook refactor — rank refactor proposals by benefit/cost (cli α.7)

Reads .brewing/refactor/proposals.json (an array of RefactorProposal),
filters by --scope, ranks by benefit-per-cost (descending), prints
a table or JSON.

Usage:
  slowcook refactor [options]

Options:
  --cwd <path>          Repo root (default: cwd).
  --proposals <path>    Proposals JSON path (default: .brewing/refactor/proposals.json).
  --scope <pattern>     Repeatable. Glob-ish patterns; proposal must
                        have ALL filesAffected match at least one. Examples:
                          --scope src/**
                          --scope src/components/*
                          --scope src/lib/
  --limit <n>           Show top N. Default 0 = all.
  --json                Emit JSON (default: human-readable table).

Proposal shape (RefactorProposal):
  { id, title, rationale, filesAffected[], estimatedLocDelta,
    estimatedValueScore, evidence? }

Cost = |estimatedLocDelta| × filesAffected.length, clamped ≥1.
Benefit = estimatedValueScore (caller-supplied 0-10).
Ranking key = benefit / cost.
`);
}

export async function refactor(argv: string[], _cliVersion: string): Promise<void> {
  const args = parseArgs(argv);
  const abs = join(args.repoRoot, args.proposalsPath);
  if (!existsSync(abs)) {
    console.error(`No proposals file at ${args.proposalsPath} (cwd=${args.repoRoot}).`);
    console.error(`Drop a JSON array of RefactorProposal there. See \`slowcook refactor --help\`.`);
    process.exit(2);
  }
  let proposals: RefactorProposal[];
  try {
    const raw = readFileSync(abs, "utf8");
    proposals = JSON.parse(raw) as RefactorProposal[];
    if (!Array.isArray(proposals)) throw new Error("proposals JSON must be an array");
  } catch (e) {
    console.error(`Could not parse ${args.proposalsPath}: ${(e as Error).message}`);
    process.exit(2);
  }

  const filtered = filterProposalsByScope(proposals, args.scope);
  const ranked = rankProposals(filtered);
  const out = args.limit > 0 ? ranked.slice(0, args.limit) : ranked;

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log(`slowcook refactor · ${proposals.length} proposal(s) · ${filtered.length} after scope filter`);
  if (args.scope.length > 0) {
    console.log(`  scope: ${args.scope.join(", ")}`);
  }
  console.log();
  if (out.length === 0) {
    console.log("(no proposals to rank)");
    return;
  }
  for (const r of out) {
    const a = r.assessment;
    console.log(
      `  ${r.proposal.id}  benefit/cost=${a.benefitPerCost.toFixed(3)}  benefit=${a.benefitScore}  cost=${a.costScore}  files=${r.proposal.filesAffected.length}`
    );
    console.log(`    ${r.proposal.title}`);
  }
}
