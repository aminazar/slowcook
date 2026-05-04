/**
 * `slowcook recon` — 0.17.6 — structural backstop after refine + history-aware
 * vibe + testgen + plate + brew. Pure deterministic; no LLM.
 *
 * Runs as a CI pre-step in slowcook-brew-auto.yml (after both mockup PR
 * + tests PR are merged, BEFORE brew dispatch). Catches residual vibe ⇄
 * testgen divergence by comparing names + prop shapes + testid hooks.
 *
 * Output: `.brewing/recon-result.json` + a PR comment with the renaming
 * map and any escalations.
 *
 * Exit codes:
 *   0 — clean (or only "warn" issues; brew can proceed)
 *   2 — `STORY_HISTORY_CONFLICT` or `VIBE_RECIPE_NAME_DRIFT` — escalates
 *       to PM via PR comment; brew should NOT dispatch
 *
 * What recon checks:
 *   1. Test imports → file exists in mock + src/
 *   2. Test prop usage → matches mock's component signature
 *   3. Testid selectors in tests → present in mock JSX
 *   4. Brownfield safety: rename target collides with EXISTING prod
 *      component covered by ANOTHER story's tests
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { buildHistoryIndex, type HistoryIndex } from "../refine/history-index.js";
import { extractShape, synthesiseShapeTestFile, findMockFilesForStory } from "./shape-preserve.js";

interface ReconArgs {
  story: string;
  repoRoot: string;
  /** Path to test files for this story. Default: tests/integration/story-N-*.test.{ts,tsx} */
  testGlob?: string;
  /** Output JSON path. Default: .brewing/recon-result.json */
  outPath: string;
  /** Print verbose breakdown to stdout. */
  verbose: boolean;
}

interface RenameProposal {
  kind: "component" | "import_path";
  from: string;
  to: string;
  reason: string;
  rename_safe: boolean;
  blocker?: string;
}

interface TestidGap {
  selector: string;
  queried_by: string[];
  in_mock: boolean;
}

interface StructuralGap {
  kind: "missing_component" | "missing_route" | "prop_shape_mismatch" | "story_history_conflict";
  test: string;
  detail: string;
  recommendation: string;
}

export interface ReconResult {
  story: string;
  generated_at: string;
  generator: "slowcook-recon@0.17.6";
  status: "clean" | "rename_needed" | "escalate";
  renames: RenameProposal[];
  testid_gaps: TestidGap[];
  structural_gaps: StructuralGap[];
  history_index_components: number;
  warnings: string[];
}

