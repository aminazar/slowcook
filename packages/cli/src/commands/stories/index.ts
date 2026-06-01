/**
 * `slowcook stories <subcommand>` — 0.19.5-α (sc#146 #6).
 *
 * Subcommands:
 *   - `status` — per-story stage table (refine / testgen / vibe / brew / chef)
 *
 * Future subcommands tracked in sc#146:
 *   - `release` — release a story-id after supersede (parked, needs design)
 *
 * Stage detection delegates to the pure helper in `./status.ts`. This
 * file is just the IO wrapper: read `specs/_index.yaml`, query the
 * forge for PRs, render.
 */

import { execSync } from "node:child_process";
import { readIndex } from "../refine/spec-yaml.js";
import { GitHubAdapter } from "@slowcook-ai/forge-github";
import {
  buildStoriesStatus,
  renderStoriesStatusTable,
  type PullRequestFact,
} from "./status.js";
import { Octokit } from "@octokit/rest";

interface StatusArgs {
  repoRoot: string;
  owner: string | undefined;
  repo: string | undefined;
  /** Render the table, exit 0. Future: --json for machine-readable. */
  format: "table" | "json";
}

export async function stories(argv: string[]): Promise<void> {
  const sub = argv[0];
  switch (sub) {
    case "status":
      return runStatus(argv.slice(1));
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      console.error(`Unknown stories subcommand: ${sub}`);
      printHelp();
      process.exit(64);
  }
}

