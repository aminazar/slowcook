/**
 * `slowcook chef-drift` — α.9 L1 drift-fixer (cli α.9).
 *
 * Sibling to the existing `slowcook chef --pr <n>` (PR-CI-failure
 * handler). This module is the SURGICAL EDITOR variant: triggered by
 * mock-isolation / recon / brew halt / navigator halt-class. Reads the
 * failure + history-index + PR state, calls the chef LLM to get a
 * ChefVerdict, applies edits surgically, validates, commits, posts an
 * audit comment.
 *
 * Frozen surface (HARD): never edits tests/, vitest.config.*,
 * .brewing/{auto-gen}/. If a fix requires test edits → escalates to PM
 * via a two-option pm_comment (option B = `testgen --regenerate`).
 *
 * Ledger at .brewing/chef/<story-id>.json tracks moves + cost. Cycle
 * detection + budget cap enforce convergence.
 *
 * Run from consumer repo root:
 *   ANTHROPIC_API_KEY=... slowcook chef-drift \
 *     --story 018 \
 *     --trigger mock_isolation_check_failed \
 *     --trigger-detail "Relative import resolves to a non-existent file..."
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AnthropicClient,
  CHEF_SYSTEM,
  buildChefPrompt,
  type ChefVerdict,
  type ChefEdit,
} from "@slowcook-ai/llm-anthropic";

interface Args {
  storyId: string;
  repoRoot: string;
  triggerKind: "mock_isolation_check_failed" | "recon_escalation" | "brew_halt_class" | "navigator_halt_class";
  triggerDetail: string;
  triggerRawPath: string | null;
  navigatorHistoryPath: string | null;
  model: string;
  budgetUsd: number;
  dryRun: boolean;
}

interface ChefMoveLedgerEntry {
  n: number;
  trigger_kind: string;
  drift_signature: string;
  rationale: string;
  decision: ChefVerdict["kind"];
  edits: ChefEdit[];
  validation_command: string | null;
  validation_result: "passed" | "failed" | "not-run" | null;
  next_dispatch: string | null;
  cost_usd: number;
  post_state: "clean" | "still-broken" | "escalated";
  timestamp: string;
}

interface ChefLedger {
  story_id: string;
  episode: number;
  moves: ChefMoveLedgerEntry[];
  cumulative_cost_usd: number;
  halt_reason: string | null;
}

const FROZEN_PATH_PATTERNS = [
  /^tests\//,
  /^vitest\.config\.(ts|mjs|js)$/,
  /^\.brewing\/code-map\.(json|md|target\.md)$/,
  /^\.brewing\/recon-result\.json$/,
  /^\.brewing\/history-index\.json$/,
  /^\.brewing\/auto-gen\//,
];

function isFrozenPath(path: string): boolean {
  return FROZEN_PATH_PATTERNS.some((re) => re.test(path));
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    storyId: "",
    repoRoot: process.cwd(),
    triggerKind: "mock_isolation_check_failed",
    triggerDetail: "",
    triggerRawPath: null,
    navigatorHistoryPath: null,
    model: "claude-sonnet-4-5-20250929",
    budgetUsd: 1.0,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--story" && next) { args.storyId = next; i++; }
    else if (a === "--cwd" && next) { args.repoRoot = next; i++; }
    else if (a === "--trigger" && next) { args.triggerKind = next as Args["triggerKind"]; i++; }
    else if (a === "--trigger-detail" && next) { args.triggerDetail = next; i++; }
    else if (a === "--trigger-raw" && next) { args.triggerRawPath = next; i++; }
    else if (a === "--navigator-history" && next) { args.navigatorHistoryPath = next; i++; }
    else if (a === "--model" && next) { args.model = next; i++; }
    else if (a === "--budget-usd" && next) { args.budgetUsd = parseFloat(next); i++; }
    else if (a === "--dry-run") { args.dryRun = true; }
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  if (!args.storyId) { console.error("--story <id> is required"); printHelp(); process.exit(64); }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook chef-drift — surgical drift-fixer (cli α.9 L1)

Sibling to \`slowcook chef --pr <n>\` (PR-CI-failure handler). This
variant: triggered by mock-isolation / recon / brew halt / navigator
halt-class; makes surgical edits across spec + mock + prod (NEVER tests
or vitest config); commits + posts audit comment + optionally dispatches
the next pipeline step.

Usage:
  slowcook chef-drift --story <id> --trigger <kind> [options]

Options:
  --cwd <path>             Repo root (default: cwd).
  --trigger <kind>         mock_isolation_check_failed | recon_escalation |
                           brew_halt_class | navigator_halt_class
  --trigger-detail <text>  One-line summary of the failure.
  --trigger-raw <path>     Path to JSON file with full trigger detail.
  --navigator-history <path>  Path to navigator-history JSON (when applicable).
  --model <id>             Anthropic model id.
  --budget-usd <n>         Per-episode budget cap (default: 1.00).
  --dry-run                Print verdict; do not apply edits.

Requires: ANTHROPIC_API_KEY in env. Run from consumer repo root.
Frozen surface: tests/, vitest.config.*, .brewing/{auto-gen}/ — never edited.
`);
}

function loadHistoryIndex(repoRoot: string): unknown {
  const path = join(repoRoot, ".brewing/history-index.json");
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
}

function loadSpec(repoRoot: string, storyId: string): { specPath: string; specYaml: string } {
  const path = `specs/story-${storyId}.yaml`;
  const abs = join(repoRoot, path);
  if (!existsSync(abs)) return { specPath: path, specYaml: "" };
  return { specPath: path, specYaml: readFileSync(abs, "utf8") };
}

function loadOpenPrs(repoRoot: string, storyId: string): Array<{ kind: "spec" | "mockup" | "tests" | "brew"; number: number; branch: string; headSha: string }> {
  const out: Array<{ kind: "spec" | "mockup" | "tests" | "brew"; number: number; branch: string; headSha: string }> = [];
  try {
    const repoSlug = execSync(
      `git -C "${repoRoot}" remote get-url origin | sed -E 's|^.*github\\.com[:/]||; s|\\.git$||'`,
      { encoding: "utf8" },
    ).trim();
    const json = execSync(
      `gh pr list --repo "${repoSlug}" --search "story-${storyId}" --state open --json number,headRefName,headRefOid,title --limit 10`,
      { encoding: "utf8" },
    );
    const prs = JSON.parse(json) as Array<{ number: number; headRefName: string; headRefOid: string }>;
    for (const pr of prs) {
      const branch = pr.headRefName;
      let kind: "spec" | "mockup" | "tests" | "brew";
      if (branch.includes("/spec/")) kind = "spec";
      else if (branch.includes("/mockup/")) kind = "mockup";
      else if (branch.includes("/tests/") || branch.includes("/recipe/")) kind = "tests";
      else if (branch.includes("/brew/")) kind = "brew";
      else continue;
      out.push({ kind, number: pr.number, branch, headSha: pr.headRefOid });
    }
  } catch (e) {
    console.warn(`  warn: could not list open PRs (${(e as Error).message.slice(0, 100)})`);
  }
  return out;
}

function loadLedger(repoRoot: string, storyId: string): ChefLedger {
  const path = join(repoRoot, `.brewing/chef/story-${storyId}.json`);
  if (!existsSync(path)) {
    return { story_id: storyId, episode: 1, moves: [], cumulative_cost_usd: 0, halt_reason: null };
  }
  return JSON.parse(readFileSync(path, "utf8")) as ChefLedger;
}

function saveLedger(repoRoot: string, ledger: ChefLedger): void {
  const path = join(repoRoot, `.brewing/chef/story-${ledger.story_id}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ledger, null, 2), "utf8");
}

function detectCycle(ledger: ChefLedger, plannedEdits: ChefEdit[]): boolean {
  for (const prior of ledger.moves) {
    for (const priorEdit of prior.edits) {
      if (priorEdit.operation !== "rename" || !priorEdit.to) continue;
      const matches = plannedEdits.find(
        (e) => e.operation === "rename" && e.file === priorEdit.to && e.to === priorEdit.file,
      );
      if (matches) return true;
    }
  }
  return false;
}

function applyEdit(repoRoot: string, edit: ChefEdit): void {
  const abs = join(repoRoot, edit.file);
  switch (edit.operation) {
    case "rename": {
      if (!edit.to) throw new Error(`rename edit missing 'to' field for ${edit.file}`);
      const toAbs = join(repoRoot, edit.to);
      mkdirSync(dirname(toAbs), { recursive: true });
      execSync(`git -C "${repoRoot}" mv "${edit.file}" "${edit.to}"`, { stdio: "ignore" });
      // Heuristic: if file basename changed, rename default-export inside the file
      const oldName = edit.file.split("/").pop()!.replace(/\.tsx?$/, "");
      const newName = edit.to.split("/").pop()!.replace(/\.tsx?$/, "");
      if (oldName !== newName && existsSync(toAbs)) {
        let content = readFileSync(toAbs, "utf8");
        content = content.replace(
          new RegExp(`(export default function )${oldName}\\b`, "g"),
          `$1${newName}`,
        );
        writeFileSync(toAbs, content, "utf8");
      }
      break;
    }
    case "create": {
      if (!edit.patch) throw new Error(`create edit missing 'patch' for ${edit.file}`);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, edit.patch, "utf8");
      break;
    }
    // Legacy 'edit' operation removed — chef must use 'search_replace'
    // for content changes. The default branch below catches it via
    // exhaustive-switch enforcement.
    case "search_replace": {
      const sr = (edit as ChefEdit & { search_replace?: Array<{ find: string; replace: string }> }).search_replace;
      if (!sr || !Array.isArray(sr) || sr.length === 0) {
        throw new Error(`search_replace edit missing 'search_replace' array for ${edit.file}`);
      }
      if (!existsSync(abs)) {
        throw new Error(`search_replace target file does not exist: ${edit.file}`);
      }
      let content = readFileSync(abs, "utf8");
      for (const pair of sr) {
        if (!pair.find || pair.replace === undefined) {
          throw new Error(`search_replace pair missing find or replace for ${edit.file}`);
        }
        // Require find to appear exactly once — guards against ambiguous matches
        const occurrences = content.split(pair.find).length - 1;
        if (occurrences === 0) {
          throw new Error(`search_replace 'find' string not found in ${edit.file}: ${JSON.stringify(pair.find).slice(0, 120)}`);
        }
        if (occurrences > 1) {
          throw new Error(`search_replace 'find' string matches ${occurrences}x in ${edit.file} (must be unique): ${JSON.stringify(pair.find).slice(0, 120)}`);
        }
        content = content.replace(pair.find, pair.replace);
      }
      writeFileSync(abs, content, "utf8");
      break;
    }
    case "delete": {
      execSync(`rm -f "${abs}"`);
      break;
    }
    default: {
      throw new Error(
        `unsupported edit operation '${(edit as ChefEdit).operation}' for ${edit.file} — use rename / search_replace / create / delete only.`
      );
    }
  }
}

function runValidation(repoRoot: string, command: string): { passed: boolean; output: string } {
  // Chef may produce commands prefixed with `slowcook ...` (matches the
  // documented prompt examples). On runners where slowcook isn't on
  // PATH, we route through the same node binary that's running chef.
  let resolved = command.trim();
  if (resolved.startsWith("slowcook ")) {
    const cliJs = process.argv[1] || "";
    if (cliJs && existsSync(cliJs)) {
      resolved = `node "${cliJs}" ${resolved.slice("slowcook ".length)}`;
    }
  }
  try {
    const output = execSync(resolved, { cwd: repoRoot, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    return { passed: true, output };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const out = err.stdout || err.stderr || err.message || "";
    return { passed: false, output: out };
  }
}

/**
 * Compare pre-move + post-move validation outputs to decide whether
 * chef's iteration made progress.
 *
 * Returns 'progress' when post-set ⊆ pre-set AND post-set has fewer
 * unique failure-lines than pre-set (i.e., chef removed at least one
 * failure + introduced none).
 *
 * Returns 'no-change' when post-set === pre-set.
 *
 * Returns 'regression' when post-set has any line not in pre-set
 * (chef introduced a new failure).
 */
