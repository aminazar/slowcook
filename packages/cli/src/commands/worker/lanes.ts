/**
 * Worker parallel lanes (PR-F, 2026-08-23 — Amin's directive: "I strictly
 * asked for parallelisation").
 *
 * One shared checkout serialized the whole pipeline: story-017 sat
 * brew-ready for two hours while story-016's tests converged, and the
 * plate responder once switched the shared checkout out from under a
 * human mid-repair. With `--lanes N`, a pass runs up to N runnable jobs
 * CONCURRENTLY, each in its own persistent git worktree under
 * .brewing/local/lanes/.
 *
 * Safety rules (v1, deliberate):
 *  - distinct stories only — two agents on one story share artifacts;
 *  - at most ONE brew per pass, and brew always runs in the MAIN
 *    checkout: brews execute the db suite, and the local database stack
 *    is a per-directory singleton (a lane running supabase spawns an
 *    orphan container fleet named after the lane dir — observed live);
 *  - lane worktrees persist across passes (fetch + hard reset each use);
 *    node_modules is symlinked from the main checkout.
 */

import { execSync } from "node:child_process";
import { existsSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { WorkerJob } from "./plan.js";

export const LANES_DIR = join(".brewing", "local", "lanes");

/** Stages that never touch the singleton database stack. */
const PARALLEL_SAFE = new Set(["refine", "recipe", "taste", "vibe", "eye"]);

/**
 * Pick the jobs for one multi-lane pass. Pure.
 *  - only enabled stages;
 *  - only runnable jobs;
 *  - distinct stories (jobs without a story id count as their issue);
 *  - at most one non-parallel-safe job (brew etc.), and it goes FIRST so
 *    the caller places it in the main checkout.
 */
export function pickLaneJobs(
  jobs: ReadonlyArray<WorkerJob>,
  enable: ReadonlySet<string>,
  lanes: number
): WorkerJob[] {
  const picked: WorkerJob[] = [];
  const stories = new Set<string>();
  let heavy: WorkerJob | null = null;
  for (const job of jobs) {
    if (!job.runnable || !enable.has(job.agent)) continue;
    const key = job.storyId ? `story-${job.storyId}` : `issue-${job.issue}`;
    if (stories.has(key)) continue;
    if (!PARALLEL_SAFE.has(job.agent)) {
      if (heavy) continue; // one db-touching job per pass
      heavy = job;
      stories.add(key);
      continue;
    }
    if (picked.length + (heavy ? 1 : 0) >= lanes) continue;
    picked.push(job);
    stories.add(key);
  }
  const out = heavy ? [heavy, ...picked] : picked;
  return out.slice(0, lanes);
}

/**
 * Ensure lane worktree k exists at the base branch tip. Returns its path.
 * Lane 0 is the main checkout itself.
 */
export function ensureLane(
  repoRoot: string,
  k: number,
  baseBranch: string,
  exec: (cmd: string, cwd: string) => string = (cmd, cwd) =>
    execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
): string {
  if (k === 0) return repoRoot;
  const lanePath = join(repoRoot, LANES_DIR, `lane-${k}`);
  exec(`git fetch origin ${JSON.stringify(baseBranch)}`, repoRoot);
  if (!existsSync(join(lanePath, ".git"))) {
    try {
      rmSync(lanePath, { recursive: true, force: true });
    } catch {
      /* nothing to clean */
    }
    exec(
      `git worktree add --force ${JSON.stringify(lanePath)} ${JSON.stringify(`origin/${baseBranch}`)}`,
      repoRoot
    );
  } else {
    exec(`git checkout --detach ${JSON.stringify(`origin/${baseBranch}`)}`, lanePath);
    exec(`git reset --hard ${JSON.stringify(`origin/${baseBranch}`)}`, lanePath);
    exec(`git clean -fd`, lanePath);
  }
  const nm = join(lanePath, "node_modules");
  if (!existsSync(nm) && existsSync(join(repoRoot, "node_modules"))) {
    symlinkSync(join(repoRoot, "node_modules"), nm, "dir");
  }
  return lanePath;
}
