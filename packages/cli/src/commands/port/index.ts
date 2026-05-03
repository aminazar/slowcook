/**
 * `slowcook port` — deterministic mock → src copy step.
 *
 * Runs as a CI step before brew on the brew PR's branch. No LLM.
 * Same input → same output.
 *
 * Walks `mock/src/components/` + `mock/src/app/`, copies each file to
 * the mirrored src/ path, applying small import + hook rewrites so the
 * production component reads via `@/lib/data#useDataDomain` instead of
 * the mock-runtime hook. Brew writes the actual data layer.
 *
 * Excluded from the copy:
 *   - mock/scenarios/, mock/src/lib/scenario-registry* (mock-only infra)
 *   - any mock file with a `@slowcook-port-skip` marker in its first
 *     20 lines (file-level opt-out for shims like mock-emotions.ts)
 *
 * Conflict resolution at the destination (no abort, no hardcoded
 * exclusions for layout.tsx / page.tsx / globals.css):
 *   - destination missing                    → CREATE
 *   - destination matches our output         → NO-OP
 *   - destination has @slowcook-port-from    → UPDATE
 *   - destination is hand-written (no marker)→ SKIP with notice
 *     (consumer's prod file is the source of truth; --force to override)
 *
 * What "deterministic" buys us: the diff is auditable in the PR, brew
 * has a clear scope, and a future tooling pass could re-run port to
 * detect drift.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { transformForPort, mockPathToSrcPath, isMockOnlyFile } from "./transform.js";

interface PortArgs {
  story: string;
  repoRoot: string;
  /** Skip writes; print planned diffs only. */
  dryRun: boolean;
  /** Override existing src/ files even if a non-marker file exists there. Default: refuse. */
  force: boolean;
}