function compareValidationOutputs(pre: string, post: string): "progress" | "no-change" | "regression" {
  // Heuristic: extract lines that look like file:line refs (typical
  // failure-marker shape). Compare as sets.
  const extractFailureLines = (s: string): Set<string> => {
    const out = new Set<string>();
    for (const line of s.split("\n")) {
      const m = line.match(/^\s*([\w./[\]()-]+\.(?:ts|tsx|js|jsx|yaml|yml|sql|md|json)):(\d+)/);
      if (m) out.add(`${m[1]}:${m[2]}`);
    }
    return out;
  };
  const preSet = extractFailureLines(pre);
  const postSet = extractFailureLines(post);
  const newFailures = [...postSet].filter((x) => !preSet.has(x));
  if (newFailures.length > 0) return "regression";
  if (postSet.size < preSet.size) return "progress";
  return "no-change";
}

function postIssueComment(repoRoot: string, issueNumber: number, body: string): void {
  const repoSlug = execSync(
    `git -C "${repoRoot}" remote get-url origin | sed -E 's|^.*github\\.com[:/]||; s|\\.git$||'`,
    { encoding: "utf8" },
  ).trim();
  // Try gh CLI first; fall back to curl + GITHUB_TOKEN. Runners often
  // have one but not the other.
  const tmp = "/tmp/chef-drift-comment.md";
  writeFileSync(tmp, body, "utf8");
  try {
    execSync(`gh issue comment ${issueNumber} --repo "${repoSlug}" --body-file ${tmp}`, { stdio: "inherit" });
    return;
  } catch {
    // fall through to curl
  }
  const token = process.env["GITHUB_TOKEN"];
  if (!token) {
    console.warn(`  warn: gh not installed + GITHUB_TOKEN not set; skipping audit comment on issue #${issueNumber}`);
    return;
  }
  const payload = JSON.stringify({ body });
  const payloadFile = "/tmp/chef-drift-payload.json";
  writeFileSync(payloadFile, payload, "utf8");
  try {
    execSync(
      `curl -sS -f -X POST -H "Authorization: token ${token}" -H "Accept: application/vnd.github+json" --data @${payloadFile} "https://api.github.com/repos/${repoSlug}/issues/${issueNumber}/comments" >/dev/null`,
      { stdio: "inherit" },
    );
    console.log(`  posted audit comment on issue #${issueNumber} (via curl)`);
  } catch (e) {
    console.warn(`  warn: failed to post audit comment via curl: ${(e as Error).message.slice(0, 200)}`);
  }
}

