/**
 * `slowcook chef --pr <num>` — pipeline orchestrator.
 *
 * Watches a single slowcook-bot PR. Classifies its failure (or
 * non-failure) and acts on the verdict:
 *
 *   self-conflict   → rebase against main (fast-forward / structural-only)
 *   self-fail       → workflow_dispatch the originating agent's retry workflow
 *   external-fail   → post a diagnostic comment, add `chef:escalate` label
 *   infra-fail      → re-run the workflow once; escalate if still failing
 *   no-failure      → no-op
 *
 * Loop protection: chef counts its own prior comments on the PR.
 * After 3, refuses to act regardless of class — escalates instead.
 *
 * **Status: alpha.5c**. Dispatch logic implemented; the rebase
 * substep + auto-resolve of structural conflicts (specs/_index.yaml
 * etc.) is alpha.5c.1. For now self-conflict prints the rebase
 * command + escalates rather than running it.
 */

import { execSync } from "node:child_process";
import { GitHubAdapter } from "@slowcook-ai/forge-github";
import {
  classifyPrFailure,
  originatingAgent,
  type CheckStatus,
  type FailureClass,
} from "./classify.js";

interface ChefArgs {
  prNumber: number;
  repoRoot: string;
  owner?: string;
  repo?: string;
  /** Skip mutating actions; print classification + would-do plan. */
  dryRun: boolean;
  /** Hard cap on prior chef comments before escalating. */
  retryCap: number;
}

function parseArgs(argv: string[]): ChefArgs {
  const args: ChefArgs = {
    prNumber: 0,
    repoRoot: process.cwd(),
    dryRun: false,
    retryCap: 3,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--pr" && next) {
      args.prNumber = parseInt(next, 10);
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
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--retry-cap" && next) {
      args.retryCap = parseInt(next, 10);
      i++;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook chef — pipeline orchestrator (PR-failure handler)

Watches a single slowcook-bot PR and acts on the verdict:
  self-conflict   → rebase
  self-fail       → dispatch retry to originating agent's workflow
  external-fail   → diagnostic comment + chef:escalate label
  infra-fail      → re-run workflow once; escalate if still failing
  no-failure      → no-op

Usage:
  slowcook chef --pr <number> [options]

Options:
  --pr <n>          PR number to process (required).
  --cwd <path>      Repo root (default: cwd).
  --owner <login>   Override git-remote auto-detect.
  --repo <name>     Override git-remote auto-detect.
  --dry-run         Print classification + plan; don't act.
  --retry-cap <n>   Max prior chef-bot comments before escalating
                    instead of acting (default: 3).

Environment:
  GITHUB_TOKEN  (required) — write access for comments + dispatches.
`);
}

export async function chef(argv: string[], cliVersion: string): Promise<void> {
  const args = parseArgs(argv);
  if (!args.prNumber) {
    console.error("slowcook chef: --pr <number> is required");
    printHelp();
    process.exit(64);
  }
  const githubToken = process.env["GITHUB_TOKEN"];
  if (!githubToken) {
    console.error("slowcook chef: GITHUB_TOKEN is required");
    process.exit(78);
  }

  const detected = detectOwnerRepo(args.repoRoot);
  const owner = args.owner ?? detected?.owner;
  const repo = args.repo ?? detected?.repo;
  if (!owner || !repo) {
    console.error("slowcook chef: could not detect owner/repo from git remote");
    process.exit(2);
  }

  const forge = new GitHubAdapter({ owner, repo, token: githubToken });

  // Fetch PR metadata via gh (cheaper than the full forge adapter
  // path; the few fields chef needs aren't all on PullRequestSummary).
  const prMeta = await fetchPrMeta(args.repoRoot, args.prNumber);
  if (!prMeta) {
    console.error(`slowcook chef: PR #${args.prNumber} not found`);
    process.exit(2);
  }

  // Only act on slowcook-bot PRs (head ref starts with `slowcook/`).
  // External PRs (human-authored) aren't our problem.
  if (!prMeta.headRef.startsWith("slowcook/")) {
    console.error(
      `slowcook chef: PR #${args.prNumber} head ref '${prMeta.headRef}' isn't a slowcook-bot branch — skipping.`
    );
    process.exit(0);
  }

  // Loop protection — count chef-bot's own prior comments.
  const priorChefComments = await countChefComments(args.repoRoot, args.prNumber);
  if (priorChefComments >= args.retryCap) {
    console.error(
      `slowcook chef: retry cap reached (${priorChefComments} prior chef comments ≥ ${args.retryCap}). Escalating.`
    );
    if (!args.dryRun) {
      await postEscalation(forge, args.prNumber, cliVersion, priorChefComments);
    }
    process.exit(0);
  }

  // Gather classification inputs.
  const headChecks = await fetchChecks(args.repoRoot, args.prNumber, "head");
  const baseChecks = await fetchChecks(args.repoRoot, args.prNumber, "base");

  const verdict = classifyPrFailure({
    headChecks,
    baseChecks,
    outOfDate: prMeta.outOfDate,
  });
  console.error(
    `chef · PR #${args.prNumber} (${prMeta.headRef}) → ${describeVerdict(verdict)}`
  );

  if (args.dryRun) {
    console.error("(dry-run: not acting)");
    process.exit(0);
  }

  // Act on the verdict.
  switch (verdict.kind) {
    case "no-failure":
      console.error("Nothing to do.");
      return;
    case "self-conflict":
      // alpha.5c: print the rebase suggestion + escalate.
      // Auto-rebase + structural-conflict resolver lands in alpha.5c.1.
      await postEscalation(
        forge,
        args.prNumber,
        cliVersion,
        priorChefComments,
        `Branch is out of date with main (rebase needed). Auto-rebase isn't enabled in this chef build (alpha.5c) — rebase manually:\n\n\`\`\`\ngit fetch origin\ngit checkout ${prMeta.headRef}\ngit rebase origin/main\ngit push --force-with-lease\n\`\`\``
      );
      return;
    case "self-fail":
      await dispatchRetry(forge, args.prNumber, prMeta.headRef, verdict.failingChecks, cliVersion);
      return;
    case "external-fail":
      await postExternalDiagnostic(
        forge,
        args.prNumber,
        cliVersion,
        verdict.failingChecks,
        priorChefComments
      );
      return;
    case "infra-fail":
      await postEscalation(
        forge,
        args.prNumber,
        cliVersion,
        priorChefComments,
        `Workflow infra failure (${verdict.failingChecks.join(", ")}). Re-run via the GitHub Actions UI or 'gh run rerun'. Auto-rerun isn't enabled in this chef build.`
      );
      return;
  }
}

