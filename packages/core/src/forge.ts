// ForgeAdapter — abstract interface for interacting with a code-hosting forge
// (GitHub, GitLab, Gitea, Forgejo). Implementations live in separate packages
// (@slowcook-ai/forge-github, @slowcook-ai/forge-gitlab, ...). Agents and the
// CLI depend only on this interface; wiring a concrete adapter happens at
// the entry point.

export interface Issue {
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  state: "open" | "closed";
  url: string;
}

export interface Comment {
  id: number;
  author: string;
  body: string;
  created_at: string; // ISO-8601
  is_bot: boolean;
}

/** An emoji reaction on an issue comment (GitHub content values: "+1",
 *  "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"). */
export interface CommentReaction {
  user: string;
  content: string;
}

/**
 * A PR review comment anchored to a specific file + line (0.11.8+). Shape
 * is distinct from `Comment` (the issue-timeline shape) because the line
 * context is load-bearing — refine uses it to locate the exact field
 * being reviewed in the spec YAML.
 */
export interface ReviewComment {
  id: number;
  author: string;
  body: string;
  created_at: string;
  is_bot: boolean;
  path: string;
  /** New-side line number. GitHub returns null when the comment is
   * outdated (i.e., the line it referenced was rewritten after the
   * comment was posted). Treat null as "comment exists but we can't
   * locate the exact line anymore — fall back to the whole file." */
  line: number | null;
  /** The batched review this comment was submitted as part of (or null
   * for standalone inline comments). */
  pull_request_review_id: number | null;
}

export interface PullRequestInput {
  title: string;
  body: string;
  head: string; // branch name
  base: string; // target branch (e.g., "main")
  draft?: boolean;
  labels?: string[];
}

export interface PullRequest {
  number: number;
  url: string;
  head_branch: string;
}

/** Lighter read-only view of a PR for listing/inspection. */
export interface PullRequestSummary {
  number: number;
  title: string;
  state: "open" | "closed";
  merged: boolean;
  labels: string[];
  head_branch: string;
  body: string;
  url: string;
}

/**
 * Minimal git operations the agent needs. Implementations shell out to git
 * or use a library; the agent doesn't care. Working directory handling is
 * also the adapter's concern — agents just name branches and commit messages.
 */
export interface BranchOperations {
  /** Create branch off the current HEAD and check it out. */
  createBranch(name: string): Promise<void>;
  /** Commit currently-staged files with this message. */
  commit(message: string): Promise<void>;
  /** Push the current branch to the remote. */
  push(branch: string): Promise<void>;
  /** Stage a single path. */
  stage(path: string): Promise<void>;
  /**
   * 0.11.12+ — returns true when there are uncommitted staged changes.
   * Optional so existing adapters keep compiling; callers that don't
   * have it should fall through to the old try/catch-around-commit
   * behaviour. Used by the refine resubmit path to detect the "LLM
   * produced a spec identical to current state" no-op case, which
   * previously crashed on `git commit` with exit 1.
   */
  hasStagedChanges?(): Promise<boolean>;
}

/** The forge abstraction agents program against. */
export interface ForgeAdapter {
  /** Repository slug for display/logging purposes (e.g., "owner/repo"). */
  repoSlug: string;

  // Issues
  getIssue(number: number): Promise<Issue>;
  listIssueComments(number: number): Promise<Comment[]>;
  createIssueComment(number: number, body: string): Promise<Comment>;
  addIssueLabels(number: number, labels: string[]): Promise<void>;
  removeIssueLabel(number: number, label: string): Promise<void>;

  /**
   * 0.33+ — create a repository issue. Optional: refine's multifurcation
   * split executor files approved sub-issues through this; adapters that
   * can't create issues simply omit it and the executor reports the gap
   * instead of half-splitting.
   */
  createIssue?(input: {
    title: string;
    body: string;
    labels?: string[];
  }): Promise<{ number: number; url: string }>;

  /**
   * 0.33+ — emoji reactions on one issue comment. Optional. The PM's
   * cheapest possible approval gesture (a 👍 on a proposal comment) must
   * be readable by agents, or "awaiting PM decision" silently ignores the
   * decision the PM already gave (rewo run, ledger G6).
   */
  listCommentReactions?(commentId: number): Promise<CommentReaction[]>;

  /**
   * 0.11.8+ — PR review comments anchored to specific file:line locations.
   * Distinct from timeline `Comment`s; used by refine's resubmit path to
   * locate the exact field being reviewed in the spec YAML.
   * Returns an empty array for issues that aren't PRs.
   */
  listPullRequestReviewComments?(number: number): Promise<ReviewComment[]>;

  /**
   * Submitted REVIEW bodies (the summary text of an approve /
   * request-changes / comment review) — distinct from both timeline
   * comments and line-anchored review comments. A PM who reviews with
   * `gh pr review --request-changes --body ...` leaves feedback that
   * appears in NEITHER of the other two lists; the resubmit derivation
   * saw the review and fired, the gatherer found nothing, and the job
   * re-fired every worker pass forever (rewo season, 2026-08-28).
   * Returns an empty array for issues that aren't PRs.
   */
  listPullRequestReviews?(number: number): Promise<Comment[]>;