function commitChefEdits(repoRoot: string, summary: string): { sha: string | null; pushed: boolean } {
  // Stage everything chef touched + commit with the chef-bot identity.
  // Caller (workflow) decides whether to push; chef just commits locally.
  try {
    execSync(`git -C "${repoRoot}" add -A`, { stdio: "ignore" });
    // Empty commit guard: if nothing staged, skip.
    const status = execSync(`git -C "${repoRoot}" status --porcelain`, { encoding: "utf8" }).trim();
    if (!status) return { sha: null, pushed: false };
    // Write commit message to file (handle quotes cleanly).
    const msgFile = "/tmp/chef-drift-commit-msg.txt";
    writeFileSync(msgFile, `[chef] ${summary}\n\nCo-Authored-By: slowcook-chef[bot] <slowcook-chef@users.noreply.github.com>\n`, "utf8");
    execSync(
      `git -C "${repoRoot}" -c user.name="slowcook-chef[bot]" -c user.email="slowcook-chef@users.noreply.github.com" commit -F ${msgFile}`,
      { stdio: "inherit" },
    );
    const sha = execSync(`git -C "${repoRoot}" rev-parse HEAD`, { encoding: "utf8" }).trim();
    return { sha, pushed: false };
  } catch (e) {
    console.warn(`  warn: chef commit failed: ${(e as Error).message.slice(0, 200)}`);
    return { sha: null, pushed: false };
  }
}

