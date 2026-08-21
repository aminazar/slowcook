/**
 * Discovery hygiene (ledger G20): test discovery certifies THE COMMITTED
 * ARTIFACT, but it runs against the worktree — untracked residue under
 * src/ or tests/ can resolve imports the committed tree cannot, making a
 * broken PR pass discovery (story-019: the stub the tests imported lived
 * only as residue; the PR shipped without it).
 *
 * Worker passes clean their workspace (ensureBaseCheckout). Manual CLI
 * runs must not auto-delete a developer's files, so they fail closed:
 * list the paths that could make discovery lie and refuse to certify.
 */

import { execSync } from "node:child_process";

/** Modified or untracked paths under src/ or tests/ that can shadow the
 *  committed tree during discovery. Empty = safe to certify. */
export function dirtyDiscoveryPaths(repoRoot: string): string[] {
  // -uall: porcelain otherwise collapses a fully-untracked directory to
  // "?? src/" and the per-file prefix filter below would miss it.
  const out = execSync("git status --porcelain -uall", { cwd: repoRoot, encoding: "utf8" });
  return out
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => ({ status: l.slice(0, 2), path: l.slice(3).trim() }))
    .filter(
      (e) =>
        (e.path.startsWith("src/") || e.path.startsWith("tests/")) &&
        !e.path.includes(".brewing/history-index")
    )
    .map((e) => `${e.status} ${e.path}`);
}

/** Exit-2 guard for manual testgen entry points. */
export function assertDiscoveryHygiene(repoRoot: string): void {
  const dirty = dirtyDiscoveryPaths(repoRoot);
  if (dirty.length === 0) return;
  console.error(
    "slowcook: refusing to run test discovery on a dirty tree — these files could make discovery pass while the committed PR is broken:\n" +
      dirty.map((p) => `  ${p}`).join("\n") +
      "\nCommit, stash, or clean them (worker workspaces are cleaned automatically)."
  );
  process.exit(2);
}
