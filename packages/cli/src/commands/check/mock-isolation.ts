/**
 * `slowcook check mock-isolation` — 0.16.0-α.13.
 *
 * Static structural check: every TypeScript file under `mock/src/` and
 * `mock/scenarios/` must only import from:
 *
 *   - npm packages (anything not starting with "." or "/" or "@/")
 *   - relative paths that stay inside mock/ (`./`, `../` that don't escape)
 *   - the `@/` alias (which resolves to mock/src/, NOT the consumer's
 *     production src/) — and the resolved target file must exist
 *
 * Specifically REJECTS:
 *
 *   - `@/` imports that resolve to a path NOT present in mock/src/
 *     (e.g. vibe writing `import { X } from "@/lib/emotions"` when
 *     emotions only exists in the consumer's production `src/lib/`)
 *   - Relative parent-traversal imports that escape `mock/`
 *
 * Why a hard check: vibe's prompt includes a "DO NOT cross-import"
 * rule (slowcook 0.16.0-α.12), but prompts are soft signals. A real
 * structural check fails CI on slippage and gives the architecture's
 * "two filesystems" rule a teeth-bearing enforcement.
 *
 * The check runs in two contexts:
 *
 *   - Locally via `slowcook check mock-isolation [--cwd <path>]`
 *   - Inside the `slowcook-vibe.yml` workflow as a post-emit step
 *     (so vibe's PR fails if the LLM regresses and pushes a bad
 *     import)
 *
 * Pure-disk check; no LLM. No tsc dependency. Regex + readFileSync.
 */

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";

export interface MockIsolationViolation {
  file: string;
  line: number;
  importPath: string;
  reason: string;
}

export interface MockIsolationResult {
  violations: MockIsolationViolation[];
  filesChecked: number;
}

/**
 * Run the check. Returns the list of violations + how many files were
 * scanned. Empty violations array = clean.
 */
export function runMockIsolationCheck(repoRoot: string): MockIsolationResult {
  const mockDir = join(repoRoot, "mock");
  if (!existsSync(mockDir)) {
    return { violations: [], filesChecked: 0 };
  }

  const violations: MockIsolationViolation[] = [];
  const files = walkTsFiles(mockDir);

  for (const absFile of files) {
    const body = readFileSync(absFile, "utf8");
    const fileViolations = checkFile(absFile, body, repoRoot, mockDir);
    violations.push(...fileViolations);
  }

  return { violations, filesChecked: files.length };
}

/**
 * Inspect one file's import statements. Returns violations.
 */
export function checkFile(
  absFile: string,
  body: string,
  repoRoot: string,
  mockRoot: string
): MockIsolationViolation[] {
  const violations: MockIsolationViolation[] = [];
  const relFile = relative(repoRoot, absFile).replace(/\\/g, "/");
  const dir = dirname(absFile);

  // Match import statements. Single-line; covers:
  //   import { X } from "..."
  //   import X from "..."
  //   import "..."
  //   import * as X from "..."
  // NOT covered: dynamic import() calls (rare in vibe output; can be
  // added later if dogfood shows misses).
  const importRe = /^\s*import\s+(?:[^"';]+\s+from\s+)?["']([^"']+)["']/gm;

  // Track line number per match
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^\s*import\s+(?:[^"';]+\s+from\s+)?["']([^"']+)["']/);
    if (!m) continue;
    const importPath = m[1]!;

    // npm package import — anything not starting with `.` or `/` or `@/`
    // Note: `@scope/pkg` is npm; `@/foo` is the project alias.
    if (
      !importPath.startsWith(".") &&
      !importPath.startsWith("/") &&
      !importPath.startsWith("@/")
    ) {
      // npm package — fine
      continue;
    }

    // `@/` alias check — must resolve to a file inside mock/src/
    if (importPath.startsWith("@/")) {
      const aliasPath = importPath.slice(2); // strip "@/"
      const candidate = join(mockRoot, "src", aliasPath);
      if (!resolveExists(candidate)) {
        violations.push({
          file: relFile,
          line: i + 1,
          importPath,
          reason: `\`@/\` resolves to mock/src/${aliasPath}, which doesn't exist. The mock has no access to the consumer's production src/. Inline what you need OR write a file at mock/src/${aliasPath}.`,
        });
      }
      continue;
    }

    // Relative import (./, ../) — must not escape mock/
    if (importPath.startsWith(".")) {
      const candidate = join(dir, importPath);
      const resolved = resolve(candidate);
      const mockAbs = resolve(mockRoot);
      if (!resolved.startsWith(mockAbs + "/") && resolved !== mockAbs) {
        violations.push({
          file: relFile,
          line: i + 1,
          importPath,
          reason: `Relative import escapes mock/. The mock is a separate filesystem; cannot reach the consumer's production code.`,
        });
        continue;
      }
      // Existence check (for `.ts` / `.tsx` / `.js` / `.jsx`)
      if (!resolveExists(candidate)) {
        violations.push({
          file: relFile,
          line: i + 1,
          importPath,
          reason: `Relative import resolves to a non-existent file (no .ts/.tsx/.js/.jsx + no /index variant found at ${relative(repoRoot, candidate)}).`,
        });
      }
      continue;
    }

    // Absolute path import (`/foo`) — almost always wrong
    violations.push({
      file: relFile,
      line: i + 1,
      importPath,
      reason: `Absolute-path import. Use relative path or @/ alias.`,
    });
  }
  // Unused but kept for clarity that the regex can be tightened later:
  void importRe;

  return violations;
}

function resolveExists(candidate: string): boolean {
  // Try the literal candidate first.
  if (existsSync(candidate)) {
    if (statSync(candidate).isFile()) return true;
    // Directory — try /index.{ts,tsx,js,jsx}
    for (const ext of ["ts", "tsx", "js", "jsx"]) {
      if (existsSync(join(candidate, `index.${ext}`))) return true;
    }
  }
  // Try with each TypeScript / JavaScript extension appended.
  for (const ext of ["ts", "tsx", "js", "jsx", "mts", "cts"]) {
    if (existsSync(`${candidate}.${ext}`)) return true;
  }
  return false;
}

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (name === "node_modules") continue;
    if (name === ".next") continue;
    if (name === "dist") continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      walkTsFiles(full, acc);
    } else if (/\.(tsx?|mts|cts)$/.test(name)) {
      acc.push(full);
    }
  }
  return acc;
}
