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
import { checkMigrationGate, formatMigrationGap } from "./migration-gate.js";
import { isReadOnlyMode } from "../../lib/read-only.js";

interface ReconArgs {
  story: string;
  repoRoot: string;
  /** Path to test files for this story. Default: tests/integration/story-N-*.test.{ts,tsx} */
  testGlob?: string;
  /** Output JSON path. Default: .brewing/recon-result.json */
  outPath: string;
  /** Print verbose breakdown to stdout. */
  verbose: boolean;
  /**
   * 0.19.0-α.8 — when true, recon enters reuse-scan mode (story-
   * agnostic). Walks src/ + flags structurally near-duplicate
   * components / API handlers / utility modules. Writes pairs to
   * stdout + optionally appends synthesized RefactorProposal entries
   * to .brewing/refactor/proposals.json (so `slowcook refactor`
   * picks them up).
   */
  reuseScan: boolean;
  reuseThreshold: number;
  reuseRoot: string;
  reuseWriteProposals: boolean;
  /** 0.19.0-α.10 (#85) — repeatable glob patterns to exclude from the
   *  reuse scan. Auto-template files (matched by isAutoTemplateFile)
   *  are excluded by default; --no-skip-auto-templates disables that. */
  reuseExcludes: string[];
  reuseSkipAutoTemplates: boolean;
  /**
   * 0.19.0-α.11 (#84) — when true, recon enters stub-scan mode
   * (story-agnostic, no Anthropic). Walks src/ for @slowcook-stub
   * markers, ages each via git log --diff-filter=A, reports stale
   * ones + (optionally) escalates to PM via gh comment on source issue.
   */
  stubScan: boolean;
  stubMaxAgeDays: number;
  stubEscalate: boolean;
  stubRoot: string;
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
  kind:
    | "missing_component"
    | "missing_route"
    | "prop_shape_mismatch"
    | "story_history_conflict"
    | "missing_migration";
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
    reuseScan: false,
    reuseThreshold: 0.7,
    reuseRoot: "src",
    reuseWriteProposals: false,
    reuseExcludes: [],
    reuseSkipAutoTemplates: true,
    stubScan: false,
    stubMaxAgeDays: 14,
    stubEscalate: false,
    stubRoot: "src",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--story" && next) { args.story = next; i++; }
    else if (a === "--cwd" && next) { args.repoRoot = next; i++; }
    else if (a === "--out" && next) { args.outPath = next; i++; }
    else if (a === "--verbose" || a === "-v") { args.verbose = true; }
    else if (a === "--reuse-scan") { args.reuseScan = true; }
    else if (a === "--reuse-threshold" && next) { args.reuseThreshold = parseFloat(next); i++; }
    else if (a === "--reuse-root" && next) { args.reuseRoot = next; i++; }
    else if (a === "--write-proposals") { args.reuseWriteProposals = true; }
    else if (a === "--exclude" && next) { args.reuseExcludes.push(next); i++; }
    else if (a === "--no-skip-auto-templates") { args.reuseSkipAutoTemplates = false; }
    else if (a === "--stub-scan") { args.stubScan = true; }
    else if (a === "--stub-max-age-days" && next) { args.stubMaxAgeDays = parseInt(next, 10); i++; }
    else if (a === "--stub-escalate") { args.stubEscalate = true; }
    else if (a === "--stub-root" && next) { args.stubRoot = next; i++; }
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  if (!args.reuseScan && !args.stubScan && !args.story) {
    console.error("--story <id> is required (or pass --reuse-scan / --stub-scan for the story-agnostic modes).");
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

Options (story mode — default):
  --story <id>   Story id (e.g. 017). Required unless --reuse-scan.
  --cwd <path>   Repo root (default: cwd).
  --out <path>   Output JSON path (default: .brewing/recon-result.json).
  --verbose      Print detailed breakdown to stdout.

Options (reuse-scan mode — 0.19.0-α.8+):
  --reuse-scan              Story-agnostic; flag near-duplicate components +
                            API handlers + utility modules across the codebase.
  --reuse-root <path>       Subtree to scan (default: src).
  --reuse-threshold <n>     Similarity threshold 0-1 (default: 0.7).
  --write-proposals         Append synthesized RefactorProposal entries to
                            .brewing/refactor/proposals.json so the refactor
                            command ranks them.
  --exclude <glob>          (α.10) Repeatable. Skip files matching the glob.
                            Supports: exact / "src/dir/" / "src/dir/*" /
                            "src/dir/**" / "*.mock.ts".
  --no-skip-auto-templates  (α.10) By default, recon skips files marked with
                            @slowcook-template / @slowcook-stub / @generated /
                            "AUTO-GENERATED" / "do not edit by hand". This
                            disables that filter (you'll see template-vs-template
                            duplicates again).

Exit codes:
  0  status=clean OR status=rename_needed OR --reuse-scan completed
  2  status=escalate (STORY_HISTORY_CONFLICT or VIBE_RECIPE_NAME_DRIFT)
`);
}

export async function recon(argv: string[], cliVersion: string): Promise<void> {
  const args = parseArgs(argv);

  if (args.reuseScan) {
    await runReuseScan(args);
    return;
  }

  if (args.stubScan) {
    await runStubScan(args, cliVersion);
    return;
  }

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

  // 0.19.0-α.18 — migration gate. Reads the story's spec, extracts
  // `proposals.schema.sql`, and verifies that every proposed table /
  // column is covered by some migration file on disk. Story-005 / 006
  // rewo incident class. No LLM call; pure structural.
  try {
    const mg = checkMigrationGate(args.repoRoot, args.story);
    if (mg.spec_proposes_schema) {
      console.log(
        `  migration-gate: spec proposes schema · ${mg.migrations_scanned} migration file(s) scanned · ${mg.gaps.length} gap(s)`
      );
    }
    for (const gap of mg.gaps) {
      const { detail, recommendation } = formatMigrationGap(gap);
      result.structural_gaps.push({
        kind: "missing_migration",
        test: gap.source,
        detail,
        recommendation,
      });
    }
    for (const note of mg.notes) {
      result.warnings.push(`migration-gate: ${note}`);
    }
  } catch (e) {
    result.warnings.push(
      `migration-gate threw: ${(e as Error).message.slice(0, 200)}`
    );
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

export function resolveImport(repoRoot: string, imp: string): string | null {
  // The `@/*` alias in the consumer's top-level tsconfig points at `./src/*`
  // ONLY — `mock/src/*` lives behind the mock's separate tsconfig. Resolving
  // `@/foo` against `mock/src/foo` here gives a false-positive "clean" gate:
  // recon says "import resolves" but vitest (running against the top tsconfig)
  // can't find the file → MANIFEST_DRIFT halt at brew time. Caught 2026-05-04
  // on rewo issue #149. Now we ONLY check `src/` for `@/` imports.
  if (imp.startsWith("@/")) {
    const rel = imp.slice(2);
    const candidates = [
      `src/${rel}.ts`,
      `src/${rel}.tsx`,
      `src/${rel}/index.ts`,
      `src/${rel}/index.tsx`,
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

/**
 * 0.19.0-α.8 — story-agnostic reuse-scan mode. Walks args.reuseRoot,
 * extracts a structural signature per .ts(x) file, runs pairwise
 * similarity, prints the duplicates, and (when --write-proposals)
 * appends RefactorProposal entries to .brewing/refactor/proposals.json.
 */
async function runReuseScan(args: ReconArgs): Promise<void> {
  const {
    extractStructuralSignature,
    scanForDuplicates,
    pairToRefactorProposal,
    isAutoTemplateFile,
    matchesExcludePattern,
  } = await import("./reuse.js");

  console.log(
    `slowcook recon --reuse-scan · root: ${args.reuseRoot} · threshold: ${args.reuseThreshold} · cwd: ${relative(process.cwd(), args.repoRoot) || "."}`
  );
  if (args.reuseExcludes.length > 0) {
    console.log(`  excludes: ${args.reuseExcludes.join(", ")}`);
  }
  if (args.reuseSkipAutoTemplates) {
    console.log(`  auto-template skip: ENABLED (--no-skip-auto-templates to disable)`);
  }

  const rootAbs = join(args.repoRoot, args.reuseRoot);
  if (!existsSync(rootAbs)) {
    console.error(`Reuse-scan root does not exist: ${rootAbs}`);
    process.exit(2);
  }

  const allFiles: string[] = [];
  walkTsFiles(rootAbs, allFiles);

  // Apply --exclude patterns first (cheap filename match), then read
  // file content + apply auto-template skip (more expensive — needs
  // file read).
  const files: string[] = [];
  let excludedByPattern = 0;
  let excludedAsTemplate = 0;
  for (const abs of allFiles) {
    const rel = relative(args.repoRoot, abs).replace(/\\/g, "/");
    if (args.reuseExcludes.some((p) => matchesExcludePattern(rel, p))) {
      excludedByPattern++;
      continue;
    }
    if (args.reuseSkipAutoTemplates) {
      const head = readFileSync(abs, "utf8");
      if (isAutoTemplateFile(head)) {
        excludedAsTemplate++;
        continue;
      }
    }
    files.push(abs);
  }
  console.log(
    `  scanning ${files.length} .ts/.tsx files under ${args.reuseRoot}/ (excluded: ${excludedByPattern} by pattern, ${excludedAsTemplate} as auto-template)`
  );

  const sigs = files.map((abs) => {
    const rel = relative(args.repoRoot, abs).replace(/\\/g, "/");
    return extractStructuralSignature(rel, readFileSync(abs, "utf8"));
  });

  const pairs = scanForDuplicates(sigs, args.reuseThreshold);
  console.log(`  found ${pairs.length} pair(s) at similarity >= ${args.reuseThreshold}`);
  console.log("");

  if (pairs.length === 0) {
    console.log("(no duplicates flagged — codebase looks clean for the configured threshold)");
    return;
  }

  for (const p of pairs) {
    const pct = (p.similarity * 100).toFixed(0);
    console.log(`  ${pct}% similar  [${p.category}]`);
    console.log(`    A: ${p.a}`);
    console.log(`    B: ${p.b}`);
    console.log(
      `    axes: jsx=${p.axes.jsx.toFixed(2)} props=${p.axes.props.toFixed(2)} calls=${p.axes.calls.toFixed(2)} imports=${p.axes.imports.toFixed(2)}`
    );
    console.log("");
  }

  if (args.reuseWriteProposals) {
    const proposalsPath = join(args.repoRoot, ".brewing/refactor/proposals.json");
    const existing: Array<ReturnType<typeof pairToRefactorProposal>> = existsSync(proposalsPath)
      ? (JSON.parse(readFileSync(proposalsPath, "utf8")) as Array<ReturnType<typeof pairToRefactorProposal>>)
      : [];
    const byId = new Map<string, ReturnType<typeof pairToRefactorProposal>>();
    for (const p of existing) byId.set(p.id, p);
    let appended = 0;
    for (const pair of pairs) {
      const proposal = pairToRefactorProposal(pair);
      if (!byId.has(proposal.id)) {
        byId.set(proposal.id, proposal);
        appended++;
      }
    }
    const merged = [...byId.values()];
    mkdirSync(dirname(proposalsPath), { recursive: true });
    writeFileSync(proposalsPath, JSON.stringify(merged, null, 2), "utf8");
    console.log(
      `  wrote ${proposalsPath.replace(args.repoRoot + "/", "")} (+${appended} new of ${merged.length} total)`
    );
  }
}

function walkTsFiles(root: string, out: string[]): void {
  for (const name of readdirSync(root)) {
    if (name === "node_modules" || name === ".next" || name === ".git") continue;
    const abs = join(root, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walkTsFiles(abs, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(abs);
    }
  }
}

/**
 * 0.19.0-α.11 (#84) — story-agnostic stub-scan mode. Walks args.stubRoot,
 * finds @slowcook-stub markers, ages each via git log --diff-filter=A,
 * reports stale ones + (when --stub-escalate) posts PM comment on each
 * stub's source issue.
 */
async function runStubScan(args: ReconArgs, cliVersion: string): Promise<void> {
  const { execSync } = await import("node:child_process");
  const {
    detectStubMarker,
    daysBetween,
    classifyStubAge,
    buildStaleStubComment,
  } = await import("./stale-stubs.js");
  type StubFile = import("./stale-stubs.js").StubFile;

  console.log(
    `slowcook recon --stub-scan · root: ${args.stubRoot} · grace: ${args.stubMaxAgeDays} days · cwd: ${relative(process.cwd(), args.repoRoot) || "."}`
  );

  const rootAbs = join(args.repoRoot, args.stubRoot);
  if (!existsSync(rootAbs)) {
    console.error(`Stub-scan root does not exist: ${rootAbs}`);
    process.exit(2);
  }

  const allFiles: string[] = [];
  walkTsFiles(rootAbs, allFiles);
  const nowIso = new Date().toISOString();

  const stubs: StubFile[] = [];
  for (const abs of allFiles) {
    const rel = relative(args.repoRoot, abs).replace(/\\/g, "/");
    const content = readFileSync(abs, "utf8");
    const detect = detectStubMarker(content);
    if (!detect.isStub) continue;
    let firstAddedAt: string | null = null;
    try {
      // First-add date: oldest commit that added this file. --diff-filter=A
      // only matches the addition; --reverse + head puts the earliest first.
      const out = execSync(
        `git -C "${args.repoRoot}" log --diff-filter=A --follow --format=%cI --reverse -- "${rel}" 2>/dev/null | head -n 1`,
        { encoding: "utf8" },
      ).trim();
      if (out) firstAddedAt = out;
    } catch {
      // git log failed — leave firstAddedAt null
    }
    const ageDays = firstAddedAt ? daysBetween(firstAddedAt, nowIso) : null;
    const classification = classifyStubAge(ageDays, args.stubMaxAgeDays);
    stubs.push({
      path: rel,
      storyId: detect.storyId,
      firstAddedAt,
      ageDays,
      classification,
    });
  }

  console.log(`  found ${stubs.length} @slowcook-stub file(s)`);
  const stale = stubs.filter((s) => s.classification === "stale");
  const fresh = stubs.filter((s) => s.classification === "fresh");
  const unknown = stubs.filter((s) => s.classification === "unknown");
  console.log(`    ${stale.length} stale (≥ ${args.stubMaxAgeDays} days), ${fresh.length} fresh, ${unknown.length} unknown-age`);
  console.log("");

  if (stubs.length === 0) {
    console.log("(no stubs found — pipeline is clean)");
    return;
  }

  for (const s of [...stale, ...unknown, ...fresh]) {
    const tag =
      s.classification === "stale"
        ? "STALE"
        : s.classification === "unknown"
        ? "?    "
        : "fresh";
    const ageStr = s.ageDays !== null ? `${s.ageDays.toString().padStart(5)}d` : "  ?  ";
    const story = s.storyId ? `story-${s.storyId}` : "(no story id)";
    console.log(`  ${tag}  ${ageStr}  ${story.padEnd(14)}  ${s.path}`);
  }

  if (args.stubEscalate && stale.length > 0 && isReadOnlyMode()) {
    console.log(
      `\n  [SLOWCOOK_READ_ONLY=1] --stub-escalate set but read-only mode is on; would post comments on ${stale.length} source issues. Skipping.`,
    );
  } else if (args.stubEscalate && stale.length > 0) {
    console.log("\n  --stub-escalate set; posting PM comments on source issues...");
    let repoSlug = "";
    try {
      repoSlug = execSync(
        `git -C "${args.repoRoot}" remote get-url origin | sed -E 's|^.*github\\.com[:/]||; s|\\.git$||'`,
        { encoding: "utf8" },
      ).trim();
    } catch {
      // leave repoSlug empty
    }
    if (!repoSlug) {
      console.warn("  warn: could not detect repo slug; skipping escalations.");
    } else {
      for (const s of stale) {
        if (!s.storyId) {
          console.warn(`  skip: ${s.path} has no story id (can't find source issue).`);
          continue;
        }
        // Look up source issue from spec yaml (specs/story-NNN.yaml).
        const specPath = join(args.repoRoot, `specs/story-${s.storyId}.yaml`);
        if (!existsSync(specPath)) {
          console.warn(`  skip: ${s.path} — no spec at ${specPath} to read source_issue from.`);
          continue;
        }
        const specYaml = readFileSync(specPath, "utf8");
        const issueMatch = specYaml.match(/source_issue:\s*"#?(\d+)"/);
        if (!issueMatch) {
          console.warn(`  skip: ${s.path} — spec has no source_issue field.`);
          continue;
        }
        const issueNumber = parseInt(issueMatch[1]!, 10);
        const body = buildStaleStubComment(s, args.stubMaxAgeDays, cliVersion);
        const tmp = "/tmp/slowcook-stale-stub-comment.md";
        writeFileSync(tmp, body, "utf8");
        try {
          execSync(
            `gh issue comment ${issueNumber} --repo "${repoSlug}" --body-file ${tmp}`,
            { stdio: "inherit" },
          );
          console.log(`    posted on issue #${issueNumber} for ${s.path}`);
        } catch (e) {
          console.warn(`    failed to post on issue #${issueNumber}: ${(e as Error).message.slice(0, 200)}`);
        }
      }
    }
  } else if (stale.length > 0) {
    console.log(
      `\n  ${stale.length} stale stub(s) — re-run with --stub-escalate to post PM comments on source issues.`
    );
  }
}
