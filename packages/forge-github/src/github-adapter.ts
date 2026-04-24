import { Octokit } from "@octokit/rest";
import type {
  ForgeAdapter,
  Issue,
  Comment,
  ReviewComment,
  PullRequest,
  PullRequestInput,
  PullRequestSummary,
  BranchOperations,
} from "@slowcook-ai/core";
import { LocalGitOps } from "./git-ops.js";

export interface GitHubAdapterOptions {
  owner: string;
  repo: string;
  token: string;
  /** Optional: override the git ops (useful in tests). */
  git?: BranchOperations;
}

export class GitHubAdapter implements ForgeAdapter {
  readonly repoSlug: string;
  readonly git: BranchOperations;

  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;
  private cachedBotUsername: string | null = null;

  constructor(options: GitHubAdapterOptions) {
    this.owner = options.owner;
    this.repo = options.repo;
    this.repoSlug = `${options.owner}/${options.repo}`;
    this.octokit = new Octokit({
      auth: options.token,
      userAgent: "slowcook-ai/forge-github",
    });
    this.git = options.git ?? new LocalGitOps();
  }

  async getIssue(number: number): Promise<Issue> {
    const { data } = await this.octokit.issues.get({
      owner: this.owner,
      repo: this.repo,
      issue_number: number,
    });
    return {
      number: data.number,
      title: data.title,
      body: data.body ?? "",
      author: data.user?.login ?? "unknown",
      labels: (data.labels ?? []).map((l) =>
        typeof l === "string" ? l : l.name ?? ""
      ).filter((s): s is string => typeof s === "string" && s.length > 0),
      state: data.state === "closed" ? "closed" : "open",
      url: data.html_url,
    };
  }

  async listIssueComments(number: number): Promise<Comment[]> {
    const comments = await this.octokit.paginate(
      this.octokit.issues.listComments,
      {
        owner: this.owner,
        repo: this.repo,
        issue_number: number,
        per_page: 100,
      }
    );
    return comments.map((c) => ({
      id: c.id,
      author: c.user?.login ?? "unknown",
      body: c.body ?? "",
      created_at: c.created_at,
      // GitHub reliably marks workflow-token comments as type=Bot, same for GitHub Apps.
      // This avoids an extra /user call that GITHUB_TOKEN cannot make (403).
      is_bot: c.user?.type === "Bot",
    }));
  }

  async listPullRequestReviewComments(number: number): Promise<ReviewComment[]> {
    try {
      const comments = await this.octokit.paginate(
        this.octokit.pulls.listReviewComments,
        {
          owner: this.owner,
          repo: this.repo,
          pull_number: number,
          per_page: 100,
        }
      );
      return comments.map((c) => ({
        id: c.id,
        author: c.user?.login ?? "unknown",
        body: c.body ?? "",
        created_at: c.created_at,
        is_bot: c.user?.type === "Bot",
        path: c.path ?? "",
        line: c.line ?? null,
        pull_request_review_id: c.pull_request_review_id ?? null,
      }));
    } catch (e) {
      // Not a PR, or PR-review-comments endpoint is unavailable.
      // Return empty so the caller can treat it as "no inline feedback."
      if ((e as { status?: number }).status === 404) return [];
      throw e;
    }
  }

  async createIssueComment(number: number, body: string): Promise<Comment> {
    const { data } = await this.octokit.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: number,
      body,
    });
    return {
      id: data.id,
      author: data.user?.login ?? "slowcook-bot",
      body: data.body ?? "",
      created_at: data.created_at,
      is_bot: true,
    };
  }

  async addIssueLabels(number: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.octokit.issues.addLabels({
      owner: this.owner,
      repo: this.repo,
      issue_number: number,
      labels,
    });
  }

  async removeIssueLabel(number: number, label: string): Promise<void> {
    try {
      await this.octokit.issues.removeLabel({
        owner: this.owner,
        repo: this.repo,
        issue_number: number,
        name: label,
      });
    } catch (e) {
      // 404 is fine — label wasn't on the issue
      const status = (e as { status?: number }).status;
      if (status !== 404) throw e;
    }
  }

  async createPullRequest(input: PullRequestInput): Promise<PullRequest> {
    const { data: pr } = await this.octokit.pulls.create({
      owner: this.owner,
      repo: this.repo,
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
      draft: input.draft ?? false,
    });
    if (input.labels && input.labels.length > 0) {
      await this.octokit.issues.addLabels({
        owner: this.owner,
        repo: this.repo,
        issue_number: pr.number,
        labels: input.labels,
      });
    }
    return {
      number: pr.number,
      url: pr.html_url,
      head_branch: pr.head.ref,
    };
  }

  async listIssuesByLabel(
    label: string,
    state: "open" | "closed" | "all" = "open"
  ): Promise<Issue[]> {
    const issues = await this.octokit.paginate(
      this.octokit.issues.listForRepo,
      {
        owner: this.owner,
        repo: this.repo,
        state,
        labels: label,
        per_page: 100,
      }
    );
    return issues
      .filter((i) => !i.pull_request) // listForRepo includes PRs too — filter them out
      .map((i) => ({
        number: i.number,
        title: i.title,
        body: i.body ?? "",
        author: i.user?.login ?? "unknown",
        labels: (i.labels ?? [])
          .map((l) => (typeof l === "string" ? l : l.name ?? ""))
          .filter((s): s is string => typeof s === "string" && s.length > 0),
        state: i.state === "closed" ? "closed" : "open",
        url: i.html_url,
      }));
  }

  async findPullRequestByBranch(
    headBranch: string
  ): Promise<PullRequestSummary | null> {
    // GitHub's pulls.list `head` filter requires `owner:branch` format.
    // Try `open` first, then `closed`, to prefer a live PR if both exist.
    const headFilter = `${this.owner}:${headBranch}`;
    for (const state of ["open", "closed"] as const) {
      const { data } = await this.octokit.pulls.list({
        owner: this.owner,
        repo: this.repo,
        state,
        head: headFilter,
        per_page: 1,
      });
      if (data.length > 0) {
        const pr = data[0]!;
        return {
          number: pr.number,
          title: pr.title,
          state: pr.state === "closed" ? "closed" : "open",
          merged: Boolean(pr.merged_at),
          labels: (pr.labels ?? [])
            .map((l) => l.name ?? "")
            .filter((s) => s.length > 0),
          head_branch: pr.head.ref,
          body: pr.body ?? "",
          url: pr.html_url,
        };
      }
    }
    return null;
  }

  async listBranchesMatching(prefix: string): Promise<string[]> {
    const branches = await this.octokit.paginate(
      this.octokit.repos.listBranches,
      { owner: this.owner, repo: this.repo, per_page: 100 }
    );
    return branches
      .map((b) => b.name)
      .filter((name) => name.startsWith(prefix));
  }

  async botUsername(): Promise<string> {
    if (this.cachedBotUsername) return this.cachedBotUsername;
    // `/user` is not accessible when auth'd with a workflow's GITHUB_TOKEN
    // (installation tokens don't expose /user — 403 "Resource not accessible
    // by integration"). Return a sensible fallback so callers don't explode.
    try {
      const { data } = await this.octokit.users.getAuthenticated();
      this.cachedBotUsername = data.login;
      return data.login;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 403 || status === 401) {
        this.cachedBotUsername = "github-actions[bot]";
        return this.cachedBotUsername;
      }
      throw e;
    }
  }
}
