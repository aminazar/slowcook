/**
 * PM halt roll-up (eleven-defects D6): every state that waits on the PM,
 * reconciled into ONE issue per pass — "slowcook: waiting on the PM".
 *
 * Derived, never event-driven (the worker's rule: labels and issues only
 * publish state; the workload is re-derived from what exists):
 *   - issues labeled slowcook-awaiting-pm (refine's clarifying questions)
 *   - issues labeled agent:failed (terminal until a human relabels)
 *   - open agent PRs at the review-round cap (agents argued to the limit;
 *     the PM arbitrates)
 *
 * Notification contract: the issue BODY is silently edited to the current
 * checklist (edits don't notify), and NEW items get one comment with the
 * PM mention — one phone buzz per item, not per pass. All-clear closes
 * the issue; the next halt reopens it (same thread, full history).
 */

import type { IssueFact, AgentPrFact } from "./plan.js";
import { MAX_REVIEW_ROUNDS, FAILED_LABEL } from "./plan.js";

export const ROLLUP_TITLE = "slowcook: waiting on the PM";
export const ROLLUP_MARKER = "<!-- slowcook-pm-rollup -->";
export const AWAITING_PM_LABEL = "slowcook-awaiting-pm";

export interface RollupItem {
  /** Stable identity across passes — mention fires only when it first appears. */
  key: string;
  text: string;
}

export function buildRollupItems(input: {
  awaitingPm: Array<{ number: number; title: string }>;
  issues: IssueFact[];
  prs: AgentPrFact[];
}): RollupItem[] {
  const items: RollupItem[] = [];
  for (const i of input.awaitingPm) {
    items.push({
      key: `awaiting-pm:${i.number}`,
      text: `#${i.number} ${i.title} — refine asked clarifying questions; answer on the issue`,
    });
  }
  for (const i of input.issues) {
    if (i.labels.includes(FAILED_LABEL)) {
      items.push({
        key: `failed:${i.number}`,
        text: `#${i.number} ${i.title} — agent:failed; decide: relabel to retry, or close`,
      });
    }
  }
  for (const pr of input.prs) {
    if (pr.submittedReviewCount >= MAX_REVIEW_ROUNDS) {
      items.push({
        key: `round-cap:${pr.prNumber}`,
        text: `PR #${pr.prNumber} (${pr.headBranch}) — review rounds hit the cap (${pr.submittedReviewCount}/${MAX_REVIEW_ROUNDS}); agents stopped arguing, the call is yours`,
      });
    }
  }
  return items;
}

export function renderRollupBody(items: RollupItem[]): string {
  const lines = [
    ROLLUP_MARKER,
    "",
    "The worker reconciles this list every pass — each unchecked item is a",
    "pipeline halt only a human can clear. Items disappear when the state",
    "clears; the issue closes when nothing waits.",
    "",
  ];
  for (const it of items) lines.push(`- [ ] ${it.text} <!-- key:${it.key} -->`);
  if (items.length === 0) lines.push("_Nothing is waiting on the PM._");
  return lines.join("\n");
}

/** Keys present in a previously rendered body — the "already buzzed" set. */
export function parseRollupKeys(body: string): Set<string> {
  const keys = new Set<string>();
  for (const m of body.matchAll(/<!-- key:([^\s]+) -->/g)) keys.add(m[1]!);
  return keys;
}
