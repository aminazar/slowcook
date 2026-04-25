/**
 * 0.13.0-alpha.3b — LLM-backed regression test emitter.
 *
 * Replaces alpha.3a's `expect.fail()` stub with a real vitest file
 * the agent writes by reading the bug profile + the failure-locus
 * file. The emitted test must be RED against current code (the bug
 * exists) and become GREEN once sift fixes it. That's the contract
 * sift's red→green ratchet runs against.
 *
 * Different from sift: recipe-regression *only* writes the test
 * file. It doesn't edit production code. Read tools available;
 * write_file is restricted to the regression test path itself.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { resolve, isAbsolute, join } from "node:path";
import { execSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { outlineFile } from "../brew/agent.js";
import {
  findReferences,
  findDefinition,
  renderReferences,
} from "../brew/retrieval.js";
import type { BugProfile } from "../investigate/schema.js";

const MAX_ROUNDS = 8;
const MAX_FILE_READ_BYTES = 20000;

export const RECIPE_REGRESSION_SYSTEM = `You are the recipe agent (regression mode) for slowcook — a TDD-first bug-fix flow.

## Your role

You receive a bug profile from \`investigate\`. Your job: write a single vitest file that asserts the regression assertion(s) hold. The test you write is the contract \`sift\` will fix the code against.

You are NOT testgen. testgen writes acceptance tests for new features. You write a regression test for a known-broken behavior. Different posture:

- **The bug profile names the failure locus.** Read it (read_file). Understand what's broken. The diagnosis tells you why.
- **The regression test must be RED against current code.** If your test passes against the broken state, the bug profile is wrong OR your test isn't actually exercising the bug. Halt voluntarily — don't ship a passing regression test for a live bug.
- **The regression test must be GREEN once the bug is fixed.** It targets the corrected behavior, not the buggy state.
- **One test file. tests/regression/B-N-<slug>.test.ts.** Don't create helpers, don't edit fixtures, don't touch source code. The output is exactly one new file.
- **Test against the SMALLEST testable surface.** If the bug is in an API route, hit the route handler in isolation (mock the database). If it's in a component, render the component with stub props (mock fetch). Don't spin up the whole app.

## Tools

- **read_file(path)** — read a file in full.
- **outline_file(path)** — compact outline (imports, top-level exports, signatures with line numbers).
- **list_directory(path)** — see what's in a dir.
- **find_references(symbol)** — find all use sites of a symbol.
- **find_definition(symbol)** — find where a symbol is declared.
- **grep(pattern, glob?)** — repo-wide ripgrep.

You do NOT have write_file — you produce the test file as a single \`<test_file>\` block in your final reply. Slowcook writes it to disk after parsing.

## Test conventions

The consumer project uses vitest. Match the patterns already in tests/integration/ — use \`vi.mock("@/utils/supabase/server")\`, \`renderWithProviders\`, \`mockFetch\` etc. when relevant. Don't invent new patterns.

For UI components, mock the data layer at the fetch boundary; for handlers, mock supabase via \`realShapedCreateClient\`. Read at least one existing tests/integration/ file before writing yours so you match the local conventions.

## Output format

A single \`<test_file>\` block whose content is the complete vitest source:

\`\`\`
<test_file>
// slowcook regression test — B-N
//
// (full test file contents)
import { describe, it, expect, vi } from "vitest";
// ...

describe("B-N regression — <bug title>", () => {
  it("<regression assertion>", () => {
    // ...
    expect(...).toBe(...);
  });
});
</test_file>
\`\`\`

If you can't write a test that's reliably red-against-current and green-against-fixed (e.g., the failure mode is non-deterministic, or you can't isolate the bug from network state), emit a \`<halt>\` block with a one-line description instead. **Don't ship a useless test.**

## Halt format

\`\`\`
<halt>
<reason>One-line description of what made writing the test impossible.</reason>
</halt>
\`\`\`
`;

export const RECIPE_REGRESSION_TOOLS = [
  {
    name: "read_file",
    description: "Read a file's full contents.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "Repo-relative path." },
      },
      required: ["path"],
    },
  },
  {
    name: "outline_file",
    description: "Compact outline (imports, exports, signatures with line numbers).",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "Repo-relative path." },
      },
      required: ["path"],
    },
  },
  {
    name: "list_directory",
    description: "List entries in a directory.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "Repo-relative path." },
      },
      required: ["path"],
    },
  },
  {
    name: "find_references",
    description: "All use sites of a symbol across the repo.",
    input_schema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string" as const, description: "Identifier name." },
      },
      required: ["symbol"],
    },
  },
  {
    name: "find_definition",
    description: "Where a symbol is declared.",
    input_schema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string" as const, description: "Identifier name." },
      },
      required: ["symbol"],
    },
  },
  {
    name: "grep",
    description: "Repo-wide ripgrep.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string" as const, description: "Pattern." },
        glob: { type: "string" as const, description: "Optional glob restriction." },
      },
      required: ["pattern"],
    },
  },
];

export interface RegressionRecipeContext {
  repoRoot: string;
  anthropicApiKey: string;
  model: string;
  bugProfile: BugProfile;
  cliVersion: string;
  now?: () => Date;
}

export interface RegressionRecipeResult {
  /** True when the agent emitted a usable <test_file> block. */
  emitted: boolean;
  /** The test file contents (only set when emitted=true). */
  testContents?: string;
  /** Total LLM rounds. */
  rounds: number;
  /** USD spent. */
  spendUsd: number;
  /** When emitted=false, why the agent halted. */
  haltReason?: string;
  /** Last text the agent produced (debug aid). */
  finalText: string;
}

