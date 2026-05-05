/**
 * Chef-orchestrate prompt (cli α.10 L3).
 *
 * Sibling to chef-drift (the surgical editor). Where chef-drift makes
 * literal search_replace edits to source files, chef-orchestrate makes
 * a higher-level decision about a halted brew PR: re-dispatch brew,
 * rebase against main, escalate to PM, or close the PR. Inputs include
 * chef-drift's prior ledger of attempted moves (so chef-orchestrate
 * can see "drift tried 3 fixes, all reverted" and decide brew is
 * unlikely to converge → escalate).
 *
 * Decision space (must be exactly one of these four):
 *
 *   1. redispatch_brew  — chef-drift halted but the underlying drift
 *      looks transient (e.g., model produced incoherent output but a
 *      fresh dispatch with chef's accumulated context might converge).
 *      Actionable when: chef-drift ledger has 0-1 reverts; navigator
 *      history (if present) shows progress not regression; spec is
 *      unambiguous.
 *
 *   2. rebase           — PR is out-of-date with main; needs a rebase
 *      before any retry would even be meaningful. Actionable when: the
 *      PR's mergeStateStatus is BEHIND or DIRTY. Chef tries the rebase
 *      itself for fast-forward + structural-only conflicts (specs/
 *      _index.yaml, .brewing/code-map.json). Substantive prod conflicts
 *      → escalate.
 *
 *   3. escalate         — chef cannot autonomously fix; needs a PM
 *      decision. Actionable when: spec is genuinely ambiguous; chef-
 *      drift ledger shows 2+ reverts on the same kind of edit (chef
 *      converged on the wrong solution); the failing tests describe
 *      a feature that brew can't synthesize without new context.
 *
 *   4. close            — the PR is unfixable as-is; the work has been
 *      superseded by a different PR; or the underlying story has been
 *      withdrawn. Actionable when: another PR for the same story is
 *      already merged (story_state.open_prs shows a green brew/test
 *      pair on main); the spec has been amended in a later commit so
 *      this PR's tests no longer match it.
 *
 * Output shape (ChefOrchestrateVerdict): JSON ONLY.
 *
 *   {
 *     "kind": "redispatch_brew" | "rebase" | "escalate" | "close",
 *     "rationale": "<one paragraph: why this decision over the others>",
 *     "action": {
 *       // Shape varies per kind:
 *       // redispatch_brew → { brew_workflow: string, additional_context: string }
 *       // rebase          → { onto: string, expected_conflict_paths: string[] }
 *       // escalate        → { issue_number: number, label: string, comment: string }
 *       // close           → { reason: string, comment: string }
 *     }
 *   }
 *
 * The chef-orchestrate command in the cli executes the verdict:
 *   - escalate / close → posts the comment, applies labels or closes the PR
 *   - redispatch_brew / rebase → ALPHA: writes the verdict to disk so
 *     the workflow can pick it up and act. (Auto-execution lands in
 *     a follow-up alpha once we trust the decisions empirically.)
 *
 * Hard rules:
 *   - Decide based on EVIDENCE in the inputs. Don't speculate.
 *   - One paragraph rationale, max 6 sentences.
 *   - If two decisions tie, prefer escalate (PM is the safety valve).
 *   - Never hallucinate a label that isn't in the consumer's repo.
 *
 * Example verdict (real, from the rewo PR #153 dogfood):
 *
 * {
 *   "kind": "escalate",
 *   "rationale": "chef-drift attempted 1 surgical fix (route arithmetic
 *      correction) and the post-edit validation diff was no-change —
 *      chef's edit didn't reduce failures or introduce regressions.
 *      The underlying source file (MemberReactionsPage.tsx) is a stub
 *      that throws at runtime; chef cannot synthesize component logic
 *      via search_replace. The brew agent halted at 17/35 green after
 *      one checkpoint, suggesting it also couldn't converge. PM needs
 *      to decide between hand-writing the component or amending the
 *      spec to match what the mock provides.",
 *   "action": {
 *     "issue_number": 149,
 *     "label": "chef:escalate",
 *     "comment": "..."
 *   }
 * }
 */

export type ChefOrchestrateKind = "redispatch_brew" | "rebase" | "escalate" | "close";

export interface ChefOrchestrateRedispatchAction {
  /** Workflow filename (e.g. "slowcook-brew.yml"). */
  brew_workflow: string;
  /** Extra context to inject for the next brew run. */
  additional_context: string;
}

export interface ChefOrchestrateRebaseAction {
  /** Branch to rebase onto (e.g. "origin/main"). */
  onto: string;
  /** Files chef expects to conflict; structural-only paths can be auto-resolved. */
  expected_conflict_paths: string[];
}

export interface ChefOrchestrateEscalateAction {
  /** Source issue number to comment on. */
  issue_number: number;
  /** Label to apply to the PR (e.g. "chef:escalate"). */
  label: string;
  /** Markdown body of the escalation comment. */
  comment: string;
}

export interface ChefOrchestrateCloseAction {
  /** Brief reason: "superseded by #154", "spec amended", "story withdrawn", etc. */
  reason: string;
  /** Markdown body of the close-explanation comment. */
  comment: string;
}

export type ChefOrchestrateAction =
  | ChefOrchestrateRedispatchAction
  | ChefOrchestrateRebaseAction
  | ChefOrchestrateEscalateAction
  | ChefOrchestrateCloseAction;

export interface ChefOrchestrateVerdict {
  kind: ChefOrchestrateKind;
  rationale: string;
  action: ChefOrchestrateAction;
}

