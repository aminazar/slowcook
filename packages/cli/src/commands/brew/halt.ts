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
  /**
   * α.51 — brew mode in effect when the halt fired. Populated by
   * brew/agent.ts from BrewContext.allowedPaths + the dispatched
   * --mode flag. Chef reads this to know whether
   * "rejected-overflow" iteration outcomes are due to `--mode plate`
   * (hardcoded restrictive paths) vs `--mode freehand` (no
   * restriction — would be a code bug if scope-rejected) vs explicit
   * `allowed_paths` config. Without this, chef hallucinates that
   * `allowed_paths` is a spec yaml field (it is not) and gives PM
   * advice that has no effect (delgoosh#656 dogfood 2026-05-25).
   */
  brew_mode?: "auto" | "plate" | "freehand";
  /** The `allowedPaths` array brew enforced. Empty array = no restriction. */
  allowed_paths?: string[];
  /**
   * α.57 — name of the branch brew committed checkpoints onto + pushed.
   * Without this, downstream chef-on-brew-halt can't tell which branch
   * holds the in-progress src/ files; chef checks out main (the
   * default-branch checkout that chef's workflow performs), then can't
   * find the files the failing tests import, then HALLUCINATES contents.
   * Caught 2026-05-26 dogfood: delgoosh#003 chef-drift logged
   * "brew-halt enriched: 2 failing test file(s), 0 source file(s)" —
   * source-file resolver couldn't see files that only exist on the
   * brew branch.
   */
  brew_branch?: string;
  /** Full per-iteration diffs. Carries every iteration brewing ran, not just the last few,
   * so post-hoc diagnosis of a stuck loop doesn't lose iters 1..N-3. */
  iteration_diffs?: IterationDiff[];
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
  /**
   * dovizir handover §10 — a missing manifest used to report
   * TEST_RUNNER_BROKEN and suggest "fix vitest config", flatly contradicting
   * its own summary ("No manifest found. Run testgen first"). Nothing is
   * broken; a prerequisite step never ran.
   */
  | "MANIFEST_MISSING"
  | "MANIFEST_DRIFT"
  | "TESTS_BROKEN"
  /**
   * P5 (ladder) — greening the current target repeatedly breaks the same
   * already-green test. That is not an agent failure: the SPEC disagrees
   * with itself, and a machine cannot resolve a contradiction between two
   * requirements. The founder can. Terminal states are DONE or a named
   * human decision — never a silent grind.
   */
  | "SPEC_CONTRADICTION"
  | "VIOLATION_STREAK"
  | "API_ERROR"
  // 0.7.14 additions: early-halt to preserve budget when agent is stuck.
  | "AGENT_STALLED_NO_EDITS"
  | "AGENT_SELF_REPORTED_STUCK"
  // 0.11.16+: per-iter scoped runs miss transitive regressions in
  // tests outside the story manifest. Full-suite gate at brew
  // completion catches them before opening the PR.
  | "TRANSITIVE_REGRESSION"
  // 0.15.0-α.4 (plate-mode brew): a test cannot be satisfied without
  // editing files plate's mockup committed to main. Brew halts so PM
  // can choose: amend the mockup via /plate, amend the spec via
  // /refine, or accept the conflict + override-merge.
  | "MOCKUP_DESIGN_CONFLICT"
  // 0.16.0-α.30: a test asserts a specific accessible name / text /
  // role that the ported UI almost-but-not-quite matches. Both are
  // internally consistent — vibe + recipe interpreted spec ambiguity
  // differently. PM picks one in spec.ui_behavior + /refine.
  | "SPEC_AMBIGUITY_DETECTED";

