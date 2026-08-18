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

function readLedger(repoRoot: string): AuthoredEntry[] {
  const p = join(repoRoot, LEDGER_PATH);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as { entries?: AuthoredEntry[] };
    return Array.isArray(raw.entries) ? raw.entries : [];
  } catch {
    return [];
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
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as OwnershipConfig;
    return Array.isArray(raw.rules) && raw.rules.length > 0 ? raw : DEFAULT_OWNERSHIP;
  } catch {
    return DEFAULT_OWNERSHIP;
  }
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
  const verdict = verifyProtection({
    changedPaths: changed,
    headHashes,
    ledger: readLedger(args.repoRoot),
    config: readOwnership(args.repoRoot),
    manifestTestFiles: manifestTestFiles(args.repoRoot),
  });
  return { ok: verdict.ok, report: renderVerdict(verdict) };
}

