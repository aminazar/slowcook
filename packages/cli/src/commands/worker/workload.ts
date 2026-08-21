/**
 * `slowcook workload` — read-only inspection of what the worker sees
 * (eleven-defects D5). Every stall in the rewo run began with a human
 * reconstructing the worker's view by hand over SSH; this prints it:
 * the derived jobs in priority order, each precondition with its status
 * and responsible upstream agent, and what the next pass would run.
 *
 * Read-only by contract: unlike a worker pass it never mutates the
 * checkout — a checkout that doesn't match origin/base is REPORTED
 * (the derivation may be stale), not repaired and not refused.
 */

import { execSync } from "node:child_process";
import type { WorkerJob } from "./plan.js";
import { renderWorkloadLine, summarizeWorkload, type IssueFact } from "./plan.js";

export interface WorkloadView {
  identity: string;
  checkoutLine: string;
  issues: IssueFact[];
  jobs: WorkerJob[];
}

export function checkoutStatusLine(repoRoot: string, base: string): string {
  try {
    const headRef = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
    const headSha = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
    let originSha = "";
    try {
      originSha = execSync(`git rev-parse origin/${base}`, { cwd: repoRoot, encoding: "utf8" }).trim();
    } catch {
      return `checkout: ${headRef} @ ${headSha.slice(0, 9)} (origin/${base} unknown — fetch first)`;
    }
    if (headRef === base && headSha === originSha) {
      return `checkout: ${base} @ ${headSha.slice(0, 9)} (matches origin/${base})`;
    }
    return (
      `checkout: ${headRef} @ ${headSha.slice(0, 9)} — DOES NOT MATCH origin/${base} @ ` +
      `${originSha.slice(0, 9)}; the derivation below may be stale`
    );
  } catch {
    return "checkout: not a git repository?";
  }
}

const BADGE: Record<string, string> = { pass: "✓", fail: "✗", unknown: "?" };

export function renderWorkloadView(v: WorkloadView): string {
  const lines: string[] = [];
  lines.push(`identity: ${v.identity}`);
  lines.push(v.checkoutLine);
  const summary = summarizeWorkload(v.issues, v.jobs);
  lines.push(`workload: ${renderWorkloadLine(summary)}`);
  const ordered = [...v.jobs].sort((a, b) => a.priority - b.priority);
  ordered.forEach((j, i) => {
    lines.push(
      `  ${i + 1}. [prio ${j.priority}] ${j.agent} · #${j.issue}` +
        (j.storyId ? ` (story-${j.storyId})` : "") +
        ` — ${j.runnable ? "runnable" : "BLOCKED"}` +
        `\n     cmd: ${j.cmd.join(" ")}`
    );
    for (const c of j.preconditions) {
      lines.push(
        `     ${BADGE[c.status] ?? "?"} ${c.name}` +
          (c.upstream ? ` (upstream: ${c.upstream})` : "") +
          `: ${c.detail}`
      );
    }
  });
  if (ordered.length === 0) lines.push("  (no jobs derived — nothing to do)");
  const next = ordered.find((j) => j.runnable);
  lines.push(
    next
      ? `next pass runs: ${next.agent} · #${next.issue}${next.storyId ? ` (story-${next.storyId})` : ""} — subject to the pass's --enable set`
      : "next pass runs: nothing (no runnable job)"
  );
  if (summary.failedAwaitingHuman.length > 0) {
    lines.push(
      `agent:failed awaiting a human: ${summary.failedAwaitingHuman.map((n) => `#${n}`).join(", ")}`
    );
  }
  return lines.join("\n");
}