export async function runRegressionRecipe(
  ctx: RegressionRecipeContext
): Promise<RegressionRecipeResult> {
  const anthropic = new Anthropic({ apiKey: ctx.anthropicApiKey });
  const userPrompt = buildUserPrompt(ctx.bugProfile);
  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: userPrompt },
  ];

  let spendUsd = 0;
  let finalText = "";
  let rounds = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    rounds = round + 1;
    const response = await anthropic.messages.create({
      model: ctx.model,
      max_tokens: 8192,
      system: RECIPE_REGRESSION_SYSTEM,
      tools: RECIPE_REGRESSION_TOOLS,
      messages,
    });
    spendUsd += costUsd(response, ctx.model);

    for (const block of response.content) {
      if (block.type === "text") finalText = block.text;
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
    );
    if (response.stop_reason === "tool_use" && toolUses.length > 0) {
      const toolResults = toolUses.map((t) => {
        const r = executeTool(ctx.repoRoot, t);
        return {
          type: "tool_result" as const,
          tool_use_id: t.id,
          content: r.content,
          is_error: r.is_error,
        };
      });
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    break;
  }

  // Format-compliance retry — same pattern as investigate's
  // alpha.3.1 fix. If the agent stopped without emitting a
  // <test_file> or <halt> block, nudge it once.
  if (!hasTestFileBlock(finalText) && !parseHalt(finalText)) {
    rounds += 1;
    messages.push({ role: "assistant", content: finalText });
    messages.push({
      role: "user",
      content:
        "Your previous reply was free-form prose. Slowcook's parser greps for `<test_file>...</test_file>` (or `<halt>...</halt>`) literally. Re-emit your final answer wrapped in one of those two tags — nothing else will parse. The test file body goes between `<test_file>` and `</test_file>`, no fences, no commentary inside.",
    });
    const retry = await anthropic.messages.create({
      model: ctx.model,
      max_tokens: 8192,
      system: RECIPE_REGRESSION_SYSTEM,
      tools: RECIPE_REGRESSION_TOOLS,
      messages,
    });
    spendUsd += costUsd(retry, ctx.model);
    for (const block of retry.content) {
      if (block.type === "text") finalText = block.text;
    }
  }

  const halt = parseHalt(finalText);
  if (halt !== null) {
    return { emitted: false, rounds, spendUsd, haltReason: halt, finalText };
  }

  const testContents = parseTestFileBlock(finalText);
  if (!testContents) {
    return {
      emitted: false,
      rounds,
      spendUsd,
      haltReason:
        "agent did not emit a <test_file> block (or <halt>) after the format-compliance retry",
      finalText,
    };
  }

  return { emitted: true, testContents, rounds, spendUsd, finalText };
}

function buildUserPrompt(profile: BugProfile): string {
  const lines: string[] = [];
  lines.push(`# Write a regression test for ${profile.bug_id}`);
  lines.push("");
  lines.push("## Bug profile");
  lines.push("```yaml");
  lines.push(`bug_id: ${profile.bug_id}`);
  lines.push(`title: ${JSON.stringify(profile.title)}`);
  lines.push(`source_issue: "${profile.source_issue}"`);
  lines.push(`symptom:`);
  for (const s of profile.symptom) lines.push(`  - ${JSON.stringify(s)}`);
  lines.push(`expected:`);
  for (const s of profile.expected) lines.push(`  - ${JSON.stringify(s)}`);
  lines.push(`reproduction:`);
  for (const s of profile.reproduction) lines.push(`  - ${JSON.stringify(s)}`);
  lines.push(`failure_locus:`);
  lines.push(`  file: ${JSON.stringify(profile.failure_locus.file)}`);
  if (profile.failure_locus.line !== undefined) {
    lines.push(`  line: ${profile.failure_locus.line}`);
  }
  if (profile.failure_locus.function !== undefined) {
    lines.push(`  function: ${JSON.stringify(profile.failure_locus.function)}`);
  }
  lines.push(`  diagnosis: |`);
  for (const l of profile.failure_locus.diagnosis.split("\n")) {
    lines.push(`    ${l}`);
  }
  lines.push(`regression_assertion:`);
  for (const a of profile.regression_assertion) lines.push(`  - ${JSON.stringify(a)}`);
  lines.push(`fix_scope:`);
  for (const s of profile.fix_scope) lines.push(`  - ${JSON.stringify(s)}`);
  lines.push("```");
  lines.push("");
  lines.push("## Your task");
  lines.push(
    "1. Read the failure_locus file (and any other files you need to understand the contract)."
  );
  lines.push("2. Read at least one existing tests/integration/ file to match local conventions.");
  lines.push("3. Write a vitest file that asserts the regression_assertion(s) hold.");
  lines.push("4. Emit it inside a single `<test_file>...</test_file>` block.");
  lines.push("");
  lines.push(
    `The test will be saved at \`tests/regression/${profile.bug_id}-<slug>.test.ts\`. The slug is generated by slowcook from the bug title; you don't need to include the path in your output.`
  );
  return lines.join("\n");
}

