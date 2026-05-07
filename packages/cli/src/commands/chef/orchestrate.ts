/**
 * `slowcook chef-orchestrate` — α.10 L3 cross-pipeline orchestrator.
 *
 * Sibling to chef-drift. Where chef-drift edits source files, chef-
 * orchestrate decides what to do with a HALTED PR: re-dispatch brew,
 * rebase against main, escalate to PM, or close. Reads the chef-drift
 * ledger (so it knows what's already been tried) plus PR state, spec,
 * navigator history, open PRs.
 *
 * Hard execution today (cli α.10 L3 α.0):
 *   - escalate → posts comment + applies label (real)
 *   - close    → posts comment + closes PR (real)
 *   - rebase   → writes verdict to disk; auto-resolution lands in α.10.X
 *   - redispatch_brew → writes verdict to disk; auto-dispatch lands in α.10.X
 *
 * Run from consumer repo root:
 *   ANTHROPIC_API_KEY=... GITHUB_TOKEN=... slowcook chef-orchestrate \
 *     --pr 153 \
 *     --story 018
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AnthropicClient,
  CHEF_ORCHESTRATE_SYSTEM,
  buildChefOrchestratePrompt,
  type ChefOrchestrateAction,
  type ChefOrchestrateCloseAction,
  type ChefOrchestrateEscalateAction,
  type ChefOrchestrateRebaseAction,
  type ChefOrchestrateRedispatchAction,
  type ChefOrchestrateVerdict,
} from "@slowcook-ai/llm-anthropic";

interface Args {
  storyId: string;
  prNumber: number;
  repoRoot: string;
  model: string;
  budgetUsd: number;
  dryRun: boolean;
  recentRunnerOutputPath: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    storyId: "",
    prNumber: 0,
    repoRoot: process.cwd(),
    model: "claude-sonnet-4-5-20250929",
    budgetUsd: 0.5,
    dryRun: false,
    recentRunnerOutputPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--story" && next) { args.storyId = next; i++; }
    else if (a === "--pr" && next) { args.prNumber = parseInt(next, 10); i++; }
    else if (a === "--cwd" && next) { args.repoRoot = next; i++; }
    else if (a === "--model" && next) { args.model = next; i++; }
    else if (a === "--budget-usd" && next) { args.budgetUsd = parseFloat(next); i++; }
    else if (a === "--dry-run") { args.dryRun = true; }
    else if (a === "--runner-output" && next) { args.recentRunnerOutputPath = next; i++; }
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  if (!args.storyId) { console.error("--story <id> is required"); printHelp(); process.exit(64); }
  if (!args.prNumber) { console.error("--pr <number> is required"); printHelp(); process.exit(64); }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook chef-orchestrate — pipeline orchestrator (cli α.10 L3)

Sibling to chef-drift. Where chef-drift edits source files surgically,
chef-orchestrate decides what to do with a HALTED brew PR:
  redispatch_brew | rebase | escalate | close

Usage:
  slowcook chef-orchestrate --pr <n> --story <id> [options]

Options:
  --pr <n>                 PR number (required).
  --story <id>             Story id (required, e.g. "018").
  --cwd <path>             Repo root (default: cwd).
  --model <id>             Anthropic model id.
  --budget-usd <n>         Per-decision budget cap (default: 0.50).
  --runner-output <path>   Optional path to brew runner output (re-context).
  --dry-run                Print verdict; do not act.

Environment:
  ANTHROPIC_API_KEY (required) — for the LLM call.
  GITHUB_TOKEN (required for escalate/close) — comment + label + close.

Reads (.brewing/chef/story-<id>.json) for chef-drift's prior moves.
Writes the verdict to (.brewing/chef-orchestrate/story-<id>.json) so a
follow-up step (or workflow) can act on redispatch/rebase decisions.
`);
}

interface PrSnapshot {
  headRef: string;
  baseRef: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergeStateStatus: string;
  title: string;
  failingChecks?: string[];
}

interface OpenPrsEntry {
  kind: "spec" | "mockup" | "tests" | "brew";
  number: number;
  branch: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  title: string;
}

function repoSlug(repoRoot: string): string {
  return execSync(
    `git -C "${repoRoot}" remote get-url origin | sed -E 's|^.*github\\.com[:/]||; s|\\.git$||'`,
    { encoding: "utf8" },
  ).trim();
}

function fetchPrSnapshot(repoRoot: string, prNumber: number): PrSnapshot {
  const slug = repoSlug(repoRoot);
  const json = execSync(
    `gh pr view ${prNumber} --repo "${slug}" --json headRefName,baseRefName,state,mergeStateStatus,title,statusCheckRollup`,
    { encoding: "utf8", maxBuffer: 1024 * 256 },
  );
  const obj = JSON.parse(json) as {
    headRefName: string;
    baseRefName: string;
    state: string;
    mergeStateStatus: string;
    title: string;
    statusCheckRollup: Array<{ name?: string; conclusion?: string }>;
  };
  const failingChecks = (obj.statusCheckRollup ?? [])
    .filter((c) => (c.conclusion ?? "").toLowerCase() === "failure")
    .map((c) => c.name ?? "")
    .filter(Boolean);
  return {
    headRef: obj.headRefName,
    baseRef: obj.baseRefName,
    state: obj.state as "OPEN" | "CLOSED" | "MERGED",
    mergeStateStatus: obj.mergeStateStatus,
    title: obj.title,
    failingChecks,
  };
}

function loadChefDriftLedger(repoRoot: string, storyId: string): {
  story_id: string;
  moves: Array<{
    n: number;
    trigger_kind: string;
    decision: string;
    post_state: "clean" | "still-broken" | "escalated";
    validation_result: "passed" | "failed" | "not-run" | null;
    timestamp: string;
  }>;
  cumulative_cost_usd: number;
} {
  const path = join(repoRoot, `.brewing/chef/story-${storyId}.json`);
  if (!existsSync(path)) {
    return { story_id: storyId, moves: [], cumulative_cost_usd: 0 };
  }
  try {
    const obj = JSON.parse(readFileSync(path, "utf8")) as {
      story_id?: string;
      moves?: Array<{
        n: number;
        trigger_kind: string;
        decision: string;
        post_state: "clean" | "still-broken" | "escalated";
        validation_result: "passed" | "failed" | "not-run" | null;
        timestamp: string;
      }>;
      cumulative_cost_usd?: number;
    };
    return {
      story_id: obj.story_id ?? storyId,
      moves: obj.moves ?? [],
      cumulative_cost_usd: obj.cumulative_cost_usd ?? 0,
    };
  } catch {
    return { story_id: storyId, moves: [], cumulative_cost_usd: 0 };
  }
}

function loadOpenPrs(repoRoot: string, storyId: string): OpenPrsEntry[] {
  const out: OpenPrsEntry[] = [];
  try {
    const slug = repoSlug(repoRoot);
    const json = execSync(
      `gh pr list --repo "${slug}" --search "story-${storyId}" --state all --json number,headRefName,headRefOid,title,state --limit 20`,
      { encoding: "utf8" },
    );
    const prs = JSON.parse(json) as Array<{ number: number; headRefName: string; title: string; state: string }>;
    for (const pr of prs) {
      const branch = pr.headRefName;
      let kind: "spec" | "mockup" | "tests" | "brew";
      if (branch.includes("/spec/")) kind = "spec";
      else if (branch.includes("/mockup/")) kind = "mockup";
      else if (branch.includes("/tests/") || branch.includes("/recipe/")) kind = "tests";
      else if (branch.includes("/brew/")) kind = "brew";
      else continue;
      out.push({
        kind,
        number: pr.number,
        branch,
        state: pr.state as "OPEN" | "CLOSED" | "MERGED",
        title: pr.title,
      });
    }
  } catch (e) {
    console.warn(`  warn: could not list open PRs (${(e as Error).message.slice(0, 100)})`);
  }
  return out;
}

function loadSpec(repoRoot: string, storyId: string): { path: string; yaml: string } {
  const path = `specs/story-${storyId}.yaml`;
  const abs = join(repoRoot, path);
  if (!existsSync(abs)) return { path, yaml: "" };
  return { path, yaml: readFileSync(abs, "utf8") };
}

/**
 * Validate a verdict's action shape against its kind. Pure: throws on
 * mismatch so the orchestrator can early-fail before posting comments
 * or applying labels.
 */
