/**
 * Sift agent loop. Narrow red→green ratchet for bug fixes.
 *
 * Mirrors brew's iter loop in shape but smaller in every dimension:
 *  - max 3 iterations (vs brew's 10)
 *  - $0.50 budget cap (vs brew's $10)
 *  - allowed_paths restricted to bug-profile.fix_scope
 *  - test-runner is scoped to the regression test only
 *  - no story manifest; the contract is just the regression test
 *
 * **Status: alpha.4a**. Single-iteration loop with no ratchet/revert.
 * Iteration loop + multi-turn ratchet ships in alpha.4b alongside
 * a brew/sift shared-engine refactor.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { execSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import {
  validateStackConfig,
  type StackConfig,
  runTests,
  type RunResult,
} from "@slowcook-ai/stack-ts";
import { outlineFile } from "../brew/agent.js";
import {
  findReferences,
  findDefinition,
  renderReferences,
} from "../brew/retrieval.js";
import { SIFT_SYSTEM, SIFT_TOOLS, buildSiftTurnPrompt } from "./prompts.js";
import { type BugProfile } from "../investigate/schema.js";

const MAX_ROUNDS_PER_ITER = 8;
const MAX_FILE_READ_BYTES = 20000;

export interface SiftContext {
  repoRoot: string;
  anthropicApiKey: string;
  model: string;
  bugProfile: BugProfile;
  /** Repo-relative path to the regression test file. */
  regressionTestPath: string;
  /** Read once at construction; passed through prompts. */
  regressionTestSrc: string;
  stackConfig: StackConfig;
  /** Hard cap (seconds spend); default 3. */
  maxIterations: number;
  /** USD spend cap; default 0.5. */
  budgetUsd: number;
  now?: () => Date;
}

export interface SiftResult {
  /** True when the regression test ended green. */
  green: boolean;
  /** Total iterations the agent took. */
  iterations: number;
  /** Total spend in USD. */
  spendUsd: number;
  /** Files written across the run. */
  filesTouched: string[];
  /** When green=false, why the run ended (`budget`, `iters`, `halt:<reason>`, etc.). */
  haltReason?: string;
  /** Last test result for diagnostics. */
  lastTestResult: RunResult | null;
}

export async function runSift(ctx: SiftContext): Promise<SiftResult> {
  const anthropic = new Anthropic({ apiKey: ctx.anthropicApiKey });
  const filesTouched = new Set<string>();
  let spendUsd = 0;
  let lastTestResult: RunResult | null = null;
  const priorEdits: string[] = [];

  for (let iter = 1; iter <= ctx.maxIterations; iter++) {
    if (spendUsd >= ctx.budgetUsd) {
      return {
        green: false,
        iterations: iter - 1,
        spendUsd,
        filesTouched: [...filesTouched],
        haltReason: `budget (spent $${spendUsd.toFixed(4)} of $${ctx.budgetUsd})`,
        lastTestResult,
      };
    }

    const turnPrompt = buildSiftTurnPrompt({
      iteration: iter,
      maxIterations: ctx.maxIterations,
      bugProfileYaml: bugProfileToYamlSummary(ctx.bugProfile),
      regressionTestPath: ctx.regressionTestPath,
      regressionTestSrc: ctx.regressionTestSrc,
      testResult: lastTestResult
        ? {
            status: regressionStatus(lastTestResult, ctx.regressionTestPath),
            failureMessage: regressionFailureMessage(
              lastTestResult,
              ctx.regressionTestPath
            ),
          }
        : undefined,
      priorEdits,
    });

    const messages: Anthropic.Messages.MessageParam[] = [
      { role: "user", content: turnPrompt },
    ];

    let haltReason: string | null = null;
    let editsThisTurn = 0;

    for (let round = 0; round < MAX_ROUNDS_PER_ITER; round++) {
      const response = await anthropic.messages.create({
        model: ctx.model,
        max_tokens: 4096,
        system: SIFT_SYSTEM,
        tools: SIFT_TOOLS,
        messages,
      });
      spendUsd += costUsd(response, ctx.model);

      // Look for <halt> in any text block.
      for (const block of response.content) {
        if (block.type === "text") {
          const halt = parseHalt(block.text);
          if (halt !== null) haltReason = halt;
        }
      }
      if (haltReason !== null) break;

      const toolUses = response.content.filter(
        (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
      );
      if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

      const toolResults = toolUses.map((t) => {
        const result = executeTool(ctx, t);
        if (result.touched) {
          filesTouched.add(result.touched);
          editsThisTurn += 1;
        }
        return {
          type: "tool_result" as const,
          tool_use_id: t.id,
          content: result.content,
          is_error: result.is_error,
        };
      });
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });
    }

    if (haltReason !== null) {
      return {
        green: haltReason.toLowerCase().includes("regression green"),
        iterations: iter,
        spendUsd,
        filesTouched: [...filesTouched],
        haltReason: `halt:${haltReason}`,
        lastTestResult,
      };
    }

    if (editsThisTurn === 0) {
      return {
        green: false,
        iterations: iter,
        spendUsd,
        filesTouched: [...filesTouched],
        haltReason: "agent made no edits this iteration",
        lastTestResult,
      };
    }
    priorEdits.push(...[...filesTouched].slice(priorEdits.length));

    // Run the regression test scoped to the bug's test file.
    lastTestResult = runTests(ctx.stackConfig, {
      cwd: ctx.repoRoot,
      scopeFiles: [ctx.regressionTestPath],
    });
    const status = regressionStatus(lastTestResult, ctx.regressionTestPath);
    if (status === "green") {
      return {
        green: true,
        iterations: iter,
        spendUsd,
        filesTouched: [...filesTouched],
        lastTestResult,
      };
    }
  }

  return {
    green: false,
    iterations: ctx.maxIterations,
    spendUsd,
    filesTouched: [...filesTouched],
    haltReason: `iters (${ctx.maxIterations} reached without green)`,
    lastTestResult,
  };
}

