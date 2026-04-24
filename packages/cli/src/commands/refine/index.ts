import { execSync } from "node:child_process";
import { GitHubAdapter } from "@slowcook-ai/forge-github";
import { AnthropicClient } from "./llm.js";
import {
  runRefinement,
  runResubmitRefinement,
  type RefineContext,
  type ResubmitContext,
} from "./agent.js";

interface RefineArgs {
  /** Issue-driven refine (the original 0.5+ path). Required unless --pr is set. */
  issueNumber: number;
  /**
   * 0.11.5+ — PR-driven resubmit. When set, refine loads the spec on the
   * PR's branch + the new PR comments, amends the spec, force-pushes.
   * Mutually exclusive with --issue.
   */
  prNumber: number;
  /**
   * 0.11.10+ — when the refine was triggered by a `pull_request_review_comment`
   * event, the workflow passes the triggering comment id so the agent can
   * post its response as a threaded reply to that exact inline comment
   * instead of a disconnected timeline message. Optional; falls back to
   * timeline comment when absent (e.g., `issue_comment` on PR trigger).
   */
  reviewCommentId: number;
  repoRoot: string;
  owner?: string;
  repo?: string;
  baseBranch: string;
  refineModel: string;
  relationshipModel: string;
}

function parseArgs(argv: string[]): RefineArgs {
  const args: RefineArgs = {
    issueNumber: 0,
    prNumber: 0,
    reviewCommentId: 0,
    repoRoot: process.cwd(),
    baseBranch: "main",
    refineModel: "claude-opus-4-7",
    relationshipModel: "claude-sonnet-4-5",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--issue" && next) {
      args.issueNumber = parseInt(next, 10);
      i++;
    } else if (arg === "--pr" && next) {
      args.prNumber = parseInt(next, 10);
      i++;
    } else if (arg === "--review-comment-id" && next) {
      args.reviewCommentId = parseInt(next, 10);
      i++;
    } else if (arg === "--cwd" && next) {
      args.repoRoot = next;
      i++;
    } else if (arg === "--owner" && next) {
      args.owner = next;
      i++;
    } else if (arg === "--repo" && next) {
      args.repo = next;
      i++;
    } else if (arg === "--base" && next) {
      args.baseBranch = next;
      i++;
    } else if (arg === "--refine-model" && next) {
      args.refineModel = next;
      i++;
    } else if (arg === "--relationship-model" && next) {
      args.relationshipModel = next;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  // Exactly one of --issue / --pr required
  const hasIssue = !!args.issueNumber && !isNaN(args.issueNumber);
  const hasPr = !!args.prNumber && !isNaN(args.prNumber);
  if (hasIssue === hasPr) {
    console.error(
      "Missing or ambiguous target: pass exactly one of --issue <number> OR --pr <number>."
    );
    printHelp();
    process.exit(64);
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook refine — drive a GitHub issue toward a frozen spec

Each invocation is one round:
  - Analyzes the issue's relationship to existing active specs.
  - If overlap or contradiction (without 'change-of-mind' label): posts a
    comment explaining how to proceed and exits.
  - If no blocker: either asks clarifying questions (as a comment) or emits
    the final spec + opens a draft PR.

Re-run on every new PM comment (typically via a GitHub Actions workflow
triggered by issue_comment events).

Usage:
  slowcook refine --issue <number> [options]     # original issue-driven refine
  slowcook refine --pr <number> [options]        # 0.11.5+ PR-driven resubmit

Options:
  --issue <number>             Issue to refine (exclusive with --pr)
  --pr <number>                PR to resubmit (0.11.5+). Reads PM comments
                               on the PR, amends the spec on the same branch,
                               force-pushes, posts summary comment. Exclusive
                               with --issue.
  --cwd <path>                 Repo working directory (default: current dir)
  --owner <login>              Repo owner (default: parsed from 'git remote get-url origin')
  --repo <name>                Repo name (default: parsed from 'git remote get-url origin')
  --base <branch>              Base branch for the spec PR (default: main)
  --refine-model <id>          Model for the refinement loop (default: claude-opus-4-7)
  --relationship-model <id>    Model for relationship analysis (default: claude-sonnet-4-5)
  --help, -h                   Show this help

Environment:
  ANTHROPIC_API_KEY  (required)  Anthropic API key
  GITHUB_TOKEN       (required)  GitHub token with issues:write, contents:write, pull-requests:write

Exit codes:
  0  outcome was reached (questions posted, spec emitted, or noop)
  2  script error (bad args, missing env, network failure)
`);
}

function detectOwnerRepo(cwd: string): { owner: string; repo: string } | null {
  try {
    const url = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (m && m[1] && m[2]) return { owner: m[1], repo: m[2] };
  } catch {
    // not a git repo / no origin — fine
  }
  return null;
}

export async function refine(argv: string[], cliVersion: string): Promise<void> {
  const args = parseArgs(argv);

  const anthropicKey = process.env["ANTHROPIC_API_KEY"];
  if (!anthropicKey) {
    console.error("ANTHROPIC_API_KEY environment variable is not set.");
    process.exit(2);
  }
  const githubToken = process.env["GITHUB_TOKEN"];
  if (!githubToken) {
    console.error("GITHUB_TOKEN environment variable is not set.");
    process.exit(2);
  }

  let owner = args.owner;
  let repo = args.repo;
  if (!owner || !repo) {
    const detected = detectOwnerRepo(args.repoRoot);
    if (!detected) {
      console.error(
        "Could not detect owner/repo from git remote. Pass --owner and --repo explicitly."
      );
      process.exit(2);
    }
    owner = owner ?? detected.owner;
    repo = repo ?? detected.repo;
  }

  const forge = new GitHubAdapter({ owner, repo, token: githubToken });
  const llm = new AnthropicClient(anthropicKey);

  try {
    if (args.prNumber) {
      // 0.11.5+ — PR-driven resubmit path
      const ctx: ResubmitContext = {
        prNumber: args.prNumber,
        reviewCommentId: args.reviewCommentId || null,
        repoRoot: args.repoRoot,
        forge,
        llm,
        refineModel: args.refineModel,
        cliVersion,
        baseBranch: args.baseBranch,
        now: new Date(),
      };
      console.log(
        `slowcook refine · resubmit on PR #${args.prNumber} on ${owner}/${repo} (refine model: ${args.refineModel})`
      );
      const outcome = await runResubmitRefinement(ctx);
      switch (outcome.kind) {
        case "resubmitted":
          console.log(`Spec amended: ${outcome.specPath}`);
          console.log(`Pushed to branch ${outcome.branch}.`);
          break;
        case "noop":
          console.log(`Noop: ${outcome.reason}.`);
          break;
      }
      return;
    }

    const ctx: RefineContext = {
      issueNumber: args.issueNumber,
      repoRoot: args.repoRoot,
      forge,
      llm,
      refineModel: args.refineModel,
      relationshipModel: args.relationshipModel,
      cliVersion,
      baseBranch: args.baseBranch,
      now: new Date(),
    };

    console.log(
      `slowcook refine · issue #${args.issueNumber} on ${owner}/${repo} (refine model: ${args.refineModel})`
    );

    const outcome = await runRefinement(ctx);
    switch (outcome.kind) {
      case "questions-posted":
        console.log(`Posted clarifying questions (comment ${outcome.commentId}). Awaiting PM reply.`);
        break;
      case "spec-emitted":
        console.log(`Spec written: ${outcome.specPath}`);
        console.log(`Draft PR: ${outcome.prUrl}`);
        break;
      case "overlap-flagged":
        console.log(
          `Overlap with ${outcome.conflicting_ids.join(", ")}. Awaiting PM resolution.`
        );
        break;
      case "contradiction-blocked":
        console.log(
          `Contradiction with ${outcome.conflicting_ids.join(", ")}. Blocked until 'change-of-mind' label applied.`
        );
        break;
      case "change-of-mind-accepted":
        console.log(
          `Change-of-mind accepted; will supersede ${outcome.supersedes.join(", ")}.`
        );
        break;
      case "noop":
        console.log(`Noop: ${outcome.reason}.`);
        break;
    }
  } catch (e) {
    console.error(`Refinement failed: ${(e as Error).message}`);
    if (process.env["SLOWCOOK_DEBUG"]) {
      console.error(e);
    }
    process.exit(2);
  }
}