export function validateVerdictShape(verdict: ChefOrchestrateVerdict): void {
  if (!verdict.kind || !verdict.rationale || !verdict.action) {
    throw new Error("verdict missing kind / rationale / action");
  }
  const a = verdict.action as unknown as Record<string, unknown>;
  switch (verdict.kind) {
    case "redispatch_brew":
      if (typeof a["brew_workflow"] !== "string" || typeof a["additional_context"] !== "string") {
        throw new Error("redispatch_brew action must include brew_workflow + additional_context strings");
      }
      break;
    case "rebase":
      if (typeof a["onto"] !== "string" || !Array.isArray(a["expected_conflict_paths"])) {
        throw new Error("rebase action must include onto:string + expected_conflict_paths:string[]");
      }
      break;
    case "escalate":
      if (typeof a["issue_number"] !== "number" || typeof a["label"] !== "string" || typeof a["comment"] !== "string") {
        throw new Error("escalate action must include issue_number:number + label:string + comment:string");
      }
      break;
    case "close":
      if (typeof a["reason"] !== "string" || typeof a["comment"] !== "string") {
        throw new Error("close action must include reason:string + comment:string");
      }
      break;
    default:
      throw new Error(`unknown verdict kind: ${(verdict as { kind: string }).kind}`);
  }
}

