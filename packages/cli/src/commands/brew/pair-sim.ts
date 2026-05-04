/**
 * `slowcook brew --pair-sim` — local-only pair-brew simulator.
 *
 * Self-contained orchestration of driver + navigator agents using the
 * Anthropic API directly. Skips the production brew agent's tool-use
 * loop in favour of a "driver returns JSON describing files to write"
 * shape — much simpler to wire than the full tool protocol, and good
 * enough to validate the pair dynamics empirically.
 *
 * Per iteration:
 *   1. DRIVER reads spec + tests + mock + history → returns JSON
 *      { rationale, files: [{path, content}], halt? }.
 *   2. Apply files to disk; compute git diff.
 *   3. NAVIGATOR reads diff + mock + code-map digest + tests + history
 *      → returns NavigatorVerdict JSON.
 *   4. If verdict.overall === "block": revert files, fold concerns into
 *      next iter's history, continue.
 *   5. Else: run vitest on the story tests. If green + no cross-story
 *      regression: SUCCESS. If story tests fail: history.failures →
 *      next iter. If cross-story regression: revert + log.
 *   6. Halt at max-iters.
 *
 * Output: per-iter transcript to stdout; final summary written to
 * .brewing/pair-sim/<story-id>-<timestamp>.json.
 *
 * Requires: ANTHROPIC_API_KEY in env. Run from the consumer's repo root.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { execSync } from "node:child_process";
import {
  AnthropicClient,
  NAVIGATOR_SYSTEM,
  buildNavigatorPrompt,
  type NavigatorVerdict,
} from "@slowcook-ai/llm-anthropic";

interface Args {
  storyId: string;
  repoRoot: string;
  maxIters: number;
  model: string;
  budgetUsd: number;
  outPath: string;
}

interface DriverOutput {
  rationale: string;
  files?: Array<{ path: string; content: string }>;
  halt?: { reason: string };
}

interface IterRecord {
  iter: number;
  driverRationale: string;
  filesTouched: string[];
  navigatorVerdict: NavigatorVerdict;
  outcome: "blocked" | "tests-failing" | "cross-story-regression" | "success";
  testFailureFirst?: string;
  crossStoryFailures?: string[];
  driverCostUsd: number;
  navigatorCostUsd: number;
}

const MAX_FILE_BYTES = 8000;
const MAX_DIFF_BYTES = 30000;

function parseArgs(argv: string[]): Args {
  const args: Args = {
    storyId: "",
    repoRoot: process.cwd(),
    maxIters: 5,
    model: "claude-sonnet-4-5-20250929",
    budgetUsd: 5,
    outPath: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--story" && next) { args.storyId = next; i++; }
    else if (a === "--cwd" && next) { args.repoRoot = next; i++; }
    else if (a === "--max-iters" && next) { args.maxIters = parseInt(next, 10); i++; }
    else if (a === "--model" && next) { args.model = next; i++; }
    else if (a === "--budget-usd" && next) { args.budgetUsd = parseFloat(next); i++; }
    else if (a === "--out" && next) { args.outPath = next; i++; }
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  if (!args.storyId) { console.error("--story <id> is required"); printHelp(); process.exit(64); }
  if (!args.outPath) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    args.outPath = join(args.repoRoot, `.brewing/pair-sim/story-${args.storyId}-${ts}.json`);
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook brew --pair-sim — local pair-brew simulator (cli α.8 prototype)

Usage:
  slowcook brew --pair-sim --story <id> [options]

Options:
  --cwd <path>          Repo root (default: cwd).
  --max-iters <n>       Iteration cap (default: 5).
  --model <id>          Anthropic model id (default: claude-sonnet-4-5).
  --budget-usd <n>      Token-spend cap (default: 5).
  --out <path>          JSON summary output path.

Requires: ANTHROPIC_API_KEY in env.

Per iter ~$0.10–0.20 (driver + navigator). Bound iterations + budget
appropriately. Output JSON has full transcript for post-hoc analysis.
`);
}

const DRIVER_SYSTEM = `You are the brewing DRIVER in a pair-programming session with a navigator.

Your job: write prod code that makes every test in the story manifest pass. The navigator reviews each iteration and may BLOCK (revert your iteration) or WARN. Their reward is "is this sensible?", yours is "do tests pass?". Trust them but argue when you have a reason.

You have NO tool-use surface. Each iteration you return ONE JSON object describing your intent + the files to write. Slowcook applies them, runs the navigator + tests, and feeds the result back next iter.

## Output schema (return this JSON object only, no prose around it)

\`\`\`json
{
  "rationale": "1-3 sentences: what you're doing this iter + why",
  "files": [
    { "path": "src/components/foo.tsx", "content": "<full file contents>" }
  ],
  "halt": { "reason": "...optional, halt the run with this reason" }
}
\`\`\`

If you halt, omit \`files\`. Otherwise omit \`halt\` and include all files you want to write THIS ITER. Slowcook overwrites the listed files exactly with your content.

## Constraints

- DO NOT write to: \`tests/**\`, \`vitest.config.*\`, \`.brewing/**\`. Frozen.
- The mock IS the design. Your prod files should mirror its visual structure + component composition.
- REUSE existing components/helpers/routes from the codebase. Don't fork.
- Prefer EDIT-style writes: include the full new file contents (you don't have read tools, but each iter gives you the relevant existing files in context).
- Per-iter output should be focused — solve ONE coherent slice. Touching too many files in one iter increases blast radius + navigator BLOCK risk.

## When to halt

- All story tests pass and you have no further changes: \`{ "rationale": "...", "halt": { "reason": "all green" } }\`
- You believe the test contract is wrong (rare — say so explicitly): \`{ "halt": { "reason": "test X expects Y but spec says Z" } }\`
- You're stuck after 2+ iters with no progress: \`{ "halt": { "reason": "blocked on ..." } }\`

## When the navigator BLOCKED you last iter

Their concerns appear in your context. Address them concretely. If you believe a concern is wrong, say so in your rationale + explain — but understand they may BLOCK you again, and after persistent blocking they may add a test that pins the constraint.
`;

interface IterContext {
  storyId: string;
  spec: string;
  testFiles: Array<{ path: string; content: string }>;
  mockFiles: Array<{ path: string; content: string }>;
  codeMapDigest: string;
  history: IterRecord[];
  /** Existing src/ files most likely relevant — included so the driver can EDIT not just CREATE. */
  relevantSrcFiles: Array<{ path: string; content: string }>;
}