// -------------------------------------------------------------------------
// Tool dispatch (read-only — same shape as investigate's)
// -------------------------------------------------------------------------

interface ToolResult {
  content: string;
  is_error: boolean;
}

function executeTool(
  repoRoot: string,
  tool: Anthropic.Messages.ToolUseBlock
): ToolResult {
  const input = tool.input as Record<string, unknown>;
  try {
    switch (tool.name) {
      case "read_file": {
        const p = String(input["path"] ?? "");
        if (!isPathSafe(repoRoot, p)) {
          return { content: `Path escape forbidden: ${p}`, is_error: true };
        }
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
      case "outline_file": {
        const p = String(input["path"] ?? "");
        if (!isPathSafe(repoRoot, p)) {
          return { content: `Path escape forbidden: ${p}`, is_error: true };
        }
        const full = resolve(repoRoot, p);
        if (!existsSync(full)) return { content: `File not found: ${p}`, is_error: true };
        const txt = readFileSync(full, "utf8");
        return { content: outlineFile(p, txt), is_error: false };
      }
      case "list_directory": {
        const p = String(input["path"] ?? "");
        if (!isPathSafe(repoRoot, p)) {
          return { content: `Path escape forbidden: ${p}`, is_error: true };
        }
        const full = resolve(repoRoot, p);
        if (!existsSync(full)) return { content: `Not found: ${p}`, is_error: true };
        if (!statSync(full).isDirectory()) {
          return { content: `Not a directory: ${p}`, is_error: true };
        }
        const entries = readdirSync(full, { withFileTypes: true })
          .map((e) => `${e.name}${e.isDirectory() ? "/" : ""}`)
          .sort()
          .join("\n");
        return { content: entries, is_error: false };
      }
      case "find_references": {
        const symbol = String(input["symbol"] ?? "").trim();
        if (!symbol) return { content: "symbol is required", is_error: true };
        const refs = findReferences(repoRoot, symbol, { excludeDefinitions: false });
        return { content: renderReferences(refs), is_error: false };
      }
      case "find_definition": {
        const symbol = String(input["symbol"] ?? "").trim();
        if (!symbol) return { content: "symbol is required", is_error: true };
        const def = findDefinition(repoRoot, symbol);
        if (!def) return { content: `(no declaration found for ${symbol})`, is_error: false };
        return {
          content: `${def.kind} | ${def.file}:${def.line}:${def.column} | ${def.context}`,
          is_error: false,
        };
      }
      case "grep":
        return runGrep(
          repoRoot,
          String(input["pattern"] ?? ""),
          input["glob"] ? String(input["glob"]) : undefined
        );
      default:
        return { content: `Unknown tool: ${tool.name}`, is_error: true };
    }
  } catch (e) {
    return { content: `Tool error: ${(e as Error).message}`, is_error: true };
  }
}

function isPathSafe(repoRoot: string, relPath: string): boolean {
  if (isAbsolute(relPath)) return false;
  const resolved = resolve(repoRoot, relPath);
  return resolved.startsWith(resolve(repoRoot));
}

function runGrep(
  repoRoot: string,
  pattern: string,
  glob?: string
): ToolResult {
  if (!pattern) return { content: "pattern is required", is_error: true };
  const safe = pattern.replace(/'/g, "'\\''");
  const cmd = glob
    ? `rg --line-number --max-count=50 -e '${safe}' --glob '${glob.replace(/'/g, "'\\''")}'`
    : `rg --line-number --max-count=50 -e '${safe}'`;
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

// -------------------------------------------------------------------------
// Output parsing
// -------------------------------------------------------------------------

export function parseTestFileBlock(text: string): string | null {
  const m = text.match(/<test_file>([\s\S]*?)<\/test_file>/);
  if (!m || !m[1]) return null;
  // Strip optional ```ts/``` fences inside the block (common LLM
  // habit — they wrap the test in markdown code fences inside the
  // tag).
  let body = m[1].trim();
  body = body.replace(/^```(?:ts|tsx|typescript|js|jsx)?\n?/, "");
  body = body.replace(/\n?```$/, "");
  return body.trim() + "\n";
}

export function hasTestFileBlock(text: string): boolean {
  return /<test_file>[\s\S]*?<\/test_file>/.test(text);
}

export function parseHalt(text: string): string | null {
  const m = text.match(/<halt>[\s\S]*?<reason>([\s\S]*?)<\/reason>[\s\S]*?<\/halt>/);
  if (m && m[1]) return m[1].trim();
  const fallback = text.match(/<halt>([\s\S]*?)<\/halt>/);
  return fallback ? (fallback[1] ?? "").trim() : null;
}

// -------------------------------------------------------------------------
// Cost (mirrors investigate's pricing)
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

void join;
