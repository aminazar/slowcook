/**
 * Answered-comment ledger (2026-08-23, the "/plate approved" echo storm).
 *
 * Plate's only idempotency cutoff used to be the LAST PLATE COMMIT date —
 * but a round that decides "nothing to amend" makes NO commit, so the
 * same comment re-qualified every timer tick and plate re-answered it
 * every 3 minutes (observed live on reworthy/app#237; the same shape
 * users saw as comment spam on #129).
 *
 * This ledger records every comment id a plate run has CONSIDERED, at the
 * point its reply/commit lands. Environment state, not repo history —
 * lives under .brewing/local/ (gitignored per the env/evidence split).
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const STORE_REL = join(".brewing", "local", "plate-answered.json");
/** Per-PR cap — old ids age out; GitHub ids are monotonic so keep newest. */
const MAX_IDS_PER_PR = 1000;

type Store = Record<string, number[]>;

function storePath(repoRoot: string): string {
  return join(repoRoot, STORE_REL);
}

function loadStore(repoRoot: string): Store {
  try {
    const parsed = JSON.parse(readFileSync(storePath(repoRoot), "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Store;
    }
  } catch {
    /* missing or corrupt → start fresh; worst case one duplicate reply */
  }
  return {};
}

export function loadAnsweredIds(repoRoot: string, prNumber: number): Set<number> {
  const ids = loadStore(repoRoot)[String(prNumber)];
  return new Set(Array.isArray(ids) ? ids.filter((n) => typeof n === "number") : []);
}

export function recordAnsweredIds(
  repoRoot: string,
  prNumber: number,
  ids: ReadonlyArray<number>
): void {
  if (ids.length === 0) return;
  const store = loadStore(repoRoot);
  const key = String(prNumber);
  const merged = Array.from(new Set([...(store[key] ?? []), ...ids]));
  merged.sort((a, b) => a - b);
  store[key] = merged.slice(-MAX_IDS_PER_PR);
  const p = storePath(repoRoot);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(store, null, 2), "utf8");
}
