import { Octokit } from "@octokit/rest";
import type {
  ForgeAdapter,
  Issue,
  Comment,
  PullRequest,
  PullRequestInput,
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
    const botUsername = await this.botUsername();
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
      is_bot: (c.user?.type === "Bot") || c.user?.login === botUsername,
    }));
  }

  async createIssueComment(number: number, body: string): Promise<Comment> {
    const botUsername = await this.botUsername();
    const { data } = await this.octokit.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: number,
      body,
    });
    return {
      id: data.id,
      author: data.user?.login ?? botUsername,
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

  async botUsername(): Promise<string> {
    if (this.cachedBotUsername) return this.cachedBotUsername;
    const { data } = await this.octokit.users.getAuthenticated();
    this.cachedBotUsername = data.login;
    return data.login;
  }
}
