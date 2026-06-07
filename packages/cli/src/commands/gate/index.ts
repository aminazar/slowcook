/**
 * design #9 — `slowcook gate check`. The dispatch-time HITL halt: refuse to let
 * a stage proceed until a human in the required role has approved on the PR.
 *
 *   slowcook gate check --stage <refine|plate|brew> --pr <n> [--repo owner/name]
 *
 * Exit 0 = gate satisfied (advance). Exit 1 = blocked (a human in the required
 * role(s) must approve, or a rejection must be resolved). Because approvals are
 * classified by identity (./github.ts) and only human reviewers in the role's
 * handle-list count (./model.ts), the automation cannot satisfy its own gate.
 */
import { execFileSync } from "node:child_process";
import { loadReviewers } from "./reviewers.js";
import { DEFAULT_GATES, isGateSatisfied, type Gate } from "./model.js";
import { mapReviewsToApprovals, type GhReview } from "./github.js";

function val(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function fetchReviews(repo: string, pr: string): GhReview[] {
  const out = execFileSync("gh", ["api", `repos/${repo}/pulls/${pr}/reviews`, "--paginate"], {
    encoding: "utf8",
  });
  return JSON.parse(out) as GhReview[];
}

function detectRepo(): string {
  const out = execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
    encoding: "utf8",
  });
  return out.trim();
}

export async function gate(args: string[], _version: string): Promise<void> {
  const sub = args[0];
  if (sub !== "check") {
    console.error("usage: slowcook gate check --stage <stage> --pr <n> [--repo owner/name]");
    process.exit(64);
  }
  const rest = args.slice(1);
  const stage = val(rest, "--stage");
  const pr = val(rest, "--pr");
  if (!stage || !pr) {
    console.error("gate check: --stage and --pr are required");
    process.exit(64);
  }

  const gateDef: Gate | undefined = DEFAULT_GATES.find((g) => g.stage === stage);
  if (!gateDef) {
    console.error(`gate check: no gate defined for stage '${stage}' (have: ${DEFAULT_GATES.map((g) => g.stage).join(", ")})`);
    process.exit(64);
  }

  const repo = val(rest, "--repo") ?? detectRepo();
  const reviewers = loadReviewers(process.cwd());
  const approvals = mapReviewsToApprovals(fetchReviews(repo, pr));
  const verdict = isGateSatisfied(gateDef!, reviewers, approvals);

  if (verdict.satisfied) {
    console.log(`gate '${stage}' ✓ satisfied — ${verdict.reason}`);
    return;
  }
  // Blocked. Name exactly who must act.
  const need = verdict.rejected
    ? verdict.reason
    : verdict.missingRoles
        .map((r) => `${r} (${reviewers.roles[r]?.join(", ") || "no reviewers configured in .brewing/reviewers.yaml"})`)
        .join("; ");
  console.error(`gate '${stage}' ✗ blocked-on-review — ${verdict.reason}`);
  console.error(`  needs approval from: ${need}`);
  process.exit(1);
}
