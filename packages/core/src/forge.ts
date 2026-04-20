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
}
