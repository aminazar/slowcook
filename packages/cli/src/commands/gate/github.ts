/**
 * design #9 — map GitHub PR reviews to the Approval shape `isGateSatisfied`
 * grades. Pure + unit-tested; the live `gh api` fetch lives in ./index.ts.
 *
 * The identity classification is the load-bearing bit: a review authored by a
 * Bot account (GitHub `user.type === "Bot"`, or a login ending in `[bot]`, or a
 * known slowcook bot handle) is marked `identityType: "bot"` so it can never
 * satisfy a human-review gate — the automation cannot self-approve.
 */
import type { Approval } from "./model.js";

/** Subset of the GitHub PR-review payload we consume. */
export interface GhReview {
  user?: { login?: string; type?: string } | null;
  state?: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
}

/** Logins always treated as bots regardless of the GitHub `type` field. */
export const BOT_LOGINS: ReadonlyArray<string> = ["github-actions"];

function isBot(login: string, type: string | undefined): boolean {
  if (type === "Bot") return true;
  if (login.endsWith("[bot]")) return true;
  if (BOT_LOGINS.includes(login)) return true;
  return false;
}

function mapState(state: string | undefined): Approval["state"] | null {
  switch (state) {
    case "APPROVED":
      return "approved";
    case "CHANGES_REQUESTED":
      return "rejected";
    case "COMMENTED":
      return "commented";
    default:
      return null; // DISMISSED / PENDING / unknown → not a signal
  }
}

/**
 * Convert raw PR reviews into Approvals. Dismissed/pending reviews are dropped.
 * Only the latest review per author is kept (GitHub returns reviews
 * chronologically; a later review supersedes an earlier one from the same user).
 */
export function mapReviewsToApprovals(reviews: GhReview[]): Approval[] {
  const latestByAuthor = new Map<string, Approval>();
  for (const r of reviews) {
    const login = (r.user?.login ?? "").toLowerCase();
    if (!login) continue;
    const state = mapState(r.state);
    if (!state) continue;
    latestByAuthor.set(login, {
      byHandle: login,
      state,
      identityType: isBot(login, r.user?.type ?? undefined) ? "bot" : "human",
    });
  }
  return [...latestByAuthor.values()];
}