async function runStatus(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const index = readIndex(args.repoRoot);
  const stories = index.stories ?? {};
  const storyIds = Object.keys(stories);
  if (storyIds.length === 0) {
    console.log("(no stories in specs/_index.yaml)");
    return;
  }

  // Resolve owner/repo from git remote if not passed.
  const { owner, repo } = resolveOwnerRepo(args);
  let prs: PullRequestFact[] = [];
  const token = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  if (owner && repo && token) {
    try {
      prs = await fetchAllRelevantPRs({ owner, repo, token });
    } catch (e) {
      console.error(
        `Warning: failed to fetch PRs (${(e as Error).message}). Status table will report all stages as absent.`
      );
      prs = [];
    }
  } else if (!token) {
    console.error(
      "Warning: GITHUB_TOKEN / GH_TOKEN not set. Status table will report all stages as absent.\n" +
        "  Set the env var to query the forge; story metadata still renders from specs/_index.yaml."
    );
  }

  const rows = buildStoriesStatus(index, prs);
  if (args.format === "json") {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  process.stdout.write(renderStoriesStatusTable(rows));
}

interface FetchArgs {
  owner: string;
  repo: string;
  token: string;
}

/**
 * Fetch every PR that's relevant to the slowcook pipeline for this
 * consumer. Two sources, unioned by PR number:
 *
 * 1. **Branch-prefix search** (`head:slowcook/`) — catches all slowcook-
 *    shaped branches whether or not the PR carries slowcook-* labels.
 *    This is the primary source — local-pipeline PRs (per
 *    `docs/local-pipeline-role.md`) frequently lack labels but always
 *    use the branch convention.
 * 2. **Label scan** — catches any slowcook PRs (bot or human) that
 *    DID get labelled but happen to NOT live on a slowcook/ branch
 *    (e.g. a Bijan-cumulative branch with a slowcook-spec label).
 *
 * The branch search uses GitHub's search API (single endpoint, single
 * page for most consumers). The label scan uses the issues endpoint
 * per-label (one paginated request per label).
 */
async function fetchAllRelevantPRs(args: FetchArgs): Promise<PullRequestFact[]> {
  const octokit = new Octokit({
    auth: args.token,
    userAgent: "slowcook-ai/cli",
  });
  const byNumber = new Map<number, PullRequestFact>();

  // 1. Branch-prefix search.
  try {
    const q = `is:pr repo:${args.owner}/${args.repo} head:slowcook/`;
    const found = await octokit.paginate(octokit.search.issuesAndPullRequests, {
      q,
      per_page: 100,
    });
    for (const item of found) {
      if (!item.pull_request) continue;
      const labels = (item.labels ?? [])
        .map((l) => (typeof l === "string" ? l : l.name ?? ""))
        .filter((s): s is string => typeof s === "string" && s.length > 0);
      // search API result doesn't give us head.ref or merged_at — need a
      // pulls.get to fill these in. Batch via Promise.all later if perf
      // becomes a concern.
      let headBranch = "";
      let merged = false;
      try {
        const { data: pr } = await octokit.pulls.get({
          owner: args.owner,
          repo: args.repo,
          pull_number: item.number,
        });
        headBranch = pr.head?.ref ?? "";
        merged = Boolean(pr.merged_at);
      } catch {
        // Best-effort — keep title/state from the search result.
      }
      byNumber.set(item.number, {
        number: item.number,
        title: item.title,
        labels,
        headBranch,
        state: item.state === "closed" ? "closed" : "open",
        merged,
      });
    }
  } catch (e) {
    console.error(
      `Warning: branch-prefix search failed (${(e as Error).message}). Continuing with label scan only.`
    );
  }

  // 2. Label scan — catches any slowcook PR that lacks a slowcook/
  //    branch but DID get labelled.
  const labels = [
    "slowcook-spec",
    "slowcook-tests",
    "slowcook-mockup",
    "slowcook-brew",
    "slowcook-chef",
  ];
  for (const label of labels) {
    try {
      const issues = await octokit.paginate(octokit.issues.listForRepo, {
        owner: args.owner,
        repo: args.repo,
        state: "all",
        labels: label,
        per_page: 100,
      });
      for (const issue of issues) {
        if (!issue.pull_request) continue;
        if (byNumber.has(issue.number)) {
          // Already counted — merge labels in case we missed one.
          const existing = byNumber.get(issue.number)!;
          if (!existing.labels.includes(label)) existing.labels.push(label);
          continue;
        }
        let headBranch = "";
        let merged = false;
        try {
          const { data: pr } = await octokit.pulls.get({
            owner: args.owner,
            repo: args.repo,
            pull_number: issue.number,
          });
          headBranch = pr.head?.ref ?? "";
          merged = Boolean(pr.merged_at);
        } catch {
          // Best-effort.
        }
        byNumber.set(issue.number, {
          number: issue.number,
          title: issue.title,
          labels: (issue.labels ?? [])
            .map((l) => (typeof l === "string" ? l : l.name ?? ""))
            .filter((s): s is string => typeof s === "string" && s.length > 0),
          headBranch,
          state: issue.state === "closed" ? "closed" : "open",
          merged,
        });
      }
    } catch {
      // Label may not exist on the repo (e.g. consumer never used vibe).
      // Skip silently — fine to be missing some categories.
    }
  }
  return Array.from(byNumber.values());
}

function parseArgs(argv: string[]): StatusArgs {
  const out: StatusArgs = {
    repoRoot: process.cwd(),
    owner: undefined,
    repo: undefined,
    format: "table",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--cwd" && next) { out.repoRoot = next; i++; }
    else if (a === "--owner" && next) { out.owner = next; i++; }
    else if (a === "--repo" && next) { out.repo = next; i++; }
    else if (a === "--json") { out.format = "json"; }
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return out;
}

function resolveOwnerRepo(args: StatusArgs): { owner: string | undefined; repo: string | undefined } {
  if (args.owner && args.repo) return { owner: args.owner, repo: args.repo };
  // Detect from git remote.
  try {
    const url = execSync("git remote get-url origin", {
      cwd: args.repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m =
      url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (m) {
      return { owner: args.owner ?? m[1], repo: args.repo ?? m[2] };
    }
  } catch {
    // not a git repo, or no origin — fine
  }
  return { owner: args.owner, repo: args.repo };
}

// Silence the unused-import warning when stories status doesn't need
// the adapter directly. Keep the import handy for future subcommands
// (e.g. `stories close --pr N` could use addIssueLabels).
void GitHubAdapter;

function printHelp(): void {
  console.log(`
slowcook stories — per-story status across the slowcook pipeline (0.19.5-α)

Usage:
  slowcook stories status [--cwd <path>] [--owner <login>] [--repo <name>] [--json]

Subcommands:
  status   Render a table of story id × pipeline stage (refine / testgen
           / vibe / brew / chef). Reads specs/_index.yaml + queries the
           forge for PRs labelled with the slowcook-* stage labels.

           Cell semantics:
             ✓ — merged PR exists for this stage
             → — open PR exists for this stage
             ✗ — PR was opened but closed unmerged
             — — no PR found for this stage

           With --json, emits the same data as machine-readable JSON.

Environment:
  GITHUB_TOKEN | GH_TOKEN  Required to query the forge. Without it,
                           the table renders from specs/_index.yaml
                           only and reports all stages as absent.

Refs: aminazar/slowcook#146 finding 6.
`);
}