// -------------------------------------------------------------------------
// Tool dispatch — read tools + write_file (scoped to fix_scope)
// -------------------------------------------------------------------------

interface ToolResult {
  content: string;
  is_error: boolean;
  /** Set when write_file succeeded; lets the loop track touched files. */
  touched?: string;
}

function executeTool(
  ctx: SiftContext,
  tool: Anthropic.Messages.ToolUseBlock
): ToolResult {
  const input = tool.input as Record<string, unknown>;
  try {
    switch (tool.name) {
      case "read_file":
        return readFile(ctx.repoRoot, String(input["path"] ?? ""));
      case "outline_file":
        return outlineCmd(ctx.repoRoot, String(input["path"] ?? ""));
      case "list_directory":
        return listDir(ctx.repoRoot, String(input["path"] ?? ""));
      case "find_references": {
        const symbol = String(input["symbol"] ?? "").trim();
        if (!symbol) return { content: "symbol is required", is_error: true };
        const refs = findReferences(ctx.repoRoot, symbol, { excludeDefinitions: false });
        return { content: renderReferences(refs), is_error: false };
      }
      case "find_definition": {
        const symbol = String(input["symbol"] ?? "").trim();
        if (!symbol) return { content: "symbol is required", is_error: true };
        const def = findDefinition(ctx.repoRoot, symbol);
        if (!def) return { content: `(no declaration found for ${symbol})`, is_error: false };
        return {
          content: `${def.kind} | ${def.file}:${def.line}:${def.column} | ${def.context}`,
          is_error: false,
        };
      }
      case "grep":
        return runGrep(
          ctx.repoRoot,
          String(input["pattern"] ?? ""),
          input["glob"] ? String(input["glob"]) : undefined
        );
      case "write_file":
        return writeFile(ctx, String(input["path"] ?? ""), String(input["contents"] ?? ""));
      default:
        return { content: `Unknown tool: ${tool.name}`, is_error: true };
    }
  } catch (e) {
    return { content: `Tool error: ${(e as Error).message}`, is_error: true };
  }
}

