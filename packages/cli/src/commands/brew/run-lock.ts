/**
 * ONE BREW PER WORKING TREE.
 *
 * Two brew processes on the same repository interleave: both mutate the tree,
 * both revert against a snapshot the other is moving, both append to the same
 * ledger. The result is not merely noisy — it is unattributable. A dogfood run
 * that was meant to produce a quotable cost/iteration number produced two
 * SUCCESS lines in one log and no usable figures, because an operator's kill
 * command silently failed and the "restart" became a second concurrent run.
 *
 * Fixing the kill command fixes one operator's mistake. This fixes the class:
 * a brew that finds another brew holding the same working tree refuses to
 * start. Requested by the dovizir agent in aminazar/slowcook#413 as "a run
 * that cannot silently become two runs".
 *
 * Liveness, honestly:
 *   - same host, pid alive  -> HELD. Refuse.
 *   - same host, pid dead   -> STALE. Take over (the holder crashed).
 *   - different host        -> we cannot signal-check a foreign pid, so fall
 *                             back to the heartbeat: held while it is fresh,
 *                             stale once it goes quiet. Shared network
 *                             checkouts are real (this is exactly how the
 *                             dovizir experiment runs).
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname } from "node:os";

export const LOCK_PATH = ".brewing/local/brew.lock"; // env state lives under .brewing/local/ (ratchet-adoption)

/** A foreign-host lock is presumed dead after this long without a heartbeat. */
export const STALE_AFTER_MS = 30 * 60 * 1000;

export interface LockRecord {
  pid: number;
  host: string;
  storyId: string;
  startedAt: string;
  /** Refreshed each iteration; the liveness signal for foreign hosts. */
  heartbeatAt: string;
}

export type LockVerdict =
  | { state: "free" }
  | { state: "held"; holder: LockRecord; reason: string }
  | { state: "stale"; holder: LockRecord; reason: string };

/** Is a pid alive on THIS host? signal 0 tests existence without delivering. */
export function pidAlive(pid: number, kill: (p: number, s: number) => void = process.kill.bind(process)): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but belongs to another user — still alive.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Judge an existing lock record. Pure — takes the clock and the liveness probe
 * so every branch is testable without spawning anything.
 */
export function judgeLock(
  holder: LockRecord,
  opts: {
    now: number;
    thisHost: string;
    isAlive: (pid: number) => boolean;
    staleAfterMs?: number;
  }
): LockVerdict {
  const staleAfter = opts.staleAfterMs ?? STALE_AFTER_MS;
  const age = opts.now - Date.parse(holder.heartbeatAt);

  if (holder.host === opts.thisHost) {
    if (opts.isAlive(holder.pid)) {
      return {
        state: "held",
        holder,
        reason: `pid ${holder.pid} on this host is still running story ${holder.storyId}`,
      };
    }
    return {
      state: "stale",
      holder,
      reason: `pid ${holder.pid} is gone — the previous run died without releasing the lock`,
    };
  }

  // Foreign host: no signal check is possible, so trust the heartbeat only.
  if (Number.isNaN(age) || age < staleAfter) {
    return {
      state: "held",
      holder,
      reason:
        `held by pid ${holder.pid} on ${holder.host} (story ${holder.storyId}), ` +
        `last heartbeat ${Number.isNaN(age) ? "unreadable" : `${Math.round(age / 1000)}s ago`}`,
    };
  }
  return {
    state: "stale",
    holder,
    reason: `last heartbeat from ${holder.host} was ${Math.round(age / 60000)} minutes ago`,
  };
}

function lockFile(repoRoot: string): string {
  return join(repoRoot, LOCK_PATH);
}

/** Read the current lock, or null when absent/unreadable. */
export function readLock(repoRoot: string): LockRecord | null {
  const p = lockFile(repoRoot);
  if (!existsSync(p)) return null;
  try {
    const r = JSON.parse(readFileSync(p, "utf8")) as LockRecord;
    if (typeof r.pid !== "number" || typeof r.host !== "string") return null;
    return r;
  } catch {
    // A corrupt lock must not wedge the repo forever.
    return null;
  }
}

export interface AcquireResult {
  acquired: boolean;
  /** Set when refused — the message to show the operator. */
  message?: string;
  /** Set when we took over a dead holder's lock. */
  tookOverFrom?: LockRecord;
}

/**
 * Take the lock for this repo, or refuse. Does NOT throw on refusal — the
 * caller decides how loudly to exit.
 */
export function acquireLock(
  repoRoot: string,
  storyId: string,
  opts: { now?: number; thisHost?: string; isAlive?: (pid: number) => boolean; pid?: number } = {}
): AcquireResult {
  const now = opts.now ?? Date.now();
  const thisHost = opts.thisHost ?? hostname();
  const isAlive = opts.isAlive ?? pidAlive;
  const pid = opts.pid ?? process.pid;

  const existing = readLock(repoRoot);
  let tookOverFrom: LockRecord | undefined;

  if (existing) {
    const verdict = judgeLock(existing, { now, thisHost, isAlive });
    if (verdict.state === "held") {
      return {
        acquired: false,
        message:
          `another brew is already running in this working tree — ${verdict.reason}.\n` +
          `  Two brews on one tree interleave their edits and reverts, which makes the run\n` +
          `  unattributable rather than merely noisy. Wait for it, or stop it and retry.\n` +
          `  Lock: ${lockFile(repoRoot)}`,
      };
    }
    tookOverFrom = existing;
  }

  const record: LockRecord = {
    pid,
    host: thisHost,
    storyId,
    startedAt: new Date(now).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
  };
  mkdirSync(dirname(lockFile(repoRoot)), { recursive: true });
  writeFileSync(lockFile(repoRoot), JSON.stringify(record, null, 2), "utf8");
  return { acquired: true, ...(tookOverFrom ? { tookOverFrom } : {}) };
}

/** Refresh the heartbeat. Call once per iteration. Best-effort. */
export function touchLock(repoRoot: string, now = Date.now()): void {
  try {
    const r = readLock(repoRoot);
    if (!r) return;
    r.heartbeatAt = new Date(now).toISOString();
    writeFileSync(lockFile(repoRoot), JSON.stringify(r, null, 2), "utf8");
    utimesSync(lockFile(repoRoot), new Date(now), new Date(now));
  } catch { /* a failed heartbeat must never sink a run */ }
}

/** Release the lock if we still hold it. Safe to call twice. */
export function releaseLock(repoRoot: string, opts: { pid?: number; thisHost?: string } = {}): void {
  try {
    const r = readLock(repoRoot);
    if (!r) return;
    // Never delete someone else's lock — a stale-takeover race would otherwise
    // have the loser release the winner's claim on its way out.
    if (r.pid !== (opts.pid ?? process.pid) || r.host !== (opts.thisHost ?? hostname())) return;
    unlinkSync(lockFile(repoRoot));
  } catch { /* best-effort */ }
}
