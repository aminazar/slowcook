import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Halt report schema per DESIGN.md §6. The first-line-of-defence documentation
 * for "what did brewing try, why did it stop, what should the human do next."
 * Written to disk + posted as a GitHub issue comment on halt.
 */
export interface HaltReport {
  story_id: string;
  halt_reason: HaltReason;
  halt_timestamp: string;
  iterations_run: number;
  checkpoints_committed: number;
  tests_green: number;
  tests_total: number;
  tokens_spent_usd: number;
  budget_usd: number;
  model: string;
  summary_plain_english: string;
  last_three_diffs?: DiffShortstat[];
  last_agent_rationale?: string;
  /** Suggested human actions. At least one MUST be present — if not, it's a halt-logic bug. */
  suggested_actions: SuggestedAction[];
}

export type HaltReason =
  | "SUCCESS_ALL_GREEN"
  | "BUDGET_EXHAUSTED"
  | "ITERATION_CAP"
  | "STAGNATION_CAP"
  | "WALL_CLOCK"
  | "TESTS_NEVER_GREEN"
  | "TEST_RUNNER_BROKEN"
  | "MANIFEST_DRIFT"
  | "VIOLATION_STREAK";

export interface DiffShortstat {
  iteration: number;
  files_changed: number;
  lines_added: number;
  lines_removed: number;
  outcome: "checkpoint" | "reverted-regression" | "reverted-no-progress" | "rejected-overflow";
}

export interface SuggestedAction {
  id: string;
  label: string;
  description: string;
  /** Optional free-text hint for an agent resuming this story later. */
  prompt_prefill?: string;
}

export function writeHaltReport(path: string, report: HaltReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n", "utf8");
}

/** Render a halt report as a markdown comment for posting on an issue. */
export function haltReportToMarkdown(report: HaltReport): string {
  const lines: string[] = [];
  lines.push(`### slowcook · brew halted — \`${report.halt_reason}\``);
  lines.push("");
  lines.push(`**Story:** \`story-${report.story_id}\``);
  lines.push(
    `**Progress:** ${report.tests_green}/${report.tests_total} tests green · ${report.checkpoints_committed} checkpoint(s) · ${report.iterations_run} iteration(s)`
  );
  lines.push(
    `**Spend:** $${report.tokens_spent_usd.toFixed(2)} of $${report.budget_usd.toFixed(2)} budget · model \`${report.model}\``
  );
  lines.push("");
  lines.push("#### What happened");
  lines.push(report.summary_plain_english);
  if (report.last_three_diffs && report.last_three_diffs.length > 0) {
    lines.push("");
    lines.push("#### Last iterations");
    for (const d of report.last_three_diffs) {
      lines.push(
        `- iter ${d.iteration}: ${d.outcome} — ${d.files_changed}f/+${d.lines_added}/-${d.lines_removed}`
      );
    }
  }
  if (report.last_agent_rationale) {
    lines.push("");
    lines.push("#### Last agent rationale");
    lines.push("> " + report.last_agent_rationale.replace(/\n/g, "\n> "));
  }
  lines.push("");
  lines.push("#### Suggested next actions");
  for (const a of report.suggested_actions) {
    lines.push(`- **${a.label}** — ${a.description}`);
  }
  lines.push("");
  lines.push(
    `_Report stored at \`.brewing/halts/story-${report.story_id}-${report.halt_timestamp.replace(/[:.]/g, "-")}.json\`_`
  );
  return lines.join("\n");
}

/**
 * Build the default suggested-actions list for a given halt reason. Invariant
 * (DESIGN.md §6.3): every halt must surface at least one concrete option. If
 * the caller passes extras, they go first; defaults come after so the caller
 * can tailor without losing fallback options.
 */
export function defaultSuggestedActions(
  reason: HaltReason,
  ctx: { budget_usd: number; iterations_run: number }
): SuggestedAction[] {
  switch (reason) {
    case "SUCCESS_ALL_GREEN":
      return [
        {
          id: "review_pr",
          label: "Review the spec PR",
          description: "All target tests green. Merge when the diff looks right.",
        },
      ];
    case "BUDGET_EXHAUSTED":
      return [
        {
          id: "increase_budget",
          label: "Increase token budget",
          description: `Current: $${ctx.budget_usd.toFixed(2)}. Consider raising to $${(ctx.budget_usd * 2).toFixed(2)} and re-running.`,
        },
        {
          id: "review_diagnostic",
          label: "Inspect what the agent tried",
          description: "The halt report lists the last three diffs. If nothing advanced, the problem is upstream of the agent.",
        },
      ];
    case "STAGNATION_CAP":
      return [
        {
          id: "narrow_target_test",
          label: "Narrow the target test",
          description: "Agent is stuck on one red test across many iterations. Consider manually writing a partial impl to unblock, or split the target test into smaller assertions.",
        },
        {
          id: "amend_spec",
          label: "Clarify the spec",
          description: "Recurring stagnation often signals ambiguity or a hidden constraint the agent can't infer. Add detail and re-run.",
        },
      ];
    case "ITERATION_CAP":
      return [
        {
          id: "increase_iterations",
          label: "Raise the iteration cap",
          description: `Ran ${ctx.iterations_run} iterations. Try more if the agent was making progress (green count climbing).`,
        },
        {
          id: "review_progress",
          label: "Look at checkpoints",
          description: "If green count was climbing monotonically, more iterations is the right fix. If it plateaued, diagnose why before running again.",
        },
      ];
    case "TESTS_NEVER_GREEN":
      return [
        {
          id: "diagnose_layer",
          label: "Diagnose test-layer mismatch",
          description: "No diff changed the green count across iterations. Likely: tests are at the wrong layer (e.g., HTTP-loopback without a running server). See `.brewing/context.md` → Testing conventions.",
        },
        {
          id: "regenerate_tests_tier1",
          label: "Regenerate tests at tier-1",
          description: "Run testgen again for this story with the tier-1 (`vi.mock`) shape so brewing can actually affect test pass/fail.",
        },
      ];
    case "TEST_RUNNER_BROKEN":
      return [
        {
          id: "fix_test_runner",
          label: "Fix the test runner before retrying",
          description: "Vitest couldn't complete. Check stack.json run_command, ensure npm ci ran, ensure vitest.config.ts loads.",
        },
      ];
    case "WALL_CLOCK":
      return [
        {
          id: "increase_wall_clock",
          label: "Raise the wall-clock budget",
          description: "Brew exceeded its time budget. If iterations were productive, give it more time; if not, halt was correct.",
        },
      ];
    case "VIOLATION_STREAK":
      return [
        {
          id: "review_agent_behaviour",
          label: "Review agent tool usage",
          description: "Agent produced multiple scope/frozen-path violations in a row. May indicate prompt drift or a model regression.",
        },
      ];
    case "MANIFEST_DRIFT":
      return [
        {
          id: "check_test_discovery",
          label: "Fix test discovery so the story's tests are actually run",
          description: "The story's manifest lists tests that vitest can't discover. Most common cause: vitest.config.ts `include` pattern doesn't cover the test files' path (e.g., only `src/**/*.test.ts` but tests live at `tests/integration/`). Expand the include pattern, or move the tests.",
        },
        {
          id: "regenerate_manifest",
          label: "Re-record the manifest",
          description: "If the test file locations are correct and vitest just re-indexed, run `slowcook manifest record --story <id>` to update the manifest to match current discovery.",
        },
      ];
  }
}