export interface IterationDiff {
  iteration: number;
  target_test_id: string;
  files_changed: number;
  files_touched: string[];
  lines_added: number;
  lines_removed: number;
  outcome:
    | "checkpoint"
    | "reverted-regression"
    | "reverted-no-progress"
    | "rejected-overflow"
    | "rejected-frozen-path"
    | "test-runner-broken";
  note: string;
  /** For `reverted-regression` outcomes: the previously-green tests this iter broke.
   * Load-bearing for diagnosing assertion contradictions across stories. */
  broken_tests?: string[];
  spend_delta_usd?: number;
  rationale?: string;
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
  if (report.iteration_diffs && report.iteration_diffs.length > 0) {
    lines.push("");
    lines.push("#### Iterations");
    // For long halts, show first 5 + last 5 with a gap marker; for short halts, show everything.
    // The full array is still in the JSON — the markdown is just for humans skimming the comment.
    const diffs = report.iteration_diffs;
    const toRender: Array<IterationDiff | "gap"> =
      diffs.length <= 15
        ? diffs
        : [...diffs.slice(0, 5), "gap" as const, ...diffs.slice(-5)];
    for (const entry of toRender) {
      if (entry === "gap") {
        lines.push(`- _… ${diffs.length - 10} iteration(s) elided; full list in the halt JSON_`);
        continue;
      }
      const d = entry;
      let line = `- iter ${d.iteration}: \`${d.outcome}\` — ${d.files_changed}f/+${d.lines_added}/-${d.lines_removed}`;
      if (d.outcome === "reverted-regression" && d.broken_tests && d.broken_tests.length > 0) {
        const shown = d.broken_tests.slice(0, 3).map((t) => `\`${t}\``).join(", ");
        const more = d.broken_tests.length > 3 ? ` (+${d.broken_tests.length - 3} more)` : "";
        line += ` — broke: ${shown}${more}`;
      } else if (d.note && d.outcome !== "checkpoint") {
        line += ` — ${d.note}`;
      }
      lines.push(line);
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
  // Hidden cost marker for the pipeline-total aggregator on
  // on-brew-merged. Hidden because we don't want to duplicate the spend
  // number the human-facing Spend: line already shows, but the aggregator
  // wants structured access.
  lines.push("");
  lines.push(
    `<!-- slowcook:cost agent=brew usd=${report.tokens_spent_usd.toFixed(4)}` +
      ` iterations=${report.iterations_run} checkpoints=${report.checkpoints_committed}` +
      ` model=${report.model} halted=${report.halt_reason} -->`
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
    case "MANIFEST_MISSING":
      return [
        {
          id: "generate_tests",
          label: "Generate the story's tests first",
          description: "brew reads `.brewing/manifests/story-<id>.json` to know which tests it is turning green. Run `slowcook testgen --spec <id>` (or write the tests and `slowcook manifest record --story <id>`), then re-dispatch brew.",
        },
      ];
    case "TEST_RUNNER_BROKEN":
      return [
        {
          id: "fix_test_runner",
          label: "Fix the test runner before retrying",
          // Runner-neutral (dovizir §10): a Foundry project got told to check
          // its vitest config. The configured runner is in stack.json.
          description: "The configured test runner couldn't complete. Check stack.json `run_command` and `discover_command`, that dependencies are installed, and that the runner's config loads. (For a TS project that means vitest.config.ts; for Foundry, foundry.toml.)",
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
    case "SPEC_CONTRADICTION":
      return [
        {
          id: "resolve_contradiction",
          label: "Decide which requirement wins",
          description: "Two tests demand incompatible behavior — satisfying the target keeps breaking a green test. A backprop claim was filed naming the pair. Amend the spec (supersede one side), then re-run brew.",
        },
      ];
    case "TESTS_BROKEN":
      return [
        {
          id: "fix_tests_artifact",
          label: "Fix the tests artifact — the suite cannot initialize",
          description:
            "The story's failures are SETUP crashes (missing export / unresolvable module), not assertions — no implementation change can green them. Fix via `slowcook recipe --pr <tests-pr>` (or a tests-fix PR); the crash message in the summary names the missing surface. Re-run brew only once the tests execute (red is fine; crashing is not).",
        },
      ];
    case "MANIFEST_DRIFT":
      return [
        {
          id: "check_test_discovery",
          label: "Fix test discovery so the story's tests are actually run",
          description: "The story's manifest lists tests the test runner can't see. Most common cause: the runner's include pattern doesn't cover the test files' path (vitest: `vitest.config.ts` `include` only matching `src/**/*.test.ts` while tests live at `tests/integration/`; forge: `foundry.toml` `test` dir not covering the files). Expand the pattern, or move the tests.",
        },
        {
          id: "regenerate_manifest",
          label: "Re-record the manifest",
          description: "If the test file locations are correct and vitest just re-indexed, run `slowcook manifest record --story <id>` to update the manifest to match current discovery.",
        },
      ];
    case "API_ERROR":
      return [
        {
          id: "inspect_api_error",
          label: "Read the error in the halt report",
          description: "The LLM API (or another external call the agent depends on) failed with an unexpected error. The full error is in `summary_plain_english`. Common causes: Anthropic credit balance exhausted, rate limit, transient network failure, invalid model id.",
        },
        {
          id: "retry_after_fix",
          label: "Retry once the underlying cause is resolved",
          description: "If the error was environmental (credit, rate limit), fix it and re-trigger brew. The run was aborted cleanly — no state on disk to clean up besides the (empty) brew branch.",
        },
      ];
    case "AGENT_STALLED_NO_EDITS":
      return [
        {
          id: "inspect_last_rationale",
          label: "Read the agent's last rationale in the halt report",
          description: "Agent went silent — produced no tool-use edits for 2+ consecutive iterations despite burning context tokens. Often signals the model decided it's stuck but didn't surface it. The halt report's `last_agent_rationale` + the iteration_diffs show what the agent was reasoning about.",
        },
        {
          id: "hand_patch_or_different_target",
          label: "Hand-patch the blocker or choose a different target test",
          description: "If the agent's rationale hints at a specific mismatch (e.g., 'test expects X but component renders Y'), hand-patch that difference + re-run. Otherwise split the target test into smaller assertions so progress is more incremental.",
        },
      ];
    case "AGENT_SELF_REPORTED_STUCK":
      return [
        {
          id: "read_self_reported_reason",
          label: "Read the agent's self-reported stuck reason",
          description: "Agent voluntarily halted via the 'Considering halting voluntarily' escape hatch. Its rationale describes a specific mismatch it couldn't resolve — that's your diagnostic starting point.",
        },
        {
          id: "clarify_spec_or_hand_patch",
          label: "Clarify the spec + add context, or hand-patch",
          description: "If the agent's described mismatch is a genuine spec ambiguity, add detail and re-run. If it's a concrete bug the agent can't see (test assertion vs component output), hand-patch and let brew continue on the remaining red.",
        },
      ];
    case "TRANSITIVE_REGRESSION":
      return [
        {
          id: "read_first_broken_test",
          label: "Read the first broken test in the halt summary",
          description: "Brew turned all the story's tests green but the full-suite gate caught regression(s) in tests OUTSIDE the manifest. The agent touched code that other stories' tests cover. Identify which file caused the breakage from the broken test name.",
        },
        {
          id: "hand_patch_or_widen_manifest",
          label: "Hand-patch the regression OR widen this brew's manifest",
          description: "Two options: (a) keep brew's existing checkpoints, hand-fix the broken external test, push, retrigger brew on the now-clean baseline. (b) include the broken tests in this story's manifest so the next brew sees them as in-scope.",
        },
      ];
    case "MOCKUP_DESIGN_CONFLICT":
      return [
        {
          id: "amend_mockup_via_plate",
          label: "Amend the mockup via /plate on the original mockup PR",
          description: "If brew's failure says the test wants behavior the current mockup doesn't show (a missing button, different layout), the mockup needs to change. Comment `/plate <prose>` on the slowcook-mockup PR for this story; plate amends; merge; brew re-runs cleanly.",
        },
        {
          id: "amend_spec_via_refine",
          label: "Amend the spec via /refine on the spec PR",
          description: "If the test asserts an invariant the mockup-as-shipped genuinely can't satisfy (e.g., \"no duplicate rendering\" but the mockup has duplicates by design), the spec is too strict OR the mockup is wrong. Comment `/refine <prose>` on the spec PR to adjust the invariant; recipe regenerates tests; brew re-runs.",
        },
        {
          id: "manual_override_merge",
          label: "Manually edit the brew PR + override-merge",
          description: "Last resort: if you've decided the conflict is acceptable (the test is wrong AND the spec is right AND the mockup is right), edit the brew PR by hand to fix the test or skip it, then merge with admin override. Document the decision in the PR comments so future agents don't re-hit the same wall.",
        },
      ];
    case "SPEC_AMBIGUITY_DETECTED":
      return [
        {
          id: "amend_spec_ui_behavior",
          label: "Pick one phrasing in spec.ui_behavior + /refine",
          description: "The mock + the test interpreted the spec's ui_behavior block differently (e.g., test queries 'Pinned'; mock renders 'Saved'). Both readings are defensible. Pick one in the spec, comment /refine on the spec PR, and the next vibe + recipe pair will agree.",
        },
        {
          id: "manual_override_merge",
          label: "Manually edit the brew PR + override-merge",
          description: "If the agent's diagnosis surfaces the exact one-word/role mismatch and you'd rather hand-patch than re-run the pipeline, edit the brew PR + admin-merge. Document the chosen phrasing in the PR so future stories don't re-hit it.",
        },
      ];
  }
}
