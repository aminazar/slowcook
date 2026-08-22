// One brew per working tree (slowcook#413). The dogfood failure this prevents:
// a kill command silently failed, the "restart" became a second concurrent
// brew, and the run produced two SUCCESS lines and no attributable numbers.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  judgeLock, acquireLock, releaseLock, touchLock, readLock, pidAlive,
  LOCK_PATH, STALE_AFTER_MS, type LockRecord,
} from "./run-lock.js";

const T0 = Date.parse("2026-08-18T12:00:00.000Z");
const rec = (over: Partial<LockRecord> = {}): LockRecord => ({
  pid: 4242,
  host: "box-a",
  storyId: "002",
  startedAt: new Date(T0).toISOString(),
  heartbeatAt: new Date(T0).toISOString(),
  ...over,
});

describe("judgeLock", () => {
  const alive = () => true;
  const dead = () => false;

  it("HELD when the holder is alive on this host", () => {
    const v = judgeLock(rec(), { now: T0 + 1000, thisHost: "box-a", isAlive: alive });
    expect(v.state).toBe("held");
    expect(v.state === "held" && v.reason).toContain("still running story 002");
  });

  it("STALE when the holder's pid is gone — a crash must not wedge the repo", () => {
    const v = judgeLock(rec(), { now: T0 + 1000, thisHost: "box-a", isAlive: dead });
    expect(v.state).toBe("stale");
    expect(v.state === "stale" && v.reason).toContain("died without releasing");
  });

  it("a fresh FOREIGN-host lock is held — we cannot signal-check it", () => {
    // isAlive would answer about OUR pid table, not theirs; it must not be consulted.
    const v = judgeLock(rec({ host: "box-b" }), {
      now: T0 + 60_000,
      thisHost: "box-a",
      isAlive: () => { throw new Error("must not probe a foreign pid"); },
    });
    expect(v.state).toBe("held");
    expect(v.state === "held" && v.reason).toContain("box-b");
  });

  it("a foreign lock goes stale once the heartbeat stops", () => {
    const v = judgeLock(rec({ host: "box-b" }), {
      now: T0 + STALE_AFTER_MS + 1000,
      thisHost: "box-a",
      isAlive: () => true,
    });
    expect(v.state).toBe("stale");
    expect(v.state === "stale" && v.reason).toContain("minutes ago");
  });

  it("an unparsable heartbeat is treated as held, not as free", () => {
    // Fail safe: refusing a run costs a retry, a double run costs the result.
    const v = judgeLock(rec({ host: "box-b", heartbeatAt: "not-a-date" }), {
      now: T0, thisHost: "box-a", isAlive: () => true,
    });
    expect(v.state).toBe("held");
  });
});

describe("acquire / release against a real directory", () => {
  let repo: string;
  beforeEach(() => { repo = mkdtempSync(join(tmpdir(), "brewlock-")); });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("acquires on a clean tree and writes the record", () => {
    const r = acquireLock(repo, "002", { now: T0, thisHost: "box-a", pid: 111, isAlive: () => true });
    expect(r.acquired).toBe(true);
    expect(existsSync(join(repo, LOCK_PATH))).toBe(true);
    expect(readLock(repo)).toMatchObject({ pid: 111, host: "box-a", storyId: "002" });
  });

  it("REFUSES a second brew while the first is alive", () => {
    acquireLock(repo, "002", { now: T0, thisHost: "box-a", pid: 111, isAlive: () => true });
    const second = acquireLock(repo, "002", { now: T0 + 5000, thisHost: "box-a", pid: 222, isAlive: () => true });
    expect(second.acquired).toBe(false);
    expect(second.message).toContain("another brew is already running");
    expect(second.message).toContain("unattributable");
    // The original holder must still own it.
    expect(readLock(repo)!.pid).toBe(111);
  });

  it("takes over from a dead holder and says whose lock it took", () => {
    acquireLock(repo, "002", { now: T0, thisHost: "box-a", pid: 111, isAlive: () => true });
    const second = acquireLock(repo, "002", {
      now: T0 + 5000, thisHost: "box-a", pid: 222, isAlive: (p) => p !== 111,
    });
    expect(second.acquired).toBe(true);
    expect(second.tookOverFrom?.pid).toBe(111);
    expect(readLock(repo)!.pid).toBe(222);
  });

  it("a corrupt lock file does not wedge the repo forever", () => {
    mkdirSync(join(repo, ".brewing/local"), { recursive: true });
    writeFileSync(join(repo, LOCK_PATH), "{ not json", "utf8");
    expect(acquireLock(repo, "002", { now: T0, thisHost: "box-a", pid: 111 }).acquired).toBe(true);
  });

  it("release removes only OUR lock, never someone else's", () => {
    acquireLock(repo, "002", { now: T0, thisHost: "box-a", pid: 111, isAlive: () => true });
    releaseLock(repo, { pid: 999, thisHost: "box-a" });          // not ours
    expect(existsSync(join(repo, LOCK_PATH))).toBe(true);
    releaseLock(repo, { pid: 111, thisHost: "box-a" });          // ours
    expect(existsSync(join(repo, LOCK_PATH))).toBe(false);
  });

  it("release is safe to call twice and on a lockless tree", () => {
    expect(() => releaseLock(repo, { pid: 111, thisHost: "box-a" })).not.toThrow();
    expect(() => releaseLock(repo, { pid: 111, thisHost: "box-a" })).not.toThrow();
  });

  it("the heartbeat advances so a long run never looks abandoned", () => {
    acquireLock(repo, "002", { now: T0, thisHost: "box-a", pid: 111, isAlive: () => true });
    touchLock(repo, T0 + STALE_AFTER_MS * 2);
    const after = readLock(repo)!;
    expect(Date.parse(after.heartbeatAt)).toBe(T0 + STALE_AFTER_MS * 2);
    // A foreign observer now sees it as held, not stale.
    expect(judgeLock(after, {
      now: T0 + STALE_AFTER_MS * 2 + 1000, thisHost: "box-b", isAlive: () => true,
    }).state).toBe("held");
  });
});

describe("pidAlive", () => {
  it("reports this process as alive", () => {
    expect(pidAlive(process.pid)).toBe(true);
  });
  it("treats EPERM as alive — the process exists, it is just not ours", () => {
    expect(pidAlive(1, () => { const e = new Error("perm") as NodeJS.ErrnoException; e.code = "EPERM"; throw e; })).toBe(true);
  });
  it("reports a missing pid as dead", () => {
    expect(pidAlive(1, () => { const e = new Error("no") as NodeJS.ErrnoException; e.code = "ESRCH"; throw e; })).toBe(false);
  });
});
