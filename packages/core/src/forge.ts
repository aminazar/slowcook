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
   * 0.11.8+ — PR review comments anchored to specific file:line locations.
   * Distinct from timeline `Comment`s; used by refine's resubmit path to
   * locate the exact field being reviewed in the spec YAML.
   * Returns an empty array for issues that aren't PRs.
   */
  listPullRequestReviewComments?(number: number): Promise<ReviewComment[]>;

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
