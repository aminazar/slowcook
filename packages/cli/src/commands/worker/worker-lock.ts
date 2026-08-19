/**
 * ONE WORKER JOB AT A TIME (plan §2, docs/plans/rewo-agent-workers.md).
 *
 * The systemd timer fires every few minutes regardless of whether the
 * previous pass finished. Two passes on one box would race the same
 * checkout and the same labels. Same liveness model as brew's run-lock
 * (which stays as the second line of defence inside the working tree) —
 * the judging logic is reused from there; only the lock's location
 * differs: the worker lock lives at an operator-chosen path
 * (e.g. /run/slowcook-worker.lock), not inside a repo.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { hostname } from "node:os";
import { judgeLock, pidAlive, type LockRecord } from "../brew/run-lock.js";

export interface WorkerLockResult {
  acquired: boolean;
  /** Set when refused — the message to show the operator. */
  message?: string;
  tookOverFrom?: LockRecord;
}

function readWorkerLock(path: string): LockRecord | null {
  if (!existsSync(path)) return null;
  try {
    const r = JSON.parse(readFileSync(path, "utf8")) as LockRecord;
    if (typeof r.pid !== "number" || typeof r.host !== "string") return null;
    return r;
  } catch {
    // A corrupt lock must not wedge the worker forever.
    return null;
  }
}

export function acquireWorkerLock(
  path: string,
  opts: { now?: number; thisHost?: string; isAlive?: (pid: number) => boolean; pid?: number } = {}
): WorkerLockResult {
  const now = opts.now ?? Date.now();
  const thisHost = opts.thisHost ?? hostname();
  const isAlive = opts.isAlive ?? pidAlive;
  const pid = opts.pid ?? process.pid;

  const existing = readWorkerLock(path);
  let tookOverFrom: LockRecord | undefined;
  if (existing) {
    const verdict = judgeLock(existing, { now, thisHost, isAlive });
    if (verdict.state === "held") {
      return {
        acquired: false,
        message:
          `another worker pass is already running — ${verdict.reason}.\n` +
          `  One job at a time; this pass exits and the timer retries.\n` +
          `  Lock: ${path}`,
      };
    }
    tookOverFrom = existing;
  }

  const record: LockRecord = {
    pid,
    host: thisHost,
    storyId: "worker-pass",
    startedAt: new Date(now).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2), "utf8");
  return { acquired: true, ...(tookOverFrom ? { tookOverFrom } : {}) };
}

/** Remove only OUR lock; never someone else's. Safe to call twice. */
export function releaseWorkerLock(
  path: string,
  opts: { pid?: number; thisHost?: string } = {}
): void {
  const pid = opts.pid ?? process.pid;
  const thisHost = opts.thisHost ?? hostname();
  const existing = readWorkerLock(path);
  if (!existing) return;
  if (existing.pid !== pid || existing.host !== thisHost) return;
  try {
    unlinkSync(path);
  } catch {
    // Already gone — fine.
  }
}