function buildDriverPrompt(ctx: IterContext): string {
  const sections: string[] = [];

  sections.push(`# Driver iteration for story-${ctx.storyId}`);
  sections.push("");
  sections.push("## Spec");
  sections.push("```yaml");
  sections.push(ctx.spec);
  sections.push("```");
  sections.push("");

  sections.push("## Tests (frozen — must pass)");
  for (const t of ctx.testFiles) {
    sections.push(`### ${t.path}`);
    sections.push("```ts");
    sections.push(truncate(t.content, MAX_FILE_BYTES));
    sections.push("```");
  }

  sections.push("## Design reference (mock files — your prod should mirror visual structure)");
  for (const m of ctx.mockFiles) {
    sections.push(`### ${m.path}`);
    sections.push("```tsx");
    sections.push(truncate(m.content, MAX_FILE_BYTES));
    sections.push("```");
  }

  if (ctx.relevantSrcFiles.length > 0) {
    sections.push("## Existing src/ files (current state — overwrite by listing in your `files`)");
    for (const f of ctx.relevantSrcFiles) {
      sections.push(`### ${f.path}`);
      sections.push("```tsx");
      sections.push(truncate(f.content, MAX_FILE_BYTES));
      sections.push("```");
    }
  }

  if (ctx.codeMapDigest.trim()) {
    sections.push("## Existing codebase vocabulary (REUSE before creating)");
    sections.push(ctx.codeMapDigest.trim());
    sections.push("");
  }

  if (ctx.history.length > 0) {
    sections.push("## Previous iterations (your past attempts + navigator feedback)");
    for (const h of ctx.history.slice(-3)) {
      sections.push(`### Iter ${h.iter} — outcome: ${h.outcome}`);
      sections.push(`Rationale: ${h.driverRationale}`);
      sections.push(`Files touched: ${h.filesTouched.join(", ") || "(none)"}`);
      sections.push(`Navigator: overall=${h.navigatorVerdict.overall}; ${h.navigatorVerdict.rationale}`);
      if (h.navigatorVerdict.axes.length > 0) {
        for (const a of h.navigatorVerdict.axes) {
          sections.push(`  - ${a.severity.toUpperCase()} ${a.axis}: ${a.summary}`);
          sections.push(`    → ${a.recommendation}`);
        }
      }
      if (h.testFailureFirst) sections.push(`First test failure: ${h.testFailureFirst}`);
      if (h.crossStoryFailures && h.crossStoryFailures.length > 0) {
        sections.push(`Cross-story regressions caused: ${h.crossStoryFailures.slice(0, 5).join(", ")}`);
      }
      sections.push("");
    }
  }

  sections.push("---");
  sections.push("Now produce your iteration. Return the JSON object only — no prose around it.");

  return sections.join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n// ... (truncated, ${s.length - max} chars omitted)`;
}