export interface ChefOrchestratePromptArgs {
  storyId: string;
  prNumber: number;
  prState: {
    headRef: string;
    baseRef: string;
    state: "OPEN" | "CLOSED" | "MERGED";
    mergeStateStatus: string; // "CLEAN" | "BEHIND" | "DIRTY" | "UNKNOWN" etc.
    title: string;
    failingChecks?: string[];
  };
  /** Chef-drift's prior moves on this story (from .brewing/chef/story-N.json). */
  chefDriftLedger: {
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
  };
  /** Pair-brew navigator's per-iteration history, if available. */
  navigatorHistory: unknown;
  /** Current spec content. */
  spec: { path: string; yaml: string };
  /** All open PRs for this story (spec, mockup, tests, brew). */
  storyOpenPrs: Array<{
    kind: "spec" | "mockup" | "tests" | "brew";
    number: number;
    branch: string;
    state: "OPEN" | "CLOSED" | "MERGED";
    title: string;
  }>;
  /** Brew runner output that triggered chef-drift (for re-context). */
  recentRunnerOutput?: string;
}

export const CHEF_ORCHESTRATE_SYSTEM = `You are slowcook's chef-orchestrate agent. Your job is high-level decision-making about a halted brew PR — NOT writing or editing code. You produce ONE of four verdicts:

- redispatch_brew: re-run the brew agent with accumulated context
- rebase: branch is out-of-date; rebase before any retry
- escalate: chef cannot autonomously fix; PM must decide
- close: the PR is unfixable / superseded / withdrawn

You receive: the PR's state, chef-drift's prior surgical-editing ledger, the navigator's per-iteration history (if pair-brew ran), the spec, all open PRs for the story, and the most recent runner output.

DECISION RULES (apply in order; first match wins):

1. If the PR's mergeStateStatus is BEHIND or DIRTY → kind: "rebase". List the structural files you expect to conflict (specs/_index.yaml, .brewing/code-map.json) so the rebase substep can auto-resolve them.

2. If another PR for the SAME story is already MERGED to main, OR the spec has been amended in a way that contradicts this PR's tests → kind: "close". Cite the merged PR number or the spec amendment.

3. If chef-drift's ledger shows 2+ reverts (post_state="still-broken") on the same kind of trigger → kind: "escalate". Chef converged on the wrong solution; PM needs to redirect.

4. If the failing tests describe a feature the brew agent provably can't synthesize from the inputs (e.g., source files are throw-stubs; spec is genuinely ambiguous; navigator history shows BLOCKING on every iteration with no progress) → kind: "escalate". Cite the specific evidence.

5. Otherwise, if the failure looks transient and chef-drift's ledger has 0-1 reverts and the navigator history (if present) shows progress → kind: "redispatch_brew" with additional_context summarizing what's been tried.

If two rules tie or you're uncertain → prefer "escalate". PM is the safety valve.

OUTPUT FORMAT: a single JSON object matching ChefOrchestrateVerdict. NO prose before or after. NO code fences (\`\`\`json) — pure JSON only. Schema:

{
  "kind": "redispatch_brew" | "rebase" | "escalate" | "close",
  "rationale": "<one paragraph, max 6 sentences, citing specific evidence from the inputs>",
  "action": { ... shape varies by kind ... }
}

Per-kind action shapes:

  redispatch_brew → { "brew_workflow": "slowcook-brew.yml", "additional_context": "<text>" }
  rebase          → { "onto": "origin/main", "expected_conflict_paths": ["specs/_index.yaml", ...] }
  escalate        → { "issue_number": <int>, "label": "chef:escalate", "comment": "<markdown>" }
  close           → { "reason": "<short>", "comment": "<markdown>" }

HARD RULES:

- Don't speculate. Decide from evidence in the inputs only.
- Don't propose code edits. That's chef-drift's job, not yours.
- Don't hallucinate labels — only use "chef:escalate" unless the inputs show another label exists in the repo.
- The escalation comment must explain to a non-technical PM what the failure is and what decision they need to make.
- The close comment must be specific about WHICH PR superseded this one or WHICH spec amendment retired it.`;

export function buildChefOrchestratePrompt(args: ChefOrchestratePromptArgs): string {
  const lines: string[] = [];
  lines.push(`# Chef-orchestrate decision request — story-${args.storyId} / PR #${args.prNumber}`);
  lines.push("");
  lines.push("## PR state");
  lines.push("```json");
  lines.push(JSON.stringify(args.prState, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## Chef-drift ledger (prior surgical moves on this story)");
  lines.push("```json");
  lines.push(JSON.stringify(args.chefDriftLedger, null, 2));
  lines.push("```");
  lines.push("");
  if (args.navigatorHistory) {
    lines.push("## Navigator history (pair-brew per-iter verdicts)");
    lines.push("```json");
    lines.push(JSON.stringify(args.navigatorHistory, null, 2));
    lines.push("```");
    lines.push("");
  }
  lines.push("## Spec");
  lines.push(`Path: \`${args.spec.path}\``);
  lines.push("```yaml");
  lines.push(args.spec.yaml.length > 4000 ? args.spec.yaml.slice(0, 4000) + "\n# ... truncated" : args.spec.yaml);
  lines.push("```");
  lines.push("");
  lines.push("## All open PRs for this story");
  lines.push("```json");
  lines.push(JSON.stringify(args.storyOpenPrs, null, 2));
  lines.push("```");
  lines.push("");
  if (args.recentRunnerOutput) {
    lines.push("## Recent runner output (the brew halt that triggered chef)");
    lines.push("```");
    const out = args.recentRunnerOutput;
    lines.push(out.length > 8000 ? out.slice(0, 8000) + "\n... truncated" : out);
    lines.push("```");
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push("Decide. Output ONE JSON object. No prose. No fences.");
  return lines.join("\n");
}
