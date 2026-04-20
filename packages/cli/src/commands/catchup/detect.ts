// Pure detection: given a forge + local spec state, what pipeline steps
// should have run but haven't? Results are returned as a structured report
// so the CLI can print and/or act on them.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ForgeAdapter, Issue } from "@slowcook-ai/core";
import { readIndex } from "../refine/spec-yaml.js";

export interface PendingRefinement {
  issueNumber: number;
  title: string;
  /** Whether any agent comment has been posted already. */
  hasAgentComments: boolean;
  reason: string;
}

export interface PendingOnSpecMerged {
  storyId: string;
  prNumber: number;
  sourceIssueNumber: number;
  reason: string;
}

export interface PendingTestgen {
  storyId: string;
  title: string;
  reason: string;
}

export interface PipelineState {
  pendingRefinements: PendingRefinement[];
  pendingOnSpecMerged: PendingOnSpecMerged[];
  pendingTestgen: PendingTestgen[];
}

export async function detectPipelineState(
  forge: ForgeAdapter,
  repoRoot: string
): Promise<PipelineState> {
  const [pendingRefinements, pendingOnSpecMerged, pendingTestgen] = await Promise.all([
    detectPendingRefinements(forge),
    detectPendingOnSpecMerged(forge, repoRoot),
    detectPendingTestgen(repoRoot),
  ]);
  return { pendingRefinements, pendingOnSpecMerged, pendingTestgen };
}

async function detectPendingRefinements(forge: ForgeAdapter): Promise<PendingRefinement[]> {
  const issues = await forge.listIssuesByLabel("needs-refinement", "open");
  const bot = await forge.botUsername();
  const pending: PendingRefinement[] = [];
  for (const issue of issues) {
    const comments = await forge.listIssueComments(issue.number);
    const agentComments = comments.filter(
      (c) => c.is_bot || c.author === bot || c.body.startsWith("### slowcook")
    );
    // If agent has commented, refinement is "in progress" — next PM reply
    // will re-trigger the webhook normally. Still surface these, but tagged.
    pending.push({
      issueNumber: issue.number,
      title: issue.title,
      hasAgentComments: agentComments.length > 0,
      reason: agentComments.length === 0
        ? "no agent comments — trigger was likely missed"
        : `${agentComments.length} agent comment(s) — in progress, waiting on PM`,
    });
  }
  return pending;
}

async function detectPendingOnSpecMerged(
  forge: ForgeAdapter,
  repoRoot: string
): Promise<PendingOnSpecMerged[]> {
  const index = readIndex(repoRoot);
  const pending: PendingOnSpecMerged[] = [];

  for (const [storyId, entry] of Object.entries(index.stories)) {
    if (entry.status !== "active") continue;
    if (!entry.source_issue) continue;
    const sourceIssueNumber = parseInt(entry.source_issue.replace(/^#/, ""), 10);
    if (isNaN(sourceIssueNumber)) continue;

    // If the source issue is already `spec-ready`, nothing to do.
    let issue: Issue;
    try {
      issue = await forge.getIssue(sourceIssueNumber);
    } catch {
      continue;
    }
    if (issue.labels.includes("spec-ready")) continue;
    // Only flag if there's actually a merged spec PR for this branch —
    // otherwise the issue's pre-spec state (spec-submitted, etc.) is real
    // and we'd just be labelling mid-flight work as "pending."
    const branchName = `slowcook/spec/story-${storyId}`;
    const pr = await forge.findPullRequestByBranch(branchName);
    if (!pr) continue;
    if (!pr.merged) continue;

    pending.push({
      storyId,
      prNumber: pr.number,
      sourceIssueNumber,
      reason: `PR #${pr.number} merged but issue #${sourceIssueNumber} still has labels [${issue.labels.join(", ")}]`,
    });
  }
  return pending;
}

async function detectPendingTestgen(repoRoot: string): Promise<PendingTestgen[]> {
  const index = readIndex(repoRoot);
  const pending: PendingTestgen[] = [];
  for (const [storyId, entry] of Object.entries(index.stories)) {
    if (entry.status !== "active") continue;
    const testPath = join(repoRoot, "tests", "integration", `story-${storyId}.test.ts`);
    if (existsSync(testPath)) continue;
    pending.push({
      storyId,
      title: entry.title,
      reason: `${testPath.replace(repoRoot + "/", "")} does not exist`,
    });
  }
  return pending;
}

/** Human-readable report of a PipelineState. */
export function formatReport(state: PipelineState): string {
  const lines: string[] = [];
  lines.push("=== Pipeline catchup report ===");
  lines.push("");

  lines.push("Pending refinements (manual — bounce the `needs-refinement` label to re-trigger):");
  if (state.pendingRefinements.length === 0) {
    lines.push("  (none)");
  } else {
    for (const r of state.pendingRefinements) {
      const tag = r.hasAgentComments ? "[in progress]" : "[MISSED TRIGGER]";
      lines.push(`  ${tag} #${r.issueNumber} — ${r.title}`);
      lines.push(`      reason: ${r.reason}`);
    }
  }

  lines.push("");
  lines.push("Pending on-spec-merged (auto):");
  if (state.pendingOnSpecMerged.length === 0) {
    lines.push("  (none)");
  } else {
    for (const p of state.pendingOnSpecMerged) {
      lines.push(`  story-${p.storyId}: ${p.reason}`);
    }
  }

  lines.push("");
  lines.push("Pending testgen (auto):");
  if (state.pendingTestgen.length === 0) {
    lines.push("  (none)");
  } else {
    for (const t of state.pendingTestgen) {
      lines.push(`  story-${t.storyId}: ${t.title}`);
      lines.push(`      reason: ${t.reason}`);
    }
  }

  return lines.join("\n");
}