function parseDriverJson(text: string): DriverOutput {
  const trimmed = text.trim();
  // Try to find a JSON object — agents often wrap in ```json fences
  const fenceMatch = trimmed.match(/```json\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1]! : trimmed;
  try {
    return JSON.parse(candidate) as DriverOutput;
  } catch (e) {
    // Try fence-less parse
    throw new Error(`Driver output not valid JSON. First 300 chars:\n${candidate.slice(0, 300)}\n\nError: ${(e as Error).message}`);
  }
}

function parseNavigatorJson(text: string): NavigatorVerdict {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/```json\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1]! : trimmed;
  try {
    return JSON.parse(candidate) as NavigatorVerdict;
  } catch (e) {
    throw new Error(`Navigator output not valid JSON. First 300 chars:\n${candidate.slice(0, 300)}\n\nError: ${(e as Error).message}`);
  }
}

function collectStoryFiles(repoRoot: string, storyId: string, kind: "test" | "mock"): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  if (kind === "test") {
    const dir = join(repoRoot, "tests/integration");
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(`story-${storyId}`)) continue;
      if (!/\.test\.(ts|tsx)$/.test(name)) continue;
      const path = `tests/integration/${name}`;
      out.push({ path, content: readFileSync(join(repoRoot, path), "utf8") });
    }
  } else {
    // mock: walk mock/src/ for files referenced by story scenarios + the components those import.
    // For first cut, just include all mock/src/components and the story scenarios.
    const scenariosDir = join(repoRoot, "mock/scenarios");
    if (existsSync(scenariosDir)) {
      for (const name of readdirSync(scenariosDir)) {
        if (!name.startsWith(`story-${storyId}`)) continue;
        const path = `mock/scenarios/${name}`;
        out.push({ path, content: readFileSync(join(repoRoot, path), "utf8") });
      }
    }
    // All files under mock/src/components/members and similar likely-relevant dirs.
    const componentDirs = ["mock/src/components/members", "mock/src/components/rewo"];
    for (const dirRel of componentDirs) {
      const dir = join(repoRoot, dirRel);
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (!/\.tsx?$/.test(name)) continue;
        const path = `${dirRel}/${name}`;
        out.push({ path, content: readFileSync(join(repoRoot, path), "utf8") });
      }
    }
  }
  return out;
}

function collectRelevantSrcFiles(repoRoot: string): Array<{ path: string; content: string }> {
  // Include existing src/components/members + the api route + the page wiring.
  const out: Array<{ path: string; content: string }> = [];
  const candidates = [
    "src/components/members",
  ];
  for (const dirRel of candidates) {
    const dir = join(repoRoot, dirRel);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!/\.tsx?$/.test(name)) continue;
      const path = `${dirRel}/${name}`;
      out.push({ path, content: readFileSync(join(repoRoot, path), "utf8") });
    }
  }
  return out;
}