function readFile(repoRoot: string, p: string): ToolResult {
  if (!isPathSafe(repoRoot, p)) return { content: `Path escape forbidden: ${p}`, is_error: true };
  const full = resolve(repoRoot, p);
  if (!existsSync(full)) return { content: `File not found: ${p}`, is_error: true };
  if (!statSync(full).isFile()) return { content: `Not a file: ${p}`, is_error: true };
  const txt = readFileSync(full, "utf8");
  return {
    content:
      txt.length > MAX_FILE_READ_BYTES
        ? txt.slice(0, MAX_FILE_READ_BYTES) + "\n…(truncated)"
        : txt,
    is_error: false,
  };
}

function outlineCmd(repoRoot: string, p: string): ToolResult {
  if (!isPathSafe(repoRoot, p)) return { content: `Path escape forbidden: ${p}`, is_error: true };
  const full = resolve(repoRoot, p);
  if (!existsSync(full)) return { content: `File not found: ${p}`, is_error: true };
  if (!statSync(full).isFile()) return { content: `Not a file: ${p}`, is_error: true };
  const txt = readFileSync(full, "utf8");
  return { content: outlineFile(p, txt), is_error: false };
}

function listDir(repoRoot: string, p: string): ToolResult {
  if (!isPathSafe(repoRoot, p)) return { content: `Path escape forbidden: ${p}`, is_error: true };
  const full = resolve(repoRoot, p);
  if (!existsSync(full)) return { content: `Not found: ${p}`, is_error: true };
  if (!statSync(full).isDirectory()) return { content: `Not a directory: ${p}`, is_error: true };
  const entries = readdirSync(full, { withFileTypes: true })
    .map((e) => `${e.name}${e.isDirectory() ? "/" : ""}`)
    .sort()
    .join("\n");
  return { content: entries, is_error: false };
}

function writeFile(ctx: SiftContext, p: string, contents: string): ToolResult {
  if (!isPathSafe(ctx.repoRoot, p)) {
    return { content: `Path escape forbidden: ${p}`, is_error: true };
  }
  if (!isInFixScope(p, ctx.bugProfile.fix_scope)) {
    return {
      content: `${p} is outside the bug profile's fix_scope (${ctx.bugProfile.fix_scope.join(", ")}). Halt voluntarily and ask the operator to widen scope.`,
      is_error: true,
    };
  }
  const full = resolve(ctx.repoRoot, p);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
  return {
    content: `Wrote ${contents.split("\n").length} lines to ${p}`,
    is_error: false,
    touched: p,
  };
}

function runGrep(
  repoRoot: string,
  pattern: string,
  glob?: string
): ToolResult {
  if (!pattern) return { content: "pattern is required", is_error: true };
  const safePattern = pattern.replace(/'/g, "'\\''");
  const cmd = glob
    ? `rg --line-number --max-count=50 -e '${safePattern}' --glob '${glob.replace(/'/g, "'\\''")}'`
    : `rg --line-number --max-count=50 -e '${safePattern}'`;
  try {
    const out = execSync(cmd, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 256,
      encoding: "utf8",
    });
    if (!out.trim()) return { content: "(no matches)", is_error: false };
    return {
      content:
        out.length > MAX_FILE_READ_BYTES
          ? out.slice(0, MAX_FILE_READ_BYTES) + "\n…(truncated)"
          : out,
      is_error: false,
    };
  } catch (e) {
    const exit = (e as { status?: number }).status;
    if (exit === 1) return { content: "(no matches)", is_error: false };
    return { content: `grep error: ${(e as Error).message}`, is_error: true };
  }
}

function isPathSafe(repoRoot: string, relPath: string): boolean {
  if (isAbsolute(relPath)) return false;
  const resolved = resolve(repoRoot, relPath);
  return resolved.startsWith(resolve(repoRoot));
}

export function isInFixScope(
  path: string,
  fixScope: ReadonlyArray<string>
): boolean {
  if (fixScope.length === 0) return false;
  const norm = path.replace(/^\.\/+/, "");
  for (const scope of fixScope) {
    const s = scope.replace(/^\.\/+/, "");
    if (norm === s) return true;
    // Directory prefix match (with or without trailing slash).
    const sDir = s.endsWith("/") ? s : `${s}/`;
    if (norm.startsWith(sDir)) return true;
  }
  return false;
}

