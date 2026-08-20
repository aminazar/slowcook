/**
 * Worker trace writer — the actual instrument (plan §3,
 * docs/plans/rewo-agent-workers.md).
 *
 * Per job, a directory `<logsDir>/<ts>-<agent>-<issue>/` holding:
 *
 *   cmd            exact argv, env NAMES (never values), backend, cwd, git sha
 *   preconditions  what this agent REQUIRED and whether it was present
 *   outcome        dry-run | success | failed | precondition-missing
 *   handoff        what it produced for the NEXT agent, and a hash of it
 *   stdout/stderr  full — live runs only (W1+)
 *
 * `preconditions` and `handoff` are the two files that find slowcook
 * bugs: a `precondition-missing` outcome names the upstream agent that
 * under-delivered, at the point of the gap instead of three stages
 * downstream.
 *
 * File contents are JSON; file names match the plan verbatim (no
 * extension) so the log tree reads the same as the design doc.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PreconditionCheck, WorkerJob } from "./plan.js";

export type JobOutcome = "dry-run" | "success" | "failed" | "precondition-missing";

export interface CmdRecord {
  argv: string[];
  /** Names only — values must never reach the trace. */
  envNames: string[];
  /** Which model backend was configured: "claude-cli" | "api" | "none". */
  backend: string;
  /** Who the forge sees: "<app-slug>[bot]" or "operator-token". */
  forgeIdentity: string;
  cwd: string;
  gitSha: string;
  startedAt: string;
}

export interface OutcomeRecord {
  outcome: JobOutcome;
  /** Set on precondition-missing: the checks that failed. */
  failedPreconditions?: PreconditionCheck[];
  detail: string;
  finishedAt: string;
}

export interface HandoffRecord {
  /** What the NEXT agent will need from this job. */
  producedFor: string;
  /** Artifact refs (PR numbers, file paths). Empty on dry-run. */
  artifacts: string[];
  /** Content hash of the primary artifact; null when nothing was produced. */
  hash: string | null;
}

export interface TraceInput {
  job: WorkerJob;
  cmd: CmdRecord;
  outcome: OutcomeRecord;
  handoff: HandoffRecord;
}

/** Directory name: `<ts>-<agent>-<issue>`, filesystem-safe timestamp. */
export function traceDirName(job: WorkerJob, now: Date): string {
  const ts = now.toISOString().replace(/[:.]/g, "-");
  return `${ts}-${job.agent}-${job.issue}`;
}

/** Write one job's trace directory. Returns the directory path. */
export function writeTrace(logsDir: string, input: TraceInput, now: Date): string {
  const dir = join(logsDir, traceDirName(input.job, now));
  mkdirSync(dir, { recursive: true });
  const put = (name: string, value: unknown) =>
    writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + "\n", "utf8");
  put("cmd", input.cmd);
  put("preconditions", input.job.preconditions);
  put("outcome", input.outcome);
  put("handoff", input.handoff);
  return dir;
}