function readSpec(repoRoot: string, storyId: string): string {
  const path = join(repoRoot, `specs/story-${storyId}.yaml`);
  if (!existsSync(path)) return "(no spec file at " + path + ")";
  return readFileSync(path, "utf8");
}

function readCodeMapDigest(repoRoot: string): string {
  const path = join(repoRoot, ".brewing/code-map.target.md");
  if (!existsSync(path)) {
    const fallback = join(repoRoot, ".brewing/code-map.md");
    if (!existsSync(fallback)) return "";
    const md = readFileSync(fallback, "utf8");
    return md.length > 6000 ? md.slice(0, 6000) + "\n... (truncated)" : md;
  }
  return readFileSync(path, "utf8");
}

function applyFiles(repoRoot: string, files: Array<{ path: string; content: string }>): string[] {
  const touched: string[] = [];
  for (const f of files) {
    if (f.path.startsWith("tests/") || f.path.startsWith("vitest.config") || f.path.startsWith(".brewing/")) {
      console.warn(`  ! refusing to write frozen path: ${f.path}`);
      continue;
    }
    const abs = join(repoRoot, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content, "utf8");
    touched.push(f.path);
  }
  return touched;
}

function computeDiff(repoRoot: string): string {
  const out = execSync(`git -C "${repoRoot}" diff HEAD`, { encoding: "utf8" });
  return out.length > MAX_DIFF_BYTES ? out.slice(0, MAX_DIFF_BYTES) + "\n... (truncated)" : out;
}

function changedPaths(repoRoot: string): string[] {
  const out = execSync(`git -C "${repoRoot}" diff --name-only HEAD`, { encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

function revertPaths(repoRoot: string, paths: string[]): void {
  for (const p of paths) {
    try {
      execSync(`git -C "${repoRoot}" checkout HEAD -- "${p}" 2>/dev/null || rm -f "${repoRoot}/${p}"`, { stdio: "ignore" });
    } catch { /* ignore */ }
  }
}

interface TestRunResult {
  allPassed: boolean;
  failures: string[];
  total: number;
  passed: number;
}

function runStoryTests(repoRoot: string, storyId: string): TestRunResult {
  // Run vitest scoped to story-NNN tests; parse summary.
  try {
    const out = execSync(
      `cd "${repoRoot}" && npx vitest run tests/integration/story-${storyId}* --reporter=default 2>&1 || true`,
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }
    );
    return parseVitestOutput(out);
  } catch (e) {
    return { allPassed: false, failures: [(e as Error).message], total: 0, passed: 0 };
  }
}

function runFullSuite(repoRoot: string): TestRunResult {
  try {
    const out = execSync(
      `cd "${repoRoot}" && npx vitest run --reporter=default 2>&1 || true`,
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }
    );
    return parseVitestOutput(out);
  } catch (e) {
    return { allPassed: false, failures: [(e as Error).message], total: 0, passed: 0 };
  }
}

function parseVitestOutput(out: string): TestRunResult {
  const lastLines = out.split("\n").slice(-50);
  let total = 0;
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];
  for (const line of lastLines) {
    const m = line.match(/Tests\s+(?:(\d+)\s+failed\s+\|\s+)?(\d+)\s+passed(?:\s+\|\s+(\d+)\s+skipped)?\s+\((\d+)\)/);
    if (m) {
      failed = parseInt(m[1] ?? "0", 10);
      passed = parseInt(m[2] ?? "0", 10);
      total = parseInt(m[4] ?? "0", 10);
    }
  }
  // Extract failing test names
  for (const line of out.split("\n")) {
    const fm = line.match(/×\s+(.+?)\s+\d+ms/);
    if (fm && fm[1]) failures.push(fm[1].trim());
  }
  return { allPassed: failed === 0 && total > 0, failures: failures.slice(0, 10), total, passed };
}

