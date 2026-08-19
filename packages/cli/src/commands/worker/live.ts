/**
 * W1 live-mode pure logic — outcome mapping for spawned agents.
 *
 * The worker stays thin: it spawns the agent, captures the exit code and
 * stdout, and maps them to (outcome, result label, artifacts) here. No
 * interpretation beyond what the agent SAID — a worker that infers is a
 * worker that can lie about slowcook (plan §8).
 *
 * refine is not fire-and-forget: only `spec-emitted` (the "Draft PR:"
 * line) is terminal-success. `questions-posted`, `overlap-flagged`,
 * `contradiction-blocked`, `multifurcation-proposed` are refine PAUSING
 * for a human on the issue — exit 0, no spec yet. Labelling those
 * `agent:refined` would be a lie; the worker applies no result label and
 * lets refine's own issue conventions carry the conversation.
 */

import type { AgentKind } from "./plan.js";
import { RESULT_LABELS, FAILED_LABEL } from "./plan.js";

export interface LiveOutcome {
  outcome: "success" | "failed";
  /** Label to apply, or null when no state change is honest. */
  resultLabel: string | null;
  /** Artifact refs harvested from the agent's own output. */
  artifacts: string[];
  detail: string;
}

/** Map a finished `slowcook refine` process to worker state. */
export function mapRefineOutcome(exitCode: number, stdout: string): LiveOutcome {
  if (exitCode !== 0) {
    return {
      outcome: "failed",
      resultLabel: FAILED_LABEL,
      artifacts: [],
      detail: `refine exited ${exitCode} — terminal until a human relabels.`,
    };
  }
  const pr = stdout.match(/^Draft PR: (\S+)$/m)?.[1];
  if (pr) {
    const spec = stdout.match(/^Spec written: (\S+)$/m)?.[1];
    return {
      outcome: "success",
      resultLabel: RESULT_LABELS.refine,
      artifacts: spec ? [pr, spec] : [pr],
      detail: `spec emitted; draft PR ${pr}.`,
    };
  }
  // Exit 0 without a spec: refine posted questions / flagged overlap /
  // proposed a split — it is waiting on a human, on the issue itself.
  return {
    outcome: "success",
    resultLabel: null,
    artifacts: [],
    detail:
      "refine returned a non-terminal outcome (questions posted / overlap or " +
      "contradiction flagged / split proposed) — a human continues on the issue; " +
      "relabel agent:refine to resume after replying.",
  };
}

export function mapLiveOutcome(agent: AgentKind, exitCode: number, stdout: string): LiveOutcome {
  switch (agent) {
    case "refine":
      return mapRefineOutcome(exitCode, stdout);
    default:
      // W2+: recipe / brew / eye mappings land one stage at a time, each
      // only after the upstream handoff contract is verified (plan §6).
      return {
        outcome: "failed",
        resultLabel: FAILED_LABEL,
        artifacts: [],
        detail: `live mode for ${agent} is not enabled in this build (W1 enables refine only).`,
      };
  }
}

/** The plan-§5 attribution header every worker-authored comment opens with. */
export function commentHeader(agent: AgentKind, issue: number, runId: string): string {
  return `**slowcook-${agent}** · issue #${issue} · run ${runId}`;
}