  /**
   * 0.11.10+ — reply *threaded* to a specific PR review comment, so the
   * agent's response sits under the PM's original inline comment instead
   * of posting a disconnected timeline message. Optional: adapters that
   * don't support threaded replies should simply omit this and callers
   * fall back to `createIssueComment`.
   */
  createReviewCommentReply?(
    prNumber: number,
    inReplyToCommentId: number,
    body: string
  ): Promise<ReviewComment>;

  /**
   * 0.11.11+ — fetch a single PR's state/summary. Used by the refine
   * resubmit path to detect the "PM commented /refine after the spec PR
   * was already merged" case; the amendment then goes onto a follow-up
   * branch + new PR instead of being force-pushed onto a dead branch.
   */
  getPullRequest?(number: number): Promise<PullRequestSummary>;

  // Pull requests
  createPullRequest(input: PullRequestInput): Promise<PullRequest>;

  // Git operations scoped to the local checkout
  git: BranchOperations;

  // Identity — for distinguishing agent comments from PM comments
  botUsername(): Promise<string>;

  /**
   * List branch names with a given prefix. Used by the refinement agent to
   * detect in-flight spec branches (from open PRs) before allocating a new
   * story ID, avoiding collisions when multiple refinements are in progress.
   */
  listBranchesMatching(prefix: string): Promise<string[]>;

  /**
   * List issues filtered by label. Used by `catchup` to surface refinements
   * whose webhook-trigger appears to have been missed.
   */
  listIssuesByLabel(label: string, state?: "open" | "closed" | "all"): Promise<Issue[]>;

  /**
   * Find a pull request by its head-branch name. Used by `catchup` to locate
   * the spec PR for a given story so `on-spec-merged` can be re-run.
   * Returns the most recent match (merged or open) or null if none exist.
   */
  findPullRequestByBranch(headBranch: string): Promise<PullRequestSummary | null>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reviewer identity (0.6.0) — multi-person LCR review.
//
// Distinct from `ForgeAdapter` (which an AGENT uses with a service token). This
// seam is REVIEWER-facing: when several people review a hosted LCR, each must
// authenticate as THEMSELVES so the forge attributes their comments to their own
// account. It lives in the forge layer (not the cli/overlay) because the auth
// dance is forge-specific — GitHub OAuth device flow here; GitLab/Gitea later
// implement the same seam in their own adapter packages.
//
// Why a server-side helper exists: GitHub's device-flow token-exchange endpoint
// is not CORS-accessible from a browser, so the overlay cannot complete login on
// its own. The forge adapter provides `requestDeviceCode` + `pollAccessToken`
// (run server-side, e.g. hosted next to the mock); the browser then uses the
// returned token directly against CORS-enabled read/write endpoints.
// ─────────────────────────────────────────────────────────────────────────────

/** A reviewer authenticated against the forge (their real account). */
export interface ReviewerIdentity {
  /** Forge handle, e.g. GitHub login. Authoritative — the forge stamps it. */
  login: string;
  /** Display name when the forge exposes one; falls back to `login`. */
  name: string;
  /** Avatar URL when available (overlay shows it next to the reviewer's pins). */
  avatarUrl?: string;
}

/** What the overlay shows the reviewer to start a device-flow login. */
export interface DeviceCodeGrant {
  /** Opaque code the server polls with (NOT shown to the user). */
  deviceCode: string;
  /** Short code the user types at the verification URL. */
  userCode: string;
  /** Where the user enters `userCode` (e.g. https://github.com/login/device). */
  verificationUri: string;
  /** Seconds between `pollAccessToken` attempts (forge-mandated minimum). */
  intervalSeconds: number;
  /** Seconds until `deviceCode` expires. */
  expiresInSeconds: number;
}

/** Result of polling for the access token during a device-flow login. */
export type PollResult =
  | { status: "authorized"; token: string }
  | { status: "pending" }            // user hasn't approved yet — poll again
  | { status: "slow_down"; intervalSeconds: number } // back off, then poll
  | { status: "expired" }            // deviceCode expired — restart the flow
  | { status: "denied" };            // user declined

/**
 * Reviewer-facing auth seam. A forge adapter package implements this so a hosted
 * LCR can let each reviewer sign in as themselves. The cli/overlay program
 * against this interface only — never against GitHub/GitLab specifics.
 */
export interface ForgeReviewerAuth {
  /** Begin a device-flow login. Server-side (token endpoints aren't CORS-open). */
  requestDeviceCode(): Promise<DeviceCodeGrant>;
  /** Poll once for the access token after the user has been shown the code. */
  pollAccessToken(deviceCode: string): Promise<PollResult>;
  /** Resolve a token to the reviewer's identity (CORS-OK read; browser or server). */
  identify(token: string): Promise<ReviewerIdentity>;
}