/**
 * Save verdict + dispatch-payload to disk so a follow-up workflow step
 * can pick up redispatch / rebase decisions. Idempotent (overwrites).
 */
export function persistVerdict(
  repoRoot: string,
  storyId: string,
  prNumber: number,
  verdict: ChefOrchestrateVerdict,
): string {
  const path = join(repoRoot, `.brewing/chef-orchestrate/story-${storyId}.json`);
  mkdirSync(dirname(path), { recursive: true });
  const payload = {
    story_id: storyId,
    pr_number: prNumber,
    verdict,
    timestamp: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
  return path;
}

/**
 * 0.19.0-α.12 — append a slowcook:cost HTML marker to a chef-orchestrate
 * comment body. Pure: takes the LLM-emitted body + cost data, returns
 * the body with the marker appended. Format matches refine / brew /
 * plate / vibe so `gh issue view N | grep slowcook:cost` aggregates
 * spend across the whole pipeline including chef-orchestrate.
 */
function withCostMarker(body: string, kind: string, costUsd: number, cliVersion: string, prNumber: number): string {
  return (
    body.replace(/\n+$/, "") +
    `\n\n<!-- slowcook:cost agent=chef-orchestrate usd=${costUsd.toFixed(4)} kind=${kind} pr=${prNumber} cli=${cliVersion} -->\n`
  );
}

function applyEscalate(
  repoRoot: string,
  prNumber: number,
  action: ChefOrchestrateEscalateAction,
  costUsd: number,
  cliVersion: string,
): { posted: boolean; labeled: boolean } {
  const slug = repoSlug(repoRoot);
  let posted = false;
  let labeled = false;
  // Comment on the source ISSUE (escalation goes to the PM, not the bot PR).
  const tmp = "/tmp/chef-orchestrate-escalate-comment.md";
  writeFileSync(tmp, withCostMarker(action.comment, "escalate", costUsd, cliVersion, prNumber), "utf8");
  try {
    execSync(
      `gh issue comment ${action.issue_number} --repo "${slug}" --body-file ${tmp}`,
      { stdio: "inherit" },
    );
    posted = true;
  } catch (e) {
    console.warn(`  warn: failed to post escalation comment: ${(e as Error).message.slice(0, 200)}`);
  }
  // Apply label to the PR (so future filters surface escalated PRs).
  try {
    execSync(
      `gh pr edit ${prNumber} --repo "${slug}" --add-label "${action.label}"`,
      { stdio: "inherit" },
    );
    labeled = true;
  } catch (e) {
    console.warn(`  warn: failed to apply label '${action.label}' to PR #${prNumber}: ${(e as Error).message.slice(0, 200)}`);
  }
  return { posted, labeled };
}

function applyClose(
  repoRoot: string,
  prNumber: number,
  action: ChefOrchestrateCloseAction,
  costUsd: number,
  cliVersion: string,
): { commented: boolean; closed: boolean } {
  const slug = repoSlug(repoRoot);
  let commented = false;
  let closed = false;
  const tmp = "/tmp/chef-orchestrate-close-comment.md";
  writeFileSync(tmp, withCostMarker(action.comment, "close", costUsd, cliVersion, prNumber), "utf8");
  try {
    execSync(
      `gh pr comment ${prNumber} --repo "${slug}" --body-file ${tmp}`,
      { stdio: "inherit" },
    );
    commented = true;
  } catch (e) {
    console.warn(`  warn: failed to post close comment: ${(e as Error).message.slice(0, 200)}`);
  }
  try {
    execSync(
      `gh pr close ${prNumber} --repo "${slug}"`,
      { stdio: "inherit" },
    );
    closed = true;
  } catch (e) {
    console.warn(`  warn: failed to close PR #${prNumber}: ${(e as Error).message.slice(0, 200)}`);
  }
  return { commented, closed };
}

export async function chefOrchestrate(argv: string[], cliVersion: string): Promise<void> {
  const args = parseArgs(argv);

  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) { console.error("ANTHROPIC_API_KEY env var is required."); process.exit(2); }

  console.log(`slowcook chef-orchestrate · story-${args.storyId} · PR #${args.prNumber}`);

  // Gather inputs.
  const prState = fetchPrSnapshot(args.repoRoot, args.prNumber);
  const ledger = loadChefDriftLedger(args.repoRoot, args.storyId);
  const openPrs = loadOpenPrs(args.repoRoot, args.storyId);
  const spec = loadSpec(args.repoRoot, args.storyId);

  let runnerOutput: string | undefined = undefined;
  if (args.recentRunnerOutputPath && existsSync(args.recentRunnerOutputPath)) {
    runnerOutput = readFileSync(args.recentRunnerOutputPath, "utf8");
  }

  console.log(`  PR state: ${prState.state} · merge=${prState.mergeStateStatus} · failing=${prState.failingChecks?.length ?? 0}`);
  console.log(`  ledger: ${ledger.moves.length} prior chef-drift move(s) · cum-cost $${ledger.cumulative_cost_usd.toFixed(4)}`);
  console.log(`  openPrs: ${openPrs.length} (spec=${openPrs.filter(p => p.kind === "spec").length}, mockup=${openPrs.filter(p => p.kind === "mockup").length}, tests=${openPrs.filter(p => p.kind === "tests").length}, brew=${openPrs.filter(p => p.kind === "brew").length})`);

  const prompt = buildChefOrchestratePrompt({
    storyId: args.storyId,
    prNumber: args.prNumber,
    prState,
    chefDriftLedger: ledger,
    navigatorHistory: null, // hooked up in α.10 L3 α.1
    spec,
    storyOpenPrs: openPrs,
    recentRunnerOutput: runnerOutput,
  });

  console.log(`  prompt: ${prompt.length} chars · calling chef-orchestrate LLM (${args.model})`);
  const client = new AnthropicClient(apiKey);
  const resp = await client.complete({
    model: args.model,
    system: CHEF_ORCHESTRATE_SYSTEM,
    messages: [{ role: "user", content: prompt }],
    maxTokens: 4096,
  });
  console.log(`  chef-orchestrate LLM: ${resp.usage.inputTokens}→${resp.usage.outputTokens} tok · $${resp.costUsd.toFixed(4)}`);

  if (resp.costUsd > args.budgetUsd) {
    console.warn(`  warn: cost $${resp.costUsd.toFixed(4)} exceeded budget $${args.budgetUsd}. Continuing (decision is in-hand).`);
  }

  let verdict: ChefOrchestrateVerdict;
  try {
    const text = resp.text.trim();
    const fence = text.match(/```json\s*([\s\S]*?)```/);
    verdict = JSON.parse(fence ? fence[1]! : text) as ChefOrchestrateVerdict;
    validateVerdictShape(verdict);
  } catch (e) {
    console.error(`  ! verdict parse/shape error: ${(e as Error).message}`);
    console.error(`  raw: ${resp.text.slice(0, 600)}`);
    process.exit(1);
  }

  console.log(`\n  VERDICT: ${verdict.kind.toUpperCase()}`);
  console.log(`  rationale: ${verdict.rationale}`);

  // Always persist the verdict — workflows / follow-up steps consume it.
  if (!args.dryRun) {
    const path = persistVerdict(args.repoRoot, args.storyId, args.prNumber, verdict);
    console.log(`  wrote: ${path.replace(args.repoRoot + "/", "")}`);
  } else {
    console.log(`  [dry-run] would persist verdict to .brewing/chef-orchestrate/story-${args.storyId}.json`);
  }

  // Execute the verdict.
  if (args.dryRun) {
    console.log(`  [dry-run] would execute: ${verdict.kind}`);
    return;
  }

  switch (verdict.kind) {
    case "escalate": {
      const action = verdict.action as ChefOrchestrateEscalateAction;
      console.log(`  → escalate: post comment on issue #${action.issue_number} + apply label '${action.label}' to PR #${args.prNumber}`);
      const r = applyEscalate(args.repoRoot, args.prNumber, action, resp.costUsd, cliVersion);
      console.log(`     posted=${r.posted} labeled=${r.labeled}`);
      break;
    }
    case "close": {
      const action = verdict.action as ChefOrchestrateCloseAction;
      console.log(`  → close PR #${args.prNumber}: ${action.reason}`);
      const r = applyClose(args.repoRoot, args.prNumber, action, resp.costUsd, cliVersion);
      console.log(`     commented=${r.commented} closed=${r.closed}`);
      break;
    }
    case "redispatch_brew": {
      const action = verdict.action as ChefOrchestrateRedispatchAction;
      console.log(`  → redispatch_brew (deferred): would dispatch ${action.brew_workflow} with additional_context (${action.additional_context.length} chars)`);
      console.log(`     verdict persisted; α.10 L3 α.0 does not auto-dispatch — workflow consumer picks up the verdict file`);
      break;
    }
    case "rebase": {
      const action = verdict.action as ChefOrchestrateRebaseAction;
      console.log(`  → rebase (deferred): would rebase ${prState.headRef} onto ${action.onto}`);
      console.log(`     expected conflicts: ${action.expected_conflict_paths.join(", ") || "(none)"}`);
      console.log(`     verdict persisted; α.10 L3 α.0 does not auto-rebase — workflow consumer picks up the verdict file`);
      break;
    }
  }

  console.log(`\n  done · cost $${resp.costUsd.toFixed(4)}`);
}