// -------------------------------------------------------------------------
// Test-result helpers
// -------------------------------------------------------------------------

export function regressionStatus(
  result: RunResult,
  regressionPath: string
): "red" | "green" {
  // Sift owns the regression test file; consider its tests only. If
  // any are red OR errored, status is red.
  const ours = result.tests.filter((t) => t.file.endsWith(regressionPath));
  if (ours.length === 0) {
    // Vitest may have crashed before reporting; treat as red.
    return "red";
  }
  return ours.every((t) => t.status === "passed" || t.status === "skipped")
    ? "green"
    : "red";
}

export function regressionFailureMessage(
  result: RunResult,
  regressionPath: string
): string | undefined {
  const ours = result.tests.filter(
    (t) => t.file.endsWith(regressionPath) && t.status !== "passed"
  );
  return ours[0]?.failure_message;
}

// -------------------------------------------------------------------------
// Halt block parsing
// -------------------------------------------------------------------------

export function parseHalt(text: string): string | null {
  const m = text.match(/<halt>[\s\S]*?<reason>([\s\S]*?)<\/reason>[\s\S]*?<\/halt>/);
  if (m && m[1]) return m[1].trim();
  // Fallback: simple <halt>reason</halt>.
  const fallback = text.match(/<halt>([\s\S]*?)<\/halt>/);
  return fallback ? (fallback[1] ?? "").trim() : null;
}

// -------------------------------------------------------------------------
// Cost accounting (mirrors investigate's; same pricing table)
// -------------------------------------------------------------------------

const PRICING_PER_M_TOKENS: Record<string, { input: number; output: number }> = {
  "claude-opus-4-7": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

function costUsd(
  response: Anthropic.Messages.Message,
  model: string
): number {
  const pricing =
    PRICING_PER_M_TOKENS[model] ??
    Object.entries(PRICING_PER_M_TOKENS).find(([k]) => model.startsWith(k))?.[1];
  if (!pricing) return 0;
  const usage = response.usage as
    | {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      }
    | undefined;
  const input = usage?.input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheCreate = usage?.cache_creation_input_tokens ?? 0;
  const effectiveInput = input + cacheRead * 0.1 + cacheCreate * 1.25;
  return (effectiveInput / 1_000_000) * pricing.input + (output / 1_000_000) * pricing.output;
}

// -------------------------------------------------------------------------
// Bug profile rendering (compact YAML for prompt — full schema in
// .brewing/bug-profiles/B-N.yaml; we only need the fields sift cares
// about, kept compact to save tokens).
// -------------------------------------------------------------------------

function bugProfileToYamlSummary(p: BugProfile): string {
  const lines: string[] = [];
  lines.push(`bug_id: ${p.bug_id}`);
  lines.push(`title: ${JSON.stringify(p.title)}`);
  lines.push(`source_issue: "${p.source_issue}"`);
  if (p.symptom.length > 0) {
    lines.push(`symptom:`);
    for (const s of p.symptom) lines.push(`  - ${JSON.stringify(s)}`);
  }
  if (p.expected.length > 0) {
    lines.push(`expected:`);
    for (const s of p.expected) lines.push(`  - ${JSON.stringify(s)}`);
  }
  lines.push(`failure_locus:`);
  lines.push(`  file: ${JSON.stringify(p.failure_locus.file)}`);
  if (p.failure_locus.line !== undefined) lines.push(`  line: ${p.failure_locus.line}`);
  if (p.failure_locus.function !== undefined) {
    lines.push(`  function: ${JSON.stringify(p.failure_locus.function)}`);
  }
  lines.push(`  diagnosis: |`);
  for (const l of p.failure_locus.diagnosis.split("\n")) lines.push(`    ${l}`);
  if (p.regression_assertion.length > 0) {
    lines.push(`regression_assertion:`);
    for (const s of p.regression_assertion) lines.push(`  - ${JSON.stringify(s)}`);
  }
  if (p.fix_scope.length > 0) {
    lines.push(`fix_scope:`);
    for (const s of p.fix_scope) lines.push(`  - ${JSON.stringify(s)}`);
  }
  return lines.join("\n");
}

void validateStackConfig;
