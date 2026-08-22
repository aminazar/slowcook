/**
 * `slowcook provenance init` — the ONE-TIME baseline that arms ratchet
 * protection (docs/plans/ratchet-adoption.md; Amin's 2026-08-22 ruling:
 * grandfathering happens at install, never lazily on gaps).
 *
 * It enumerates every owned artifact (ownership rules + manifest test
 * files), hashes each as it stands, and writes ONE ledger entry
 * (`agent: "pre-provenance"`) plus the `baseline` header naming the
 * commit, the time, and the human who ran it. Everything owned is
 * thereby sanctioned AS IT IS; from the next commit the gate is strict.
 *
 * Refusals, all loud:
 *   - a baseline already exists (re-baselining would launder hand edits);
 *   - owned paths have uncommitted changes (a baseline describes a
 *     commit, not a working tree in motion);
 *   - malformed ownership config (fail closed, never default-fallback).
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  DEFAULT_OWNERSHIP,
  ruleFor,
  type OwnershipConfig,
} from "../check/ratchet-protection.js";
import { appendAuthored, readLedgerFile, LEDGER_PATH } from "../../lib/provenance.js";
import { writeFileSync } from "node:fs";

export const OWNERSHIP_PATH = ".brewing/ownership.json";

export async function provenance(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub !== "init") {
    console.log(`
slowcook provenance — ratchet-protection ledger management

Usage:
  slowcook provenance init [--cwd <path>] [--by <name>]

init  One-time baseline: sanction every owned artifact as it stands and
      arm the ratchet. Strict from the next commit. Refuses to run twice.
`);
    if (sub !== undefined && sub !== "help" && sub !== "--help" && sub !== "-h") process.exit(64);
    return;
  }
  let repoRoot = process.cwd();
  let by = "";
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--cwd" && next) { repoRoot = next; i++; }
    else if (a === "--by" && next) { by = next; i++; }
  }
  init(repoRoot, by);
}

function readOwnershipStrict(repoRoot: string): OwnershipConfig {
  const p = join(repoRoot, OWNERSHIP_PATH);
  if (!existsSync(p)) return DEFAULT_OWNERSHIP;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`slowcook provenance init: ${OWNERSHIP_PATH} is not valid JSON: ${(e as Error).message}`);
    process.exit(2);
  }
  const cfg = raw as OwnershipConfig;
  if (!Array.isArray(cfg.rules) || cfg.rules.length === 0) {
    console.error(`slowcook provenance init: ${OWNERSHIP_PATH} exists but has no rules[] — fix or delete it.`);
    process.exit(2);
  }
  return cfg;
}

function manifestTestFiles(repoRoot: string): string[] {
  const dir = join(repoRoot, ".brewing/manifests");
  if (!existsSync(dir)) return [];
  const out = new Set<string>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const m = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
        tests?: Array<{ file?: string }>;
      };
      for (const t of m.tests ?? []) if (t.file) out.add(t.file);
    } catch { /* malformed manifest contributes nothing */ }
  }
  return [...out];
}

function walk(dir: string, acc: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
}

export function enumerateOwned(repoRoot: string, config: OwnershipConfig): string[] {
  const manifestTests = manifestTestFiles(repoRoot);
  const owned = new Set<string>();
  for (const f of manifestTests) {
    if (ruleFor(f, config, manifestTests) && existsSync(join(repoRoot, f))) owned.add(f);
  }
  for (const rule of config.rules) {
    for (const p of rule.paths ?? []) {
      const prefix = p.replace(/\*+$/, "");
      const abs = join(repoRoot, prefix);
      if (!existsSync(abs)) continue;
      if (statSync(abs).isDirectory()) {
        const files: string[] = [];
        walk(abs, files);
        for (const f of files) {
          const rel = relative(repoRoot, f);
          if (ruleFor(rel, config, manifestTests)) owned.add(rel);
        }
      } else {
        owned.add(prefix);
      }
    }
  }
  return [...owned].sort();
}

function init(repoRoot: string, byArg: string): void {
  const existing = readLedgerFile(repoRoot);
  if (existing.baseline) {
    console.error(
      `slowcook provenance init: a baseline already exists (commit ${existing.baseline.commit.slice(0, 9)}, ` +
        `by ${existing.baseline.by}, at ${existing.baseline.at}).\n` +
        `  Re-baselining would sanction whatever the tree holds NOW — including hand edits the ` +
        `ratchet exists to stop. If a new ownership rule needs coverage, extend via the owning agent.`
    );
    process.exit(2);
  }

  const config = readOwnershipStrict(repoRoot);
  const ownedFiles = enumerateOwned(repoRoot, config);
  if (ownedFiles.length === 0) {
    console.error(
      "slowcook provenance init: no owned artifacts found (no specs/, no manifest tests) — nothing to baseline yet. Run after the first spec or manifest exists."
    );
    process.exit(2);
  }

  // A baseline describes a COMMIT. Owned paths must not be mid-edit.
  const dirtyOwned = execSync("git status --porcelain -uall", { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => l.slice(3).trim())
    .filter((p) => ownedFiles.includes(p));
  if (dirtyOwned.length > 0) {
    console.error(
      `slowcook provenance init: ${dirtyOwned.length} owned path(s) have uncommitted changes — ` +
        `commit or revert them first:\n  ${dirtyOwned.slice(0, 5).join("\n  ")}`
    );
    process.exit(2);
  }

  const commit = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
  const by =
    byArg ||
    (() => {
      try {
        return execSync("git config user.name", { cwd: repoRoot, encoding: "utf8" }).trim();
      } catch {
        return "unknown";
      }
    })();

  appendAuthored(repoRoot, {
    agent: "pre-provenance",
    files: ownedFiles,
    derived: {
      reason: "baseline",
      evidence: `slowcook provenance init by ${by} at commit ${commit.slice(0, 9)}`,
    },
  });
  const ledger = readLedgerFile(repoRoot);
  ledger.baseline = { commit, at: new Date().toISOString(), by };
  writeFileSync(join(repoRoot, LEDGER_PATH), JSON.stringify(ledger, null, 2) + "\n", "utf8");

  console.log(
    `baseline written: ${ownedFiles.length} owned artifact(s) sanctioned as they stand at ${commit.slice(0, 9)} (by ${by}).\n` +
      `Commit ${LEDGER_PATH} now — the ratchet is strict from the next commit.\n` +
      `  git add ${LEDGER_PATH} && git commit -m "slowcook: provenance baseline"`
  );
}
