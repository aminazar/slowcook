/**
 * `.brewing/local/` — the single gitignored root for ENVIRONMENT state
 * (ratchet-adoption, Amin's 2026-08-22 ruling: a split in logic is a
 * split in files).
 *
 * Everything under here is a property of the machine the pipeline runs
 * on — caches, run logs, locks — and must NEVER be read by a gate:
 * gates judge the committed checkout, and this root is not committed.
 *
 * Versioned evidence lives elsewhere and stays put: .brewing/manifests/,
 * .brewing/ownership.json, .brewing/provenance/, .brewing/gates.yaml,
 * .brewing/stack.json, specs/.
 *
 * Consumers add ONE line to .gitignore:  .brewing/local/
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export const LOCAL_ROOT = ".brewing/local";

/** Brew's per-run logs, checkpoints and patches. */
export function runsDir(repoRoot: string): string {
  return join(repoRoot, LOCAL_ROOT, "runs");
}

export const BREW_LOCK_REL = `${LOCAL_ROOT}/brew.lock`;

const HISTORY_INDEX_REL = `${LOCAL_ROOT}/history-index.json`;
const LEGACY_HISTORY_INDEX_REL = ".brewing/history-index.json";

/** Where to WRITE the history index (always the new home). */
export function historyIndexWritePath(repoRoot: string): string {
  return join(repoRoot, HISTORY_INDEX_REL);
}

/** Where to READ it: the new home, falling back to the pre-split
 *  location for one version so existing checkouts keep their cache. */
export function historyIndexReadPath(repoRoot: string): string {
  const current = join(repoRoot, HISTORY_INDEX_REL);
  if (existsSync(current)) return current;
  const legacy = join(repoRoot, LEGACY_HISTORY_INDEX_REL);
  if (existsSync(legacy)) return legacy;
  return current;
}