function parseArgs(argv: string[]): PortArgs {
  const args: PortArgs = {
    story: "",
    repoRoot: process.cwd(),
    dryRun: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--story" && next) { args.story = next; i++; }
    else if (a === "--cwd" && next) { args.repoRoot = next; i++; }
    else if (a === "--dry-run") { args.dryRun = true; }
    else if (a === "--force") { args.force = true; }
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  if (!args.story) {
    console.error("--story <id> is required.");
    printHelp();
    process.exit(64);
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook port — deterministic mock → src copy

Walks mock/src/components/ + mock/src/app/, copies each file to the
mirrored src/ path, and applies small import + hook rewrites so the
production component reads from @/lib/data#useDataDomain instead of
the mock-runtime hook. No LLM; same input → same output.

Usage:
  slowcook port --story <id> [--cwd <path>] [--dry-run] [--force]

Options:
  --story <id>       Story id (e.g. 017). Used in the port-provenance header.
  --cwd <path>       Repo root (default: cwd).
  --dry-run          Print planned actions; don't write.
  --force            Overwrite hand-written src/ files (no @slowcook-port-from
                     marker). Default: skip them and log a notice — the
                     consumer's hand-written file wins.

What's NOT ported:
  mock/scenarios/                          (scenario fixtures — mock-only)
  mock/src/lib/scenario-registry*          (consumer-managed)
  any file containing @slowcook-port-skip  (file-level opt-out marker;
                                            use for mock-only shims)

What's transformed:
  import { useScenarioFixture } from "@slowcook-ai/mock-runtime";
    →  import { useDataDomain } from "@/lib/data";
  useScenarioFixture<T>("domain")
    →  useDataDomain<T>("domain")
  // @slowcook-mock-only lines stripped
  port-provenance header prepended (// @slowcook-port-from mock/ (story-N))

Conflict resolution (no abort):
  destination missing                       →  CREATE
  destination identical to our output       →  NO-OP
  destination has @slowcook-port-from       →  UPDATE
  destination is hand-written (no marker)   →  SKIP (--force overrides)

Exit code: always 0 unless an unexpected I/O error occurs.
`);
}

type ActionKind = "create" | "update" | "no-op" | "skip-mock-only" | "skip-handwritten";

interface PlannedAction {
  src: string;
  dest: string;
  kind: ActionKind;
  rewrites: string[];
  reason?: string;
}

export async function port(argv: string[], _cliVersion: string): Promise<void> {
  const args = parseArgs(argv);
  const mockSrcDir = join(args.repoRoot, "mock/src");
  if (!existsSync(mockSrcDir)) {
    console.log(
      `No mock/src/ directory at ${mockSrcDir}. Run \`slowcook init mock\` first; nothing to port.`
    );
    return;
  }

  const files = walkFiles(mockSrcDir);
  const actions: PlannedAction[] = [];
  for (const absPath of files) {
    const relMockPath = relative(args.repoRoot, absPath).replace(/\\/g, "/");
    const destRel = mockPathToSrcPath(relMockPath);
    if (!destRel) continue;
    const inputBody = readFileSync(absPath, "utf8");
    actions.push(buildPlanned(args.repoRoot, relMockPath, destRel, inputBody, args.force, args.story));
  }

  if (actions.length === 0) {
    console.log("Nothing to port (no eligible mock/src/ files).");
    return;
  }

  console.log(`slowcook port · story-${args.story} · cwd: ${relative(process.cwd(), args.repoRoot) || "."}`);
  for (const a of actions) printAction(a);

  if (args.dryRun) {
    console.log("\n--dry-run: no files written.");
    return;
  }

  let written = 0;
  let unchanged = 0;
  let skippedHandwritten = 0;
  let skippedMockOnly = 0;
  for (const a of actions) {
    if (a.kind === "no-op") { unchanged += 1; continue; }
    if (a.kind === "skip-handwritten") { skippedHandwritten += 1; continue; }
    if (a.kind === "skip-mock-only") { skippedMockOnly += 1; continue; }
    const inputBody = readFileSync(join(args.repoRoot, a.src), "utf8");
    const { output } = transformForPort(inputBody, { storyId: args.story });
    const destAbs = join(args.repoRoot, a.dest);
    mkdirSync(dirname(destAbs), { recursive: true });
    writeFileSync(destAbs, output, "utf8");
    written += 1;
  }
  const skipNotes: string[] = [];
  if (skippedHandwritten > 0) {
    skipNotes.push(`${skippedHandwritten} skipped (hand-written prod file — pass --force to override)`);
  }
  if (skippedMockOnly > 0) {
    skipNotes.push(`${skippedMockOnly} skipped (@slowcook-port-skip)`);
  }
  const tail = skipNotes.length > 0 ? "; " + skipNotes.join("; ") : "";
  console.log(`\nDone. ${written} file(s) written; ${unchanged} unchanged${tail}.`);
}

function buildPlanned(
  repoRoot: string,
  src: string,
  dest: string,
  inputBody: string,
  force: boolean,
  story: string
): PlannedAction {
  // File-level opt-out: mock-only shims (e.g. mock/src/lib/mock-emotions.ts)
  // tagged with @slowcook-port-skip never write to src/.
  if (isMockOnlyFile(inputBody)) {
    return {
      src,
      dest,
      kind: "skip-mock-only",
      rewrites: [],
      reason: "file marked @slowcook-port-skip (mock-only shim)",
    };
  }

  const destAbs = join(repoRoot, dest);
  const { output, rewrites } = transformForPort(inputBody, { storyId: story });
  const destExists = existsSync(destAbs);
  if (!destExists) {
    return { src, dest, kind: "create", rewrites };
  }
  const existing = readFileSync(destAbs, "utf8");
  if (existing === output) {
    return { src, dest, kind: "no-op", rewrites: [] };
  }
  // Update only if the existing file is a previously-ported file
  // (carries the marker) OR --force is set. Otherwise skip — the
  // consumer's hand-written file is the source of truth.
  if (existing.includes("@slowcook-port-from") || force) {
    return { src, dest, kind: "update", rewrites };
  }
  return {
    src,
    dest,
    kind: "skip-handwritten",
    rewrites: [],
    reason:
      "destination is hand-written (no @slowcook-port-from marker); skipping. Use --force to overwrite.",
  };
}

function printAction(a: PlannedAction): void {
  const tag =
    a.kind === "create" ? "CREATE" :
    a.kind === "update" ? "UPDATE" :
    a.kind === "skip-handwritten" ? "SKIP  " :
    a.kind === "skip-mock-only" ? "SKIP  " :
    "NO-OP ";
  console.log(`  ${tag}  ${a.src}  →  ${a.dest}`);
  if (a.reason) console.log(`         ${a.reason}`);
  for (const r of a.rewrites) console.log(`         · ${r}`);
}

function walkFiles(dir: string, acc: string[] = []): string[] {
  const entries = readdirSync(dir);
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkFiles(full, acc);
    } else if (/\.(tsx?|jsx?)$/.test(name)) {
      acc.push(full);
    }
  }
  return acc;
}