function describeVerdict(v: FailureClass): string {
  switch (v.kind) {
    case "no-failure":
      return "no failure";
    case "self-conflict":
      return `self-conflict (${v.reason})`;
    case "self-fail":
      return `self-fail (${v.failingChecks.join(", ")})`;
    case "external-fail":
      return `external-fail (${v.failingChecks.join(", ")} — also red on base)`;
    case "infra-fail":
      return `infra-fail (${v.failingChecks.join(", ")})`;
  }
}

// ---------- gh helpers (shell out; lighter than wiring all of octokit) ----

interface PrMeta {
  headRef: string;
  outOfDate: boolean;
}

async function fetchPrMeta(repoRoot: string, prNumber: number): Promise<PrMeta | null> {
  try {
    const out = execSync(
      `gh pr view ${prNumber} --json headRefName,mergeStateStatus`,
      { cwd: repoRoot, encoding: "utf8" }
    );
    const obj = JSON.parse(out) as { headRefName: string; mergeStateStatus: string };
    return {
      headRef: obj.headRefName,
      // gh's mergeStateStatus = BEHIND when the PR head is older than
      // its base; that's our "needs rebase" signal. DIRTY = merge
      // conflict. Both should trigger the self-conflict path.
      outOfDate: obj.mergeStateStatus === "BEHIND" || obj.mergeStateStatus === "DIRTY",
    };
  } catch {
    return null;
  }
}