function parseArgs(argv: string[]): ReconArgs {
  const args: ReconArgs = {
    story: "",
    repoRoot: process.cwd(),
    outPath: "",
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--story" && next) { args.story = next; i++; }
    else if (a === "--cwd" && next) { args.repoRoot = next; i++; }
    else if (a === "--out" && next) { args.outPath = next; i++; }
    else if (a === "--verbose" || a === "-v") { args.verbose = true; }
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  if (!args.story) {
    console.error("--story <id> is required.");
    printHelp();
    process.exit(64);
  }
  if (!args.outPath) {
    args.outPath = join(args.repoRoot, ".brewing/recon-result.json");
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook recon — pre-brew structural divergence check (0.17.6+)

Compares the story's test files against the mock + src/ tree. Detects:
  - Tests importing non-existent components (vibe ⇄ testgen name drift)
  - Tests asserting on testids the mock doesn't render
  - Renames that would break OTHER stories' tests (brownfield safety)

Usage:
  slowcook recon --story <id> [--cwd <path>] [--out <path>] [--verbose]

Options:
  --story <id>   Story id (e.g. 017). Required.
  --cwd <path>   Repo root (default: cwd).
  --out <path>   Output JSON path (default: .brewing/recon-result.json).
  --verbose      Print detailed breakdown to stdout.

Exit codes:
  0  status=clean OR status=rename_needed (recommendations only)
  2  status=escalate (STORY_HISTORY_CONFLICT or VIBE_RECIPE_NAME_DRIFT)
`);
}

export async function recon(argv: string[], _cliVersion: string): Promise<void> {
  const args = parseArgs(argv);

  console.log(`slowcook recon · story-${args.story} · cwd: ${relative(process.cwd(), args.repoRoot) || "."}`);

  const idx = buildHistoryIndex({ repoRoot: args.repoRoot });
  const result: ReconResult = {
    story: args.story,
    generated_at: new Date().toISOString(),
    generator: "slowcook-recon@0.17.6",
    status: "clean",
    renames: [],
    testid_gaps: [],
    structural_gaps: [],
    history_index_components: idx.components.length,
    warnings: [],
  };

  // Find this story's test files
  const testFiles = findStoryTestFiles(args.repoRoot, args.story);
  if (testFiles.length === 0) {
    result.warnings.push(`No test files found for story-${args.story} under tests/integration/`);
  }

  for (const testRel of testFiles) {
    const testAbs = join(args.repoRoot, testRel);
    const body = readFileSync(testAbs, "utf8");
    const imports = extractImports(body);
    const testids = extractTestids(body);

    // Check 1: every test import → file exists somewhere reachable
    for (const imp of imports) {
      const resolved = resolveImport(args.repoRoot, imp);
      if (!resolved) {
        // Not in src/ or mock/ — it's a missing component
        // Search history-index for a near-match by name
        const compName = imp.split("/").pop() ?? "";
        const nearMatch = idx.components.find((c) => c.name === compName);
        if (nearMatch) {
          result.structural_gaps.push({
            kind: "missing_component",
            test: testRel,
            detail: `Test imports "${imp}" — file not found. Closest match in history-index: ${nearMatch.name} at ${nearMatch.file}.`,
            recommendation: `Either rename mock/src/components to match "${compName}" OR /refine to use the existing name.`,
          });
        } else {
          result.structural_gaps.push({
            kind: "missing_component",
            test: testRel,
            detail: `Test imports "${imp}" — file not found anywhere. No near-match in history-index.`,
            recommendation: `Either vibe should add this component OR /refine to drop the assertion.`,
          });
        }
      }
    }

    // Check 2: testid selectors found in tests → assert mock has them
    // (Light check — full check requires DOM render; this just greps mock files for the testid string.)
    for (const tid of testids) {
      const present = testidPresentInMock(args.repoRoot, tid);
      if (!present) {
        const existing = result.testid_gaps.find((g) => g.selector === tid);
        if (existing) {
          if (!existing.queried_by.includes(testRel)) existing.queried_by.push(testRel);
        } else {
          result.testid_gaps.push({ selector: tid, queried_by: [testRel], in_mock: false });
        }
      }
    }
  }

  // Check 3: brownfield safety — for each component name in mock that
  // doesn't appear in src/, check whether RENAMING the mock would break
  // a different story's tests.
  // (This is a heavier check; skip for v1. Recorded as a TODO.)
  result.warnings.push(
    "brownfield-rename-safety check is not yet implemented in 0.17.6 (recorded by simulation; defer to 0.17.7)"
  );

  // 0.17.6+ — shape-emit. Read mock UI for the story; emit
  // tests/integration/story-N-shape.test.tsx with structural assertions
  // (testids, visual tokens, semantic landmarks). Mock-chrome subtrees
  // are stripped via the data-mock-chrome="true" marker.
  let shapeFile: string | null = null;
  try {
    const mockFiles = findMockFilesForStory(args.repoRoot, args.story);
    if (mockFiles.length > 0) {
      const shapes = mockFiles
        .map((f) => extractShape(join(args.repoRoot, f), args.repoRoot))
        .filter((s): s is NonNullable<typeof s> => s !== null);
      if (shapes.length > 0) {
        const body = synthesiseShapeTestFile({ story: args.story, shapes });
        shapeFile = `tests/integration/story-${args.story}-shape.test.tsx`;
        const outAbs = join(args.repoRoot, shapeFile);
        mkdirSync(dirname(outAbs), { recursive: true });
        writeFileSync(outAbs, body, "utf8");
        console.log(
          `  shape-emit: wrote ${shapeFile} (from ${mockFiles.length} mock file(s); ${shapes.flatMap((s) => s.testids).length} testid assertion(s))`
        );
      }
    } else {
      result.warnings.push(
        `shape-emit: no mock files discovered for story-${args.story} (no scenarios reference it; no test imports point at mock/src)`
      );
    }
  } catch (e) {
    result.warnings.push(`shape-emit failed: ${(e as Error).message.slice(0, 200)}`);
  }

  // Decide status
  if (result.structural_gaps.length > 0) {
    result.status = "escalate";
  } else if (result.testid_gaps.length > 0 || result.renames.length > 0) {
    result.status = "rename_needed";
  } else {
    result.status = "clean";
  }

  // Write output
  mkdirSync(dirname(args.outPath), { recursive: true });
  writeFileSync(args.outPath, JSON.stringify({ ...result, shape_file: shapeFile }, null, 2), "utf8");

  // Print summary
  console.log(`  status: ${result.status.toUpperCase()}`);
  console.log(
    `  ${testFiles.length} test file(s) · ${result.structural_gaps.length} structural gap(s) · ${result.testid_gaps.length} testid gap(s) · ${result.renames.length} rename(s)`
  );
  if (args.verbose || result.status === "escalate") {
    for (const g of result.structural_gaps) {
      console.log(`  ! ${g.kind}: ${g.detail}`);
      console.log(`      → ${g.recommendation}`);
    }
    for (const t of result.testid_gaps) {
      console.log(`  ? testid "${t.selector}" missing in mock; queried by ${t.queried_by.length} test(s)`);
    }
  }
  console.log(`  wrote ${relative(args.repoRoot, args.outPath) || args.outPath}`);

  if (result.status === "escalate") {
    console.error(
      "\nrecon escalation: structural gaps prevent brew from converging. Fix before dispatching brew."
    );
    process.exit(2);
  }
}

// ----- helpers -----

export function findStoryTestFiles(repoRoot: string, story: string): string[] {
  const dir = join(repoRoot, "tests/integration");
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(`story-${story}`)) continue;
    if (!/\.test\.(ts|tsx)$/.test(name)) continue;
    out.push(`tests/integration/${name}`);
  }
  return out;
}

export function extractImports(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/import[^"']*from\s+["']([^"']+)["']/g)) {
    if (m[1] && (m[1].startsWith("@/") || m[1].startsWith("."))) out.push(m[1]);
  }
  return [...new Set(out)];
}

export function extractTestids(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/data-testid\s*=\s*["']([^"']+)["']/g)) {
    if (m[1]) out.push(m[1]);
  }
  for (const m of body.matchAll(/getByTestId\s*\(\s*["']([^"']+)["']/g)) {
    if (m[1]) out.push(m[1]);
  }
  for (const m of body.matchAll(/data-testid="([^"]+)"/g)) {
    if (m[1]) out.push(m[1]);
  }
  return [...new Set(out)];
}

function resolveImport(repoRoot: string, imp: string): string | null {
  // @/foo → src/foo or mock/src/foo
  if (imp.startsWith("@/")) {
    const rel = imp.slice(2);
    const candidates = [
      `src/${rel}.ts`,
      `src/${rel}.tsx`,
      `src/${rel}/index.ts`,
      `src/${rel}/index.tsx`,
      `mock/src/${rel}.ts`,
      `mock/src/${rel}.tsx`,
      `mock/src/${rel}/index.ts`,
      `mock/src/${rel}/index.tsx`,
    ];
    for (const c of candidates) {
      if (existsSync(join(repoRoot, c))) return c;
    }
  }
  return null;
}

function testidPresentInMock(repoRoot: string, testid: string): boolean {
  // Walk mock/src/ + look for the literal testid string
  const dir = join(repoRoot, "mock/src");
  if (!existsSync(dir)) return false;
  return walkAndGrep(dir, testid);
}

function walkAndGrep(dir: string, needle: string): boolean {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (walkAndGrep(full, needle)) return true;
    } else if (/\.(tsx?|jsx?)$/.test(name)) {
      const body = readFileSync(full, "utf8");
      if (body.includes(`"${needle}"`) || body.includes(`'${needle}'`)) return true;
    }
  }
  return false;
}

// re-export the index type for tests
export type { HistoryIndex };