export async function pairSim(argv: string[], _cliVersion: string): Promise<void> {
  const args = parseArgs(argv);

  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY env var is required.");
    process.exit(2);
  }

  const client = new AnthropicClient(apiKey);
  console.log(`slowcook brew --pair-sim · story-${args.storyId} · model=${args.model} · max-iters=${args.maxIters} · budget=$${args.budgetUsd}`);

  const spec = readSpec(args.repoRoot, args.storyId);
  const testFiles = collectStoryFiles(args.repoRoot, args.storyId, "test");
  const mockFiles = collectStoryFiles(args.repoRoot, args.storyId, "mock");
  const codeMapDigest = readCodeMapDigest(args.repoRoot);

  console.log(`  loaded: ${testFiles.length} test files · ${mockFiles.length} mock files · code-map ${codeMapDigest.length} chars`);

  const history: IterRecord[] = [];
  let totalSpend = 0;
  let outcome: "success" | "iter-cap" | "budget-cap" | "halt" = "iter-cap";

  for (let iter = 1; iter <= args.maxIters; iter++) {
    if (totalSpend >= args.budgetUsd) { outcome = "budget-cap"; break; }

    const relevantSrcFiles = collectRelevantSrcFiles(args.repoRoot);
    const ctx: IterContext = {
      storyId: args.storyId,
      spec,
      testFiles,
      mockFiles,
      codeMapDigest,
      history,
      relevantSrcFiles,
    };

    // DRIVER
    console.log(`\n=== iter ${iter} · DRIVER ===`);
    const driverPrompt = buildDriverPrompt(ctx);
    const driverResp = await client.complete({
      model: args.model,
      system: DRIVER_SYSTEM,
      messages: [{ role: "user", content: driverPrompt }],
      maxTokens: 8192,
    });
    totalSpend += driverResp.costUsd;
    console.log(`  driver: ${driverResp.usage.inputTokens}→${driverResp.usage.outputTokens} tok · $${driverResp.costUsd.toFixed(4)} · spent=$${totalSpend.toFixed(2)}`);

    let driverOutput: DriverOutput;
    try {
      driverOutput = parseDriverJson(driverResp.text);
    } catch (e) {
      console.error(`  ! driver JSON parse failed: ${(e as Error).message}`);
      outcome = "halt";
      break;
    }

    console.log(`  driver rationale: ${driverOutput.rationale}`);

    if (driverOutput.halt) {
      console.log(`  driver HALT: ${driverOutput.halt.reason}`);
      outcome = "halt";
      break;
    }

    const filesToWrite = driverOutput.files ?? [];
    if (filesToWrite.length === 0) {
      console.log(`  driver wrote no files; recording as no-progress iter`);
      history.push({
        iter,
        driverRationale: driverOutput.rationale,
        filesTouched: [],
        navigatorVerdict: { axes: [], overall: "warn", rationale: "(no diff to navigate)" },
        outcome: "tests-failing",
        driverCostUsd: driverResp.costUsd,
        navigatorCostUsd: 0,
      });
      continue;
    }

    const touched = applyFiles(args.repoRoot, filesToWrite);
    console.log(`  driver touched ${touched.length} file(s): ${touched.join(", ")}`);

    const diff = computeDiff(args.repoRoot);

    // NAVIGATOR
    console.log(`=== iter ${iter} · NAVIGATOR ===`);
    const navPrompt = buildNavigatorPrompt({
      storyId: args.storyId,
      driverRationale: driverOutput.rationale,
      diff,
      mockFiles,
      codeMapDigest,
      storyTestIds: extractTestIds(testFiles),
      specYaml: spec,
      priorVerdicts: history.map((h) => ({
        iter: h.iter,
        overall: h.navigatorVerdict.overall,
        axes: h.navigatorVerdict.axes.map((a) => ({
          axis: a.axis,
          severity: a.severity,
          summary: a.summary,
          recommendation: a.recommendation,
        })),
      })),
    });
    const navResp = await client.complete({
      model: args.model,
      system: NAVIGATOR_SYSTEM,
      messages: [{ role: "user", content: navPrompt }],
      maxTokens: 4096,
    });
    totalSpend += navResp.costUsd;
    console.log(`  navigator: ${navResp.usage.inputTokens}→${navResp.usage.outputTokens} tok · $${navResp.costUsd.toFixed(4)} · spent=$${totalSpend.toFixed(2)}`);

    let verdict: NavigatorVerdict;
    try {
      verdict = parseNavigatorJson(navResp.text);
    } catch (e) {
      console.error(`  ! navigator JSON parse failed: ${(e as Error).message}; treating as approve`);
      verdict = { axes: [], overall: "approve", rationale: "(parse failed; treated as approve)" };
    }

    console.log(`  navigator: ${verdict.overall.toUpperCase()} — ${verdict.rationale}`);
    for (const a of verdict.axes) {
      console.log(`    [${a.severity}] ${a.axis}: ${a.summary}`);
    }

    if (verdict.overall === "block") {
      console.log(`  REVERT iter ${iter} (navigator blocked)`);
      revertPaths(args.repoRoot, touched);
      history.push({
        iter,
        driverRationale: driverOutput.rationale,
        filesTouched: touched,
        navigatorVerdict: verdict,
        outcome: "blocked",
        driverCostUsd: driverResp.costUsd,
        navigatorCostUsd: navResp.costUsd,
      });
      continue;
    }

    // Run story tests
    console.log(`=== iter ${iter} · TESTS ===`);
    const storyResult = runStoryTests(args.repoRoot, args.storyId);
    console.log(`  story-${args.storyId} tests: ${storyResult.passed}/${storyResult.total} passed`);

    if (!storyResult.allPassed) {
      history.push({
        iter,
        driverRationale: driverOutput.rationale,
        filesTouched: touched,
        navigatorVerdict: verdict,
        outcome: "tests-failing",
        testFailureFirst: storyResult.failures[0],
        driverCostUsd: driverResp.costUsd,
        navigatorCostUsd: navResp.costUsd,
      });
      continue;
    }

    // Story green — check full suite
    const fullResult = runFullSuite(args.repoRoot);
    if (!fullResult.allPassed) {
      // Cross-story regression
      const crossStoryFailures = fullResult.failures.filter((f) => !f.includes(`story-${args.storyId}`));
      console.log(`  CROSS-STORY REGRESSION: ${crossStoryFailures.length} test(s) failing outside story-${args.storyId}`);
      revertPaths(args.repoRoot, touched);
      history.push({
        iter,
        driverRationale: driverOutput.rationale,
        filesTouched: touched,
        navigatorVerdict: verdict,
        outcome: "cross-story-regression",
        crossStoryFailures: crossStoryFailures.slice(0, 10),
        driverCostUsd: driverResp.costUsd,
        navigatorCostUsd: navResp.costUsd,
      });
      continue;
    }

    console.log(`  SUCCESS · iter ${iter} · all green · spend=$${totalSpend.toFixed(2)}`);
    history.push({
      iter,
      driverRationale: driverOutput.rationale,
      filesTouched: touched,
      navigatorVerdict: verdict,
      outcome: "success",
      driverCostUsd: driverResp.costUsd,
      navigatorCostUsd: navResp.costUsd,
    });
    outcome = "success";
    break;
  }

  // Write summary
  const summary = {
    story_id: args.storyId,
    model: args.model,
    iterations_run: history.length,
    total_spend_usd: totalSpend,
    outcome,
    iterations: history,
  };
  mkdirSync(dirname(args.outPath), { recursive: true });
  writeFileSync(args.outPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(`\n=== summary ===`);
  console.log(`  outcome: ${outcome.toUpperCase()}`);
  console.log(`  iterations: ${history.length}`);
  console.log(`  total spend: $${totalSpend.toFixed(2)}`);
  console.log(`  navigator block rate: ${history.filter(h => h.outcome === "blocked").length}/${history.length}`);
  console.log(`  cross-story regressions: ${history.filter(h => h.outcome === "cross-story-regression").length}`);
  console.log(`  wrote ${relative(args.repoRoot, args.outPath)}`);

  if (outcome !== "success") process.exit(1);
}

function extractTestIds(testFiles: Array<{ path: string; content: string }>): string[] {
  const out: string[] = [];
  for (const t of testFiles) {
    for (const m of t.content.matchAll(/\bit\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
      if (m[1]) out.push(`${t.path} > ${m[1]}`);
    }
  }
  return out.slice(0, 50);
}
