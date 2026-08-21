/**
 * Stale-premise triage (eleven-defects D9): feedback that lands on a
 * MERGED agent PR is invisible to the resubmit derivations (they watch
 * open PRs only) — historically it either rotted unanswered or, worse,
 * got acted on literally against a superseded artifact (PR #129's
 * review sat for weeks; a ruling relayed onto merged #218 spawned the
 * G14 fossil-branch amendment).
 *
 * The worker now triages: a human comment newer than the merge, with no
 * agent reply after it, gets ONE deterministic supersession note that
 * names the current artifact and routes the discussion to the live
 * venue (source issue / open successor PR). No LLM — this is routing,
 * not judgment.
 */

export const STALE_PREMISE_MARKER = "<!-- slowcook-stale-premise -->";

export interface MergedPrComment {
  isBot: boolean;
  createdAt: string;
}

/** A merged PR needs a triage reply iff the newest comment is a HUMAN
 *  comment posted after the merge and no bot comment follows it. */
export function needsTriageReply(
  mergedAt: string | null,
  comments: MergedPrComment[]
): boolean {
  if (!mergedAt) return false;
  const last = comments[comments.length - 1];
  if (!last || last.isBot) return false;
  return Date.parse(last.createdAt) > Date.parse(mergedAt);
}

export function renderTriageReply(ctx: {
  kind: string;
  storyId: string;
  sourceIssue: number | null;
  successorPr: number | null;
}): string {
  const venue =
    ctx.successorPr !== null
      ? `the open successor PR #${ctx.successorPr}`
      : ctx.sourceIssue !== null
        ? `the source issue #${ctx.sourceIssue}`
        : `a fresh issue`;
  return (
    `${STALE_PREMISE_MARKER}\n` +
    `This PR is **merged** — its ${ctx.kind} may have been amended since, so feedback here can rest on a superseded premise and no agent watches this thread.\n\n` +
    `- Current artifact: ${ctx.kind === "tests" ? `\`tests/integration/story-${ctx.storyId}*\` + \`.brewing/manifests/story-${ctx.storyId}.json\`` : `\`specs/story-${ctx.storyId}.yaml\``} on the base branch.\n` +
    `- To get this acted on, comment on ${venue} — the worker derives work from there.\n\n` +
    `_Automated routing note (stale-premise triage); no judgment was made on the feedback's content._`
  );
}