async function fetchChecks(
  repoRoot: string,
  prNumber: number,
  ref: "head" | "base"
): Promise<CheckStatus[]> {
  // gh's pr view returns statusCheckRollup for HEAD only. For base
  // we need to find the merge-base SHA + query its check-runs.
  if (ref === "head") {
    try {
      const out = execSync(
        `gh pr view ${prNumber} --json statusCheckRollup --jq '.statusCheckRollup'`,
        { cwd: repoRoot, encoding: "utf8", maxBuffer: 1024 * 256 }
      );
      const arr = JSON.parse(out || "[]") as Array<{
        name?: string;
        conclusion?: string;
      }>;
      return arr
        .filter((c) => c.name && c.conclusion !== undefined)
        .map((c) => ({
          name: c.name ?? "",
          conclusion: (c.conclusion ?? "").toLowerCase(),
        }));
    } catch {
      return [];
    }
  }
  // base: get the PR's base ref + grab its latest check-run rollup.
  try {
    const baseRef = execSync(
      `gh pr view ${prNumber} --json baseRefName --jq '.baseRefName'`,
      { cwd: repoRoot, encoding: "utf8" }
    ).trim();
    const sha = execSync(`git rev-parse origin/${baseRef}`, {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const out = execSync(
      `gh api "repos/{owner}/{repo}/commits/${sha}/check-runs" --jq '.check_runs'`,
      { cwd: repoRoot, encoding: "utf8" }
    );
    const arr = JSON.parse(out || "[]") as Array<{
      name?: string;
      conclusion?: string | null;
    }>;
    return arr
      .filter((c) => c.name && c.conclusion)
      .map((c) => ({
        name: c.name ?? "",
        conclusion: (c.conclusion ?? "").toLowerCase(),
      }));
  } catch {
    return [];
  }
}

async function countChefComments(
  repoRoot: string,
  prNumber: number
): Promise<number> {
  try {
    const out = execSync(
      `gh pr view ${prNumber} --json comments --jq '.comments'`,
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 1024 * 1024 }
    );
    const arr = JSON.parse(out || "[]") as Array<{ body?: string }>;
    return arr.filter((c) => (c.body ?? "").startsWith("### slowcook · chef")).length;
  } catch {
    return 0;
  }
}

// 0.19.0-α.12 — slowcook:cost HTML marker for chef (PR-CI handler).
// chef doesn't call an LLM (it's a deterministic classifier), so cost
// is always 0; we still emit the marker so downstream aggregation
// (`gh issue view N | grep slowcook:cost`) sees every chef comment.
function chefCostMarker(kind: string, prNumber: number, cliVersion: string): string {
  return `<!-- slowcook:cost agent=chef usd=0.0000 kind=${kind} pr=${prNumber} cli=${cliVersion} -->`;
}

async function postEscalation(
  forge: InstanceType<typeof GitHubAdapter>,
  prNumber: number,
  cliVersion: string,
  priorComments: number,
  detail = "Multiple retries didn't resolve the failure. Operator action needed."
): Promise<void> {
  const body =
    `### slowcook · chef ⚠️ escalate\n\n${detail}\n\n` +
    `<sub>chef ${cliVersion} · prior chef-comments on this PR: ${priorComments}</sub>\n\n` +
    chefCostMarker("escalate", prNumber, cliVersion);
  await forge.createIssueComment(prNumber, body);
}

async function postExternalDiagnostic(
  forge: InstanceType<typeof GitHubAdapter>,
  prNumber: number,
  cliVersion: string,
  failingChecks: string[],
  priorComments: number
): Promise<void> {
  const body =
    `### slowcook · chef · external-failure\n\n` +
    `The following check(s) are failing on this PR but are also failing on the merge base:\n\n` +
    failingChecks.map((c) => `- \`${c}\``).join("\n") +
    `\n\nThe PR's diff didn't introduce these — they're pre-existing. Chef won't iterate. Operator: admin-merge if appropriate, or fix the underlying on a separate PR.\n\n` +
    `<sub>chef ${cliVersion} · prior chef-comments: ${priorComments}</sub>\n\n` +
    chefCostMarker("external-fail", prNumber, cliVersion);
  await forge.createIssueComment(prNumber, body);
}

async function dispatchRetry(
  forge: InstanceType<typeof GitHubAdapter>,
  prNumber: number,
  headRef: string,
  failingChecks: string[],
  cliVersion: string
): Promise<void> {
  const agent = originatingAgent(headRef);
  if (!agent) {
    await postEscalation(
      forge,
      prNumber,
      cliVersion,
      0,
      `Self-fail detected but originating agent is unknown for head ref '${headRef}'. No retry dispatched.`
    );
    return;
  }
  const body =
    `### slowcook · chef · self-failure (dispatch pending)\n\n` +
    `Failing checks introduced by this PR:\n\n` +
    failingChecks.map((c) => `- \`${c}\``).join("\n") +
    `\n\nWould dispatch retry to the **${agent}** workflow. Auto-dispatch isn't wired up in chef alpha.5c — operator: rerun the failing job(s) manually via the GitHub Actions UI or 'gh run rerun'.\n\n` +
    `<sub>chef ${cliVersion} · alpha.5c</sub>\n\n` +
    chefCostMarker(`self-fail-${agent}`, prNumber, cliVersion);
  await forge.createIssueComment(prNumber, body);
}

function detectOwnerRepo(repoRoot: string): { owner: string; repo: string } | null {
  try {
    const url = execSync("git remote get-url origin", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (m && m[1] && m[2]) return { owner: m[1], repo: m[2] };
  } catch {
    /* not a git repo */
  }
  return null;
}
