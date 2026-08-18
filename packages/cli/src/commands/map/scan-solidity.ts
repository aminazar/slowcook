/**
 * Walk a repo's Solidity sources and hand them to the stack-solidity scanner.
 *
 * Only the fs walk lives here; the parsing lives in @slowcook-ai/stack-solidity
 * so the language's knowledge sits with its stack adapter rather than in the
 * CLI. Dependency-free vendored code (`lib/`), build output (`out/`, `cache/`,
 * `artifacts/`) and node_modules are skipped: a Foundry repo's `lib/` holds
 * forge-std and OpenZeppelin, which would swamp the map with hundreds of
 * contracts the agent is not being asked to write.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { scanSolidityFile, type ContractEntry } from "@slowcook-ai/stack-solidity";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "lib", "out", "cache", "artifacts", "broadcast",
  "coverage", "dist", "build", ".brewing",
]);

/** Collect .sol files under repoRoot, skipping vendored + generated trees. */
export function findSolidityFiles(repoRoot: string, maxFiles = 2000): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (found.length >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable dir is not a reason to fail a map
    }
    for (const name of entries) {
      if (found.length >= maxFiles) return;
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (name.endsWith(".sol")) found.push(full);
    }
  };
  walk(repoRoot);
  return found.sort();
}

/**
 * Scan every Solidity file in the repo. Returns [] when there are none, so
 * callers can treat "no contracts" and "not a Solidity repo" identically.
 */
export function scanSolidityRepo(repoRoot: string): ContractEntry[] {
  const out: ContractEntry[] = [];
  for (const abs of findSolidityFiles(repoRoot)) {
    let src: string;
    try {
      src = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const rel = relative(repoRoot, abs).split(sep).join("/");
    try {
      out.push(...scanSolidityFile(src, rel));
    } catch {
      // One unparsable file must not sink the whole map.
      continue;
    }
  }
  return out;
}