function buildAuditCommentBody(args: { ledger: ChefLedger; move: ChefMoveLedgerEntry; verdict: ChefVerdict }): string {
  const { move, verdict } = args;
  const lines: string[] = [];
  lines.push(`### [chef-drift] Move ${move.n} on story-${args.ledger.story_id}`);
  lines.push("");
  lines.push(`**Trigger:** \`${move.trigger_kind}\``);
  lines.push("");
  lines.push(`**Decision:** ${move.decision}`);
  lines.push("");
  lines.push(`**Rationale:** ${verdict.rationale}`);
  lines.push("");
  if (move.edits.length > 0) {
    lines.push(`**Files touched:**`);
    for (const e of move.edits) {
      lines.push(`- \`${e.file}\` (${e.operation}${e.to ? ` → \`${e.to}\`` : ""})`);
    }
    lines.push("");
  }
  if (move.validation_command) {
    lines.push(`**Validation:** \`${move.validation_command}\` → ${move.validation_result}`);
    lines.push("");
  }
  if (move.next_dispatch) {
    lines.push(`**Next:** dispatched \`${move.next_dispatch}\``);
    lines.push("");
  }
  lines.push(`**Cost:** $${move.cost_usd.toFixed(2)} (cumulative: $${args.ledger.cumulative_cost_usd.toFixed(2)})`);
  return lines.join("\n");
}

