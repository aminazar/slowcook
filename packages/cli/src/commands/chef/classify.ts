/**
 * Chef's failure classifier. Pure function: given the PR head's
 * check status + the merge base's check status, decide what kind of
 * failure this is. Chef's action depends on the class.
 *
 * Four classes (matches `docs/plans/0.13-bug-flow-and-chef.md`):
 *
 *  • self-conflict   — head doesn't fast-forward against base; needs
 *                      rebase. (Chef rebases + auto-resolves
 *                      append-only files; halts on substantive conflicts.)
 *  • self-fail       — failure is on PR head but absent from base.
 *                      Caused by the PR's own diff. Chef dispatches a
 *                      retry of the originating agent.
 *  • external-fail   — same failure exists on base. Pre-existing red
 *                      that's not the PR's responsibility. Chef posts
 *                      a diagnostic comment + escalates to operator.
 *  • infra-fail      — workflow/runner error, npm registry hiccup,
 *                      OOM. Chef re-runs the workflow once; if still
 *                      failing, escalate.
 */

export interface CheckStatus {
  /** Stable identifier for the check (workflow + job name). */
  name: string;
  /** "success" | "failure" | "cancelled" | "skipped" | "neutral" | other. */
  conclusion: string;
  /** Optional payload for infra detection (rare workflow errors). */
  message?: string;
}

export type FailureClass =
  | { kind: "self-conflict"; reason: "branch-not-up-to-date" | "merge-conflict" }
  | { kind: "self-fail"; failingChecks: string[] }
  | { kind: "external-fail"; failingChecks: string[] }
  | { kind: "infra-fail"; failingChecks: string[] }
  | { kind: "no-failure" };

export interface ClassifyInput {
  /** All checks on the PR head's most recent commit. */
  headChecks: CheckStatus[];
  /** All checks on the merge-base commit. Empty array if unavailable. */
  baseChecks: CheckStatus[];
  /** Whether GitHub reports the PR as out-of-date with main. */
  outOfDate: boolean;
}

/**
 * Classify a PR's failure mode. Pure: no I/O, no network. The caller
 * shells out to gh / git to gather inputs and to act on the verdict.
 */
export function classifyPrFailure(input: ClassifyInput): FailureClass {
  // out-of-date branch → conflict candidate. Rebase before anything
  // else; the rebase itself surfaces actual content conflicts (handled
  // by the caller, not classify).
  if (input.outOfDate) {
    return { kind: "self-conflict", reason: "branch-not-up-to-date" };
  }

  const headFailing = input.headChecks.filter((c) =>
    isFailureConclusion(c.conclusion)
  );
  if (headFailing.length === 0) {
    return { kind: "no-failure" };
  }

  // Infra errors first — they're separate from self/external because
  // re-running the same job sometimes fixes them.
  const infra = headFailing.filter(isInfraFailure);
  if (infra.length > 0 && infra.length === headFailing.length) {
    return {
      kind: "infra-fail",
      failingChecks: headFailing.map((c) => c.name),
    };
  }

  // Self vs external: a check is "external" if the same-named check
  // also fails on the merge base. If ALL failing checks are external,
  // the PR didn't introduce any of them.
  const baseFailingNames = new Set(
    input.baseChecks
      .filter((c) => isFailureConclusion(c.conclusion))
      .map((c) => c.name)
  );
  const newFailures = headFailing.filter((c) => !baseFailingNames.has(c.name));
  if (newFailures.length === 0) {
    return {
      kind: "external-fail",
      failingChecks: headFailing.map((c) => c.name),
    };
  }

  return {
    kind: "self-fail",
    failingChecks: newFailures.map((c) => c.name),
  };
}

function isFailureConclusion(c: string): boolean {
  // GitHub's check conclusions: success, failure, neutral, cancelled,
  // timed_out, action_required, skipped, stale.
  // Failure = needs chef attention.
  return c === "failure" || c === "timed_out" || c === "action_required";
}

function isInfraFailure(c: CheckStatus): boolean {
  if (c.conclusion === "timed_out") return true;
  if (!c.message) return false;
  // Heuristics — runner crashes, npm registry hiccups, network errors.
  const m = c.message.toLowerCase();
  return (
    m.includes("the runner has received a shutdown signal") ||
    m.includes("network is unreachable") ||
    m.includes("eai_again") ||
    m.includes("connect etimedout") ||
    m.includes("out of memory") ||
    m.includes("oomkill")
  );
}

/**
 * Map a failing PR (head ref starts with `slowcook/X/...`) to the
 * agent that owns retries. Used by chef when classifying as self-fail
 * to know which workflow to dispatch. Returns null when the head ref
 * doesn't match a known slowcook agent.
 */
export function originatingAgent(headRef: string): SlowcookAgent | null {
  if (headRef.startsWith("slowcook/spec/")) return "refine";
  if (headRef.startsWith("slowcook/tests/") || headRef.startsWith("slowcook/recipe/"))
    return "recipe";
  if (headRef.startsWith("slowcook/brew/")) return "brew";
  if (headRef.startsWith("slowcook/sift/")) return "sift";
  if (headRef.startsWith("slowcook/bug-profile/")) return "investigate";
  return null;
}

export type SlowcookAgent =
  | "refine"
  | "recipe"
  | "brew"
  | "sift"
  | "investigate";
