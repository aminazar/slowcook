/**
 * CI entry for the test-provenance gate. Gathers the diff, the recipe ledger,
 * recorded amendments and the PR labels, then hands them to the pure verifier.
 *
 * Fails CLOSED on missing inputs it needs to judge: a gate that passes when it
 * cannot see the evidence protects nothing.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import {
  verifyProtection, renderVerdict, DEFAULT_OWNERSHIP,
  type AuthoredEntry, type OwnershipConfig,
} from "./ratchet-protection.js";

export const LEDGER_PATH = ".brewing/provenance/authored.json";
export const OWNERSHIP_PATH = ".brewing/ownership.json";

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function changedPaths(repoRoot: string, base: string, head: string): string[] {
  return sh(`git diff --name-only ${base}...${head}`, repoRoot)
    .split("\n").map((s) => s.trim()).filter(Boolean);
}

function hashAtHead(repoRoot: string, path: string): string | undefined {
  const full = join(repoRoot, path);
  if (!existsSync(full)) return undefined;   // deleted — nothing to hash
  return createHash("sha256").update(readFileSync(full)).digest("hex");
}

function readLedger(repoRoot: string): {
  entries: AuthoredEntry[];
  baseline: { commit: string; at: string; by: string } | null;
} {
  const p = join(repoRoot, LEDGER_PATH);
  if (!existsSync(p)) return { entries: [], baseline: null };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as {
      entries?: AuthoredEntry[];
      baseline?: { commit: string; at: string; by: string };
    };
    return {
      entries: Array.isArray(raw.entries) ? raw.entries : [],
      baseline: raw.baseline ?? null,
    };
  } catch {
    // An unreadable ledger cannot prove anything — treat as empty with no
    // baseline; the verifier then fails closed on any owned change.
    return { entries: [], baseline: null };
  }
}

/** Test files any story manifest is scored against — the oracle's true extent. */
function manifestTestFiles(repoRoot: string): string[] {
  const dir = join(repoRoot, ".brewing/manifests");
  if (!existsSync(dir)) return [];
  const out = new Set<string>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const m = JSON.parse(readFileSync(join(dir, name), "utf8")) as { tests?: Array<{ file?: string }> };
      for (const t of m.tests ?? []) if (t.file) out.add(t.file);
    } catch { /* a malformed manifest protects nothing; it does not crash the gate */ }
  }
  return [...out];
}

/**
 * Ownership map. Absent means the shipped default (tests->recipe,
 * specs->refine); a project adds its own classes, e.g. dash's
 * stories->pm-assistant.
 */
function readOwnership(repoRoot: string): OwnershipConfig {
  const p = join(repoRoot, OWNERSHIP_PATH);
  if (!existsSync(p)) return DEFAULT_OWNERSHIP;
  // A malformed project config must FAIL LOUDLY, never silently fall back
  // to defaults — the fallback would erase exactly the project-specific
  // rules the file exists to add (fail-open by typo).
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`slowcook check ratchet-protection: ${OWNERSHIP_PATH} is not valid JSON: ${(e as Error).message}`);
    process.exit(2);
  }
  const cfg = raw as OwnershipConfig;
  if (!Array.isArray(cfg.rules) || cfg.rules.length === 0) {
    console.error(`slowcook check ratchet-protection: ${OWNERSHIP_PATH} exists but has no rules[] — fix or delete it (deleting selects the shipped defaults).`);
    process.exit(2);
  }
  return cfg;
}

export interface RunArgs {
  repoRoot: string;
  base: string;
  head: string;
}

export function runRatchetProtection(args: RunArgs): { ok: boolean; report: string } {
  const changed = changedPaths(args.repoRoot, args.base, args.head);
  const headHashes: Record<string, string> = {};
  for (const p of changed) {
    const h = hashAtHead(args.repoRoot, p);
    if (h) headHashes[p] = h;
  }
  const ledger = readLedger(args.repoRoot);
  const verdict = verifyProtection({
    changedPaths: changed,
    headHashes,
    ledger: ledger.entries,
    baseline: ledger.baseline,
    config: readOwnership(args.repoRoot),
    manifestTestFiles: manifestTestFiles(args.repoRoot),
  });
  return { ok: verdict.ok, report: renderVerdict(verdict) };
}

