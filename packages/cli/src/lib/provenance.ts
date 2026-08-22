/**
 * Provenance ledger writing — the producer side of ratchet protection
 * (docs/plans/ratchet-adoption.md, step "producers").
 *
 * Every agent that authors an OWNED artifact (specs, story tests)
 * appends an entry here IN THE SAME COMMIT as the artifact: the entry
 * is the provenance of that commit, and the CI gate
 * (`slowcook check ratchet-protection`) can only judge what the
 * checkout carries.
 *
 * Authorization travels inside the entry, one of two forms:
 *   - a driving issue + its labels at run time, or
 *   - a derived trigger {reason, evidence} — the worker model, where
 *     resubmits and regenerations are initiated by reviews and drift
 *     rather than labels. Worker-spawned runs receive the trigger via
 *     SLOWCOOK_TRIGGER_* env vars and record it verbatim.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AuthoredEntry } from "../commands/check/ratchet-protection.js";

export const LEDGER_PATH = ".brewing/provenance/authored.json";

export interface LedgerFile {
  baseline?: { commit: string; at: string; by: string };
  entries: AuthoredEntry[];
}

export function readLedgerFile(repoRoot: string): LedgerFile {
  const p = join(repoRoot, LEDGER_PATH);
  if (!existsSync(p)) return { entries: [] };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as LedgerFile;
    return { ...raw, entries: Array.isArray(raw.entries) ? raw.entries : [] };
  } catch {
    // An unreadable ledger proves nothing; the gate fails closed on it.
    // The producer must not silently clobber it either — start fresh
    // entries but keep no baseline claim.
    return { entries: [] };
  }
}

export function sha256File(repoRoot: string, relPath: string): string {
  return createHash("sha256")
    .update(readFileSync(join(repoRoot, relPath)))
    .digest("hex");
}

/** The derived trigger a worker-spawned run carries, if any. */
export function triggerFromEnv(): { reason: string; evidence: string; trace?: string } | null {
  const reason = process.env["SLOWCOOK_TRIGGER_REASON"];
  const evidence = process.env["SLOWCOOK_TRIGGER_EVIDENCE"];
  if (!reason || !evidence) return null;
  const trace = process.env["SLOWCOOK_TRIGGER_TRACE"];
  return { reason, evidence, ...(trace ? { trace } : {}) };
}

/**
 * Append an authored entry for `files` (paths relative to repoRoot,
 * hashed as they stand on disk RIGHT NOW — call after writing, before
 * committing). Returns LEDGER_PATH so the caller stages it in the same
 * commit as the artifact. Best-effort hashing skips missing files
 * (deleted artifacts carry no hash — the gate treats deletion visibly).
 */
export function appendAuthored(
  repoRoot: string,
  entry: Omit<AuthoredEntry, "hashes" | "at"> & { at?: string }
): string {
  const ledger = readLedgerFile(repoRoot);
  const hashes: Record<string, string> = {};
  for (const f of entry.files) {
    try {
      hashes[f] = sha256File(repoRoot, f);
    } catch {
      /* deleted/missing — no hash recorded */
    }
  }
  ledger.entries.push({ ...entry, hashes, at: entry.at ?? new Date().toISOString() });
  const p = join(repoRoot, LEDGER_PATH);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(ledger, null, 2) + "\n", "utf8");
  return LEDGER_PATH;
}
