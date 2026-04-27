/**
 * `slowcook port` — 0.16.0-α.8.
 *
 * Deterministic copy step from mock/ → src/. No LLM. Same input →
 * same output. Runs as a CI step before brew on the brew PR's branch.
 *
 * Walks `mock/src/components/` + `mock/src/app/`, copies each file to
 * the mirrored src/ path, applying small import + hook rewrites so the
 * production component reads via `@/lib/data#useDataDomain` instead of
 * the mock-runtime hook. Brew (α.9) writes the actual data layer.
 *
 * Excluded from the copy: `mock/scenarios/`, `mock/src/lib/scenario-
 * registry.ts`, anything mock-only infrastructure.
 *
 * What "deterministic" buys us: the diff is auditable in the PR, brew
 * has a clear scope (anything outside src/lib/data + src/app/api +
 * supabase/migrations is off-limits), and a future tooling pass could
 * re-run port to detect drift.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { transformForPort, mockPathToSrcPath } from "./transform.js";

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
slowcook port — deterministic mock → src copy (0.16-α.8)

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
  --force            Overwrite existing src/ files even if they don't
                     carry the @slowcook-port-from marker. Default: refuse
                     so a hand-edited file isn't accidentally clobbered.

What's NOT ported:
  mock/scenarios/                       (scenario fixtures — mock-only)
  mock/src/lib/scenario-registry.ts     (consumer-managed)
  mock/Dockerfile, mock/package.json    (mock-app shell — mock-only)

What's transformed:
  import { useScenarioFixture } from "@slowcook-ai/mock-runtime";
    →  import { useDataDomain } from "@/lib/data";
  useScenarioFixture<T>("domain")
    →  useDataDomain<T>("domain")
  // @slowcook-mock-only lines stripped
  port-provenance header prepended (// @slowcook-port-from mock/ (story-N))

Exit codes:
  0  success (or dry-run completed; or no files to port)
  2  refusing to overwrite a non-port file (use --force)
`);
}

interface PlannedAction {
  src: string;
  dest: string;
  kind: "create" | "update" | "no-op" | "blocked";
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
    const { output, rewrites } = transformForPort(inputBody, { storyId: args.story });
    void output; // populated below in writePhase
    actions.push(buildPlanned(args.repoRoot, relMockPath, destRel, inputBody, rewrites, args.force, args.story));
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

  // 0.16.0-α.8 — refuse if any action is blocked. Better to surface
  // the conflict than overwrite a hand-edited production file.
  const blocked = actions.filter((a) => a.kind === "blocked");
  if (blocked.length > 0) {
    console.error(
      `\nRefusing to port: ${blocked.length} file(s) at the destination ` +
        `path don't carry the @slowcook-port-from marker. Pass --force to overwrite, ` +
        `or hand-merge first.`
    );
    process.exit(2);
  }

  let written = 0;
  let unchanged = 0;
  for (const a of actions) {
    if (a.kind === "no-op") { unchanged += 1; continue; }
    const inputBody = readFileSync(join(args.repoRoot, a.src), "utf8");
    const { output } = transformForPort(inputBody, { storyId: args.story });
    const destAbs = join(args.repoRoot, a.dest);
    mkdirSync(dirname(destAbs), { recursive: true });
    writeFileSync(destAbs, output, "utf8");
    written += 1;
  }
  console.log(`\nDone. ${written} file(s) written; ${unchanged} unchanged.`);
}

function buildPlanned(
  repoRoot: string,
  src: string,
  dest: string,
  inputBody: string,
  rewrites: string[],
  force: boolean,
  story: string
): PlannedAction {
  const destAbs = join(repoRoot, dest);
  const { output } = transformForPort(inputBody, { storyId: story });
  const destExists = existsSync(destAbs);
  if (!destExists) {
    return { src, dest, kind: "create", rewrites };
  }
  const existing = readFileSync(destAbs, "utf8");
  if (existing === output) {
    return { src, dest, kind: "no-op", rewrites: [] };
  }
  // Allow overwrite when the existing file is a previously-ported file
  // (carries the marker) OR --force is set.
  if (existing.includes("@slowcook-port-from") || force) {
    return { src, dest, kind: "update", rewrites };
  }
  return {
    src,
    dest,
    kind: "blocked",
    rewrites: [],
    reason:
      "destination file exists, doesn't carry @slowcook-port-from marker, --force not set",
  };
}

function printAction(a: PlannedAction): void {
  const tag =
    a.kind === "create" ? "CREATE" :
    a.kind === "update" ? "UPDATE" :
    a.kind === "blocked" ? "BLOCK " :
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