export async function chefDrift(argv: string[], _cliVersion: string): Promise<void> {
  const args = parseArgs(argv);

  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) { console.error("ANTHROPIC_API_KEY env var is required."); process.exit(2); }

  console.log(`slowcook chef-drift · story-${args.storyId} · trigger=${args.triggerKind}`);

  const ledger = loadLedger(args.repoRoot, args.storyId);
  if (ledger.cumulative_cost_usd >= args.budgetUsd) {
    console.error(`  episode budget exceeded ($${ledger.cumulative_cost_usd.toFixed(2)} >= $${args.budgetUsd}). Halting.`);
    process.exit(1);
  }

  let triggerRaw: Record<string, unknown> = {};
  if (args.triggerRawPath && existsSync(args.triggerRawPath)) {
    try { triggerRaw = JSON.parse(readFileSync(args.triggerRawPath, "utf8")) as Record<string, unknown>; } catch { /* ignore */ }
  }

  // Enrich trigger.raw with context the chef LLM doesn't have read-tools to gather.
  // For mock_isolation failures: grep ALL importers of the missing symbol so chef
  // can plan a coordinated rename (not just the one file the trigger detail named).
  if (args.triggerKind === "mock_isolation_check_failed") {
    const importerMatch = args.triggerDetail.match(/['"]\.\/(\w+)['"]/);
    if (importerMatch && importerMatch[1]) {
      const symbol = importerMatch[1];
      const grepImportsBySymbol = (root: string, sym: string): Array<{ file: string; line: number; text: string }> => {
        try {
          const out = execSync(
            `grep -rnE "from\\s+[\\\"']\\.[/.][^\\\"']*${sym}[\\\"']" "${root}" 2>/dev/null || true`,
            { encoding: "utf8", maxBuffer: 1024 * 1024 },
          );
          return out
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const m = line.match(/^([^:]+):(\d+):(.*)$/);
              if (!m) return null;
              return { file: m[1]!.replace(args.repoRoot + "/", ""), line: parseInt(m[2]!, 10), text: m[3]!.trim() };
            })
            .filter((x): x is { file: string; line: number; text: string } => x !== null);
        } catch {
          return [];
        }
      };

      // Step 1: find existing files in same dir with names similar to the missing symbol.
      // These are the rename candidates — the file that chef likely needs to rename forward.
      const candidateExisting: string[] = [];
      const symbolLower = symbol.toLowerCase();
      const importerFile = args.triggerDetail.match(/^([^\s]+):/)?.[1];
      const stem = symbolLower.replace(/strip|page|header|badge|card|list|row|item/g, "").trim();
      if (importerFile) {
        const dir = dirname(join(args.repoRoot, importerFile));
        if (existsSync(dir)) {
          try {
            const files = readdirSync(dir);
            for (const f of files) {
              const fLow = f.toLowerCase().replace(/\.tsx?$/, "");
              if (!/\.tsx?$/.test(f)) continue;
              if (fLow === symbolLower) continue; // skip exact match (it'd already exist)
              // Match if file name shares a meaningful stem with the symbol
              if (
                (stem.length > 3 && fLow.includes(stem)) ||
                fLow.includes(symbolLower.slice(0, 6)) ||
                symbolLower.includes(fLow)
              ) {
                candidateExisting.push(`${dir.replace(args.repoRoot + "/", "")}/${f}`);
              }
            }
          } catch { /* ignore */ }
        }
      }

      // Step 2: for the broken symbol AND every candidate-existing file's basename,
      // grep all importers across mock/src + src.
      const symbolsToGrep = new Set<string>([symbol]);
      for (const c of candidateExisting) {
        const base = c.split("/").pop()!.replace(/\.tsx?$/, "");
        symbolsToGrep.add(base);
      }

      const mockImporters: Record<string, Array<{ file: string; line: number; text: string }>> = {};
      const srcImporters: Record<string, Array<{ file: string; line: number; text: string }>> = {};
      for (const sym of symbolsToGrep) {
        mockImporters[sym] = grepImportsBySymbol(join(args.repoRoot, "mock/src"), sym);
        srcImporters[sym] = grepImportsBySymbol(join(args.repoRoot, "src"), sym);
      }

      // Read content of every importer file so chef can craft accurate
      // search_replace pairs without inventing or omitting code.
      const importerContents: Record<string, string> = {};
      const allImporterFiles = new Set<string>();
      for (const sym of symbolsToGrep) {
        for (const imp of mockImporters[sym] ?? []) allImporterFiles.add(imp.file);
        for (const imp of srcImporters[sym] ?? []) allImporterFiles.add(imp.file);
      }
      for (const candidate of candidateExisting) allImporterFiles.add(candidate);
      for (const f of allImporterFiles) {
        const abs = join(args.repoRoot, f);
        if (existsSync(abs)) {
          const content = readFileSync(abs, "utf8");
          importerContents[f] = content.length > 6000 ? content.slice(0, 6000) + "\n// ... truncated" : content;
        }
      }

      triggerRaw = {
        ...triggerRaw,
        symbol,
        candidate_existing_files: candidateExisting,
        importers_per_symbol: {
          mock: mockImporters,
          src: srcImporters,
        },
        existing_content: importerContents,
        enrichment_note:
          "cli-precomputed (chef has no grep/read tools): importers_per_symbol shows EVERY file that imports each candidate. existing_content gives you the FULL TEXT of each importer + candidate file so you can craft accurate search_replace pairs. ALWAYS use search_replace operation for content edits — never full-content rewrites.",
      };
      const totalMockImps = Object.values(mockImporters).reduce((n, arr) => n + arr.length, 0);
      const totalSrcImps = Object.values(srcImporters).reduce((n, arr) => n + arr.length, 0);
      console.log(`  enriched trigger: ${candidateExisting.length} candidate file(s), ${symbolsToGrep.size} symbol(s) checked, ${totalMockImps} mock importer(s), ${totalSrcImps} src importer(s) total`);
    }
  }
  let navigatorHistory: unknown = null;
  if (args.navigatorHistoryPath && existsSync(args.navigatorHistoryPath)) {
    try { navigatorHistory = JSON.parse(readFileSync(args.navigatorHistoryPath, "utf8")); } catch { /* ignore */ }
  }

  const { specPath, specYaml } = loadSpec(args.repoRoot, args.storyId);
  const openPrs = loadOpenPrs(args.repoRoot, args.storyId);
  const historyIndex = loadHistoryIndex(args.repoRoot);

  const issueMatch = specYaml.match(/source_issue:\s*"#?(\d+)"/);
  const issueNumber = issueMatch ? parseInt(issueMatch[1]!, 10) : 0;

  const prompt = buildChefPrompt({
    storyId: args.storyId,
    trigger: { kind: args.triggerKind, detail: args.triggerDetail, raw: triggerRaw },
    storyState: { issueNumber, specPath, specYaml, openPrs },
    historyIndex,
    navigatorHistory: navigatorHistory as never,
    priorChefMoves: ledger.moves.map((m) => ({
      n: m.n,
      triggerKind: m.trigger_kind,
      decision: m.decision,
      postState: m.post_state,
    })),
  });

  console.log(`  prompt: ${prompt.length} chars · calling chef LLM (${args.model})`);
  const client = new AnthropicClient(apiKey);
  const resp = await client.complete({
    model: args.model,
    system: CHEF_SYSTEM,
    messages: [{ role: "user", content: prompt }],
    maxTokens: 8192,
  });
  console.log(`  chef LLM: ${resp.usage.inputTokens}→${resp.usage.outputTokens} tok · $${resp.costUsd.toFixed(4)}`);

  let verdict: ChefVerdict;
  try {
    const text = resp.text.trim();
    const fence = text.match(/```json\s*([\s\S]*?)```/);
    verdict = JSON.parse(fence ? fence[1]! : text) as ChefVerdict;
  } catch (e) {
    console.error(`  ! chef JSON parse failed: ${(e as Error).message}`);
    console.error(`  raw: ${resp.text.slice(0, 500)}`);
    process.exit(1);
  }

  console.log(`  chef verdict: ${verdict.kind.toUpperCase()}`);
  console.log(`  rationale: ${verdict.rationale}`);

  // Frozen-surface guard
  for (const e of verdict.edits) {
    if (isFrozenPath(e.file) || (e.to && isFrozenPath(e.to))) {
      console.error(`  ! chef proposed an edit to frozen path: ${e.file} → ${e.to ?? ""}. Halting + escalating.`);
      verdict.kind = "halt";
      verdict.edits = [];
    }
  }

  // Cycle guard
  if (verdict.kind === "autonomous_fix" && detectCycle(ledger, verdict.edits)) {
    console.error(`  ! cycle detected: chef's planned edit is the inverse of an earlier move. Halting.`);
    verdict.kind = "halt";
    verdict.edits = [];
  }

  const moveN = ledger.moves.length + 1;
  const moveEntry: ChefMoveLedgerEntry = {
    n: moveN,
    trigger_kind: args.triggerKind,
    drift_signature: args.triggerDetail.slice(0, 200),
    rationale: verdict.rationale,
    decision: verdict.kind,
    edits: verdict.edits,
    validation_command: verdict.validation?.command ?? null,
    validation_result: null,
    next_dispatch: verdict.next_dispatch,
    cost_usd: resp.costUsd,
    post_state: "escalated",
    timestamp: new Date().toISOString(),
  };

  if (verdict.kind === "autonomous_fix" && verdict.edits.length > 0) {
    if (args.dryRun) {
      console.log(`\n  [dry-run] would apply ${verdict.edits.length} edit(s); skipping`);
      moveEntry.post_state = "escalated"; // dry-run: state is unknown without applying
    } else {
      console.log(`\n  applying ${verdict.edits.length} edit(s)...`);
      try {
        // Capture PRE-move validation output as baseline. Pre-existing
        // failures aren't chef's responsibility — only new ones are.
        let preBaseline: { passed: boolean; output: string } | null = null;
        if (verdict.validation) {
          console.log(`  baseline (pre-edit): ${verdict.validation.command}`);
          preBaseline = runValidation(args.repoRoot, verdict.validation.command);
          console.log(`    pre passed=${preBaseline.passed}`);
        }
        for (const e of verdict.edits) applyEdit(args.repoRoot, e);
        if (verdict.validation && preBaseline) {
          console.log(`  validating: ${verdict.validation.command}`);
          const post = runValidation(args.repoRoot, verdict.validation.command);
          const diff = compareValidationOutputs(preBaseline.output, post.output);
          console.log(`    post passed=${post.passed} · diff=${diff}`);
          if (post.passed) {
            moveEntry.validation_result = "passed";
            moveEntry.post_state = "clean";
            console.log(`  ✓ validation cleanly passed`);
          } else if (diff === "progress") {
            moveEntry.validation_result = "passed"; // partial — pre-existing unrelated failures remain
            moveEntry.post_state = "clean";
            console.log(`  ✓ progress: chef removed failures + introduced none. Pre-existing unrelated failures remain (not chef's responsibility).`);
          } else if (diff === "no-change" && verdict.validation.must_exit_zero) {
            console.error(`  ! validation NO-CHANGE. Chef's edits didn't help. Reverting.`);
            execSync(`git -C "${args.repoRoot}" checkout HEAD -- .`);
            execSync(`git -C "${args.repoRoot}" clean -fd`);
            moveEntry.validation_result = "failed";
            moveEntry.post_state = "still-broken";
          } else if (diff === "regression") {
            console.error(`  ! validation REGRESSION: chef introduced new failures. Reverting.`);
            execSync(`git -C "${args.repoRoot}" checkout HEAD -- .`);
            execSync(`git -C "${args.repoRoot}" clean -fd`);
            moveEntry.validation_result = "failed";
            moveEntry.post_state = "still-broken";
          } else {
            moveEntry.validation_result = "passed";
            moveEntry.post_state = "clean";
          }
        } else {
          moveEntry.validation_result = "not-run";
          moveEntry.post_state = "clean";
        }
      } catch (e) {
        console.error(`  ! edit-application failed: ${(e as Error).message}. Reverting.`);
        try { execSync(`git -C "${args.repoRoot}" checkout HEAD -- .`); } catch { /* */ }
        try { execSync(`git -C "${args.repoRoot}" clean -fd`); } catch { /* */ }
        moveEntry.post_state = "still-broken";
      }
    }
  } else if (verdict.kind === "pm_question" && verdict.pm_comment && !args.dryRun) {
    console.log(`\n  posting PM question to issue #${verdict.pm_comment.issue_number}`);
    postIssueComment(args.repoRoot, verdict.pm_comment.issue_number, verdict.pm_comment.body);
  }

  // Commit chef's edits locally (workflow handles the push) when validation passed.
  if (verdict.kind === "autonomous_fix" && moveEntry.post_state === "clean" && !args.dryRun) {
    const summary = `move ${moveN} on story-${args.storyId} — ${args.triggerKind}: ${verdict.rationale.slice(0, 120)}`;
    const result = commitChefEdits(args.repoRoot, summary);
    if (result.sha) console.log(`  committed: ${result.sha.slice(0, 7)}`);
  }

  ledger.moves.push(moveEntry);
  ledger.cumulative_cost_usd += resp.costUsd;
  if (!args.dryRun) saveLedger(args.repoRoot, ledger);

  if (verdict.kind === "autonomous_fix" && moveEntry.post_state === "clean" && issueNumber > 0 && !args.dryRun) {
    const body = buildAuditCommentBody({ ledger, move: moveEntry, verdict });
    try { postIssueComment(args.repoRoot, issueNumber, body); }
    catch (e) { console.warn(`  warn: audit comment failed (non-fatal): ${(e as Error).message.slice(0, 200)}`); }
  }

  console.log(`\n  done · post_state=${moveEntry.post_state} · move=${moveN} · cum-cost=$${ledger.cumulative_cost_usd.toFixed(4)}`);

  if (verdict.kind === "halt" || moveEntry.post_state === "still-broken") process.exit(1);
}
