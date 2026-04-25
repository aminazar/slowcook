/**
 * Investigate agent loop. Reads a GitHub issue, runs a Claude
 * tool-use loop with read-only repo tools, and emits a validated
 * BugProfile.
 *
 * alpha.2b — real LLM integration. PR opening (creating a branch
 * + pushing the bug-profile.yaml + opening the PR) lands in
 * alpha.2c; this returns the profile to the caller for now.
 *
 * Pattern mirrors brew/agent.ts's runTurn loop but smaller:
 * - read-only tools (no write_file, no justify_diff_overflow)
 * - single conversation, not multi-turn ratchet
 * - output validated against bug-profile schema
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { execSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { outlineFile } from "../brew/agent.js";
import {
  findReferences,
  findDefinition,
  renderReferences,
} from "../brew/retrieval.js";
import {
  INVESTIGATE_SYSTEM,
  INVESTIGATE_TOOLS,
  buildInvestigateUserPrompt,
} from "./prompts.js";
import {
  validateBugProfile,
  type BugProfile,
  BUG_PROFILE_SCHEMA_VERSION,
} from "./schema.js";

const MAX_ROUNDS = 12;
const MAX_FILE_READ_BYTES = 20000;
const DEFAULT_MODEL = "claude-opus-4-7";

export interface InvestigateContext {
  repoRoot: string;
  anthropicApiKey: string;
  model: string;
  /** Filled in by the caller; the LLM doesn't pick the bug-id. */
  bugId: string;
  /** CLI version stamp for `investigated_by`. */
  cliVersion: string;
  issue: {
    number: number;
    title: string;
    body: string;
    /** Prior comments (oldest first), already filtered to non-bot. */
    priorComments: string[];
  };
  /** Used to stamp `created_at` deterministically in tests. */
  now?: () => Date;
}

export interface InvestigateResult {
  profile: BugProfile;
  /** USD spent on the investigation round. */
  spendUsd: number;
  /** Number of LLM rounds (1 round = one LLM call + tool execution). */
  rounds: number;
  /** True if the agent emitted a `<halt>` block instead of a profile. */
  halted: boolean;
  /** Halt reason from the agent (only set when halted=true). */
  haltReason?: string;
  /** Raw final-round text the agent emitted (debugging aid). */
  finalText: string;
}

export async function runInvestigation(
  ctx: InvestigateContext
): Promise<InvestigateResult> {
  const anthropic = new Anthropic({ apiKey: ctx.anthropicApiKey });
  const userPrompt = buildInvestigateUserPrompt({
    issueNumber: ctx.issue.number,
    issueTitle: ctx.issue.title,
    issueBody: ctx.issue.body,
    prior_comments: ctx.issue.priorComments,
  });

  const messages: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: userPrompt },
  ];

  let spendUsd = 0;
  let rounds = 0;
  let finalText = "";

  for (let round = 0; round < MAX_ROUNDS; round++) {
    rounds = round + 1;
    const response = await anthropic.messages.create({
      model: ctx.model,
      max_tokens: 4096,
      system: INVESTIGATE_SYSTEM,
      tools: INVESTIGATE_TOOLS,
      messages,
    });
    spendUsd += costUsd(response, ctx.model);

    // Capture the latest text block before any tool execution so we
    // always have *something* to surface even if the round was
    // tool-only.
    for (const block of response.content) {
      if (block.type === "text") finalText = block.text;
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use"
    );

    // If the model returned tool calls, execute them and feed back.
    if (response.stop_reason === "tool_use" && toolUses.length > 0) {
      const toolResults: Anthropic.Messages.MessageParam = {
        role: "user",
        content: toolUses.map((t) => {
          const result = executeReadOnlyTool(ctx.repoRoot, t);
          return {
            type: "tool_result" as const,
            tool_use_id: t.id,
            content: result.content,
            is_error: result.is_error,
          };
        }),
      };
      messages.push({ role: "assistant", content: response.content });
      messages.push(toolResults);
      continue;
    }

    // Otherwise we're done — parse the final text for `<bug_profile>` or `<halt>`.
    break;
  }

  // 0.13.0-alpha.2c — format-compliance retry. If the agent stopped
  // without emitting either tag, the model produced free-form prose.
  // Send one explicit nudge to wrap the output, then accept whatever
  // tag form lands in the second response. Reduces the "Opus
  // forgets to wrap" failure mode observed on the first live run
  // (rewo issue #135 validation, 2026-04-25).
  if (!hasBugProfileBlock(finalText) && !parseHaltBlock(finalText)) {
    rounds += 1;
    messages.push({ role: "assistant", content: finalText });
    messages.push({
      role: "user",
      content:
        "Your previous reply was free-form prose. Slowcook's parser greps for `<bug_profile>...</bug_profile>` (or `<halt>...</halt>`) literally. Re-emit your conclusion now using one of those two wrappers — nothing else will parse. Pick one:\n\n" +
        "- `<bug_profile>` block with the schema fields if you have a concrete failure locus.\n" +
        "- `<halt>` block with a one-line description of what you couldn't disambiguate.\n",
    });
    const retry = await anthropic.messages.create({
      model: ctx.model,
      max_tokens: 4096,
      system: INVESTIGATE_SYSTEM,
      tools: INVESTIGATE_TOOLS,
      messages,
    });
    spendUsd += costUsd(retry, ctx.model);
    for (const block of retry.content) {
      if (block.type === "text") finalText = block.text;
    }
  }

  const halted = parseHaltBlock(finalText);
  if (halted) {
    return {
      profile: stubHaltProfile(ctx, halted),
      spendUsd,
      rounds,
      halted: true,
      haltReason: halted,
      finalText,
    };
  }

  const profile = parseBugProfileBlock(finalText, ctx);
  return {
    profile,
    spendUsd,
    rounds,
    halted: false,
    finalText,
  };
}

// -------------------------------------------------------------------------
// Tool dispatch — read-only subset (no write_file, no justify_diff_overflow)
// -------------------------------------------------------------------------

interface ToolResult {
  content: string;
  is_error: boolean;
}

function executeReadOnlyTool(
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
        const full = resolveRepoPath(repoRoot, p);
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
        const full = resolveRepoPath(repoRoot, p);
        if (!existsSync(full)) return { content: `File not found: ${p}`, is_error: true };
        if (!statSync(full).isFile()) return { content: `Not a file: ${p}`, is_error: true };
        const txt = readFileSync(full, "utf8");
        return { content: outlineFile(p, txt), is_error: false };
      }
      case "list_directory": {
        const p = String(input["path"] ?? "");
        if (!isPathSafe(repoRoot, p)) {
          return { content: `Path escape forbidden: ${p}`, is_error: true };
        }
        const full = resolveRepoPath(repoRoot, p);
        if (!existsSync(full)) return { content: `Not found: ${p}`, is_error: true };
        if (!statSync(full).isDirectory()) return { content: `Not a directory: ${p}`, is_error: true };
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
      case "grep": {
        const pattern = String(input["pattern"] ?? "");
        const glob = input["glob"] ? String(input["glob"]) : undefined;
        if (!pattern) return { content: "pattern is required", is_error: true };
        return runGrep(repoRoot, pattern, glob);
      }
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

function resolveRepoPath(repoRoot: string, relPath: string): string {
  return resolve(repoRoot, relPath);
}

function runGrep(
  repoRoot: string,
  pattern: string,
  glob?: string
): ToolResult {
  // Sanitize: no shell metas in pattern. Use rg's -e flag so the
  // pattern is treated literally except for regex chars.
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
      content: out.length > MAX_FILE_READ_BYTES ? out.slice(0, MAX_FILE_READ_BYTES) + "\n…(truncated)" : out,
      is_error: false,
    };
  } catch (e) {
    // rg returns exit 1 when no matches — surface as "no matches", not an error.
    const exit = (e as { status?: number }).status;
    if (exit === 1) return { content: "(no matches)", is_error: false };
    return { content: `grep error: ${(e as Error).message}`, is_error: true };
  }
}

// -------------------------------------------------------------------------
// Output parsing
// -------------------------------------------------------------------------

/**
 * Extract the YAML body from a `<bug_profile>...</bug_profile>` block,
 * parse + validate it. Throws on missing block / invalid YAML / failed
 * schema validation. The agent prompt explicitly requires the block;
 * a missing block is a contract violation.
 */
export function parseBugProfileBlock(
  finalText: string,
  ctx: InvestigateContext
): BugProfile {
  const match = finalText.match(/<bug_profile>([\s\S]*?)<\/bug_profile>/);
  if (!match || !match[1]) {
    throw new Error(
      `investigate: agent did not emit a <bug_profile> block. Final text:\n${finalText.slice(0, 500)}`
    );
  }
  const yaml = match[1].trim();
  const parsed = parseSimpleYaml(yaml);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`investigate: <bug_profile> contents could not be parsed as YAML`);
  }
  const profile = parsed as Record<string, unknown>;
  // Slowcook fills the bug_id (race-aware) and stamps the version
  // server-side; we override whatever the LLM put there. created_at
  // similarly authoritative on slowcook's clock.
  profile["bug_id"] = ctx.bugId;
  profile["investigated_by"] = `slowcook-investigate@${ctx.cliVersion}`;
  profile["created_at"] = (ctx.now?.() ?? new Date()).toISOString();
  profile["status"] = "investigated";
  if (!profile["schema_version"]) profile["schema_version"] = BUG_PROFILE_SCHEMA_VERSION;

  const validation = validateBugProfile(profile);
  if (!validation.ok) {
    throw new Error(
      `investigate: agent emitted an invalid bug-profile:\n  ${validation.errors.join("\n  ")}`
    );
  }
  return validation.profile;
}

function parseHaltBlock(text: string): string | null {
  const m = text.match(/<halt>([\s\S]*?)<\/halt>/);
  return m ? (m[1] ?? "").trim() : null;
}

function hasBugProfileBlock(text: string): boolean {
  return /<bug_profile>[\s\S]*?<\/bug_profile>/.test(text);
}

function stubHaltProfile(ctx: InvestigateContext, reason: string): BugProfile {
  return {
    schema_version: BUG_PROFILE_SCHEMA_VERSION,
    bug_id: ctx.bugId,
    title: ctx.issue.title,
    source_issue: `#${ctx.issue.number}`,
    status: "investigated",
    investigated_by: `slowcook-investigate@${ctx.cliVersion}-halted`,
    created_at: (ctx.now?.() ?? new Date()).toISOString(),
    symptom: ["(investigation halted; see haltReason)"],
    expected: [],
    reproduction: [],
    failure_locus: {
      file: "(unknown — investigate halted)",
      diagnosis: reason,
    },
    regression_assertion: [],
    fix_scope: [],
  };
}

/**
 * Minimal YAML subset parser. Handles the shape investigate emits:
 *   - top-level scalar `key: value` (string, number, or quoted string)
 *   - `key:` followed by `  - "string"` list items
 *   - `key:` followed by indented `child: value` pairs (one level deep)
 *   - block scalars `key: |` followed by indented lines
 *
 * NOT a general YAML parser. We avoid pulling `yaml` dep into this
 * module; the agent's output has a constrained shape that this can
 * cover. Falls back to throwing on anything outside that shape, which
 * surfaces parser drift as a clear error rather than silent miss.
 */
export function parseSimpleYaml(src: string): Record<string, unknown> {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (indent !== 0) {
      throw new Error(`Top-level YAML key expected; got indented line: ${line}`);
    }
    // top-level
    const m = line.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*(.*)$/);
    if (!m) throw new Error(`Cannot parse YAML line: ${line}`);
    const key = m[1] ?? "";
    const rest = (m[2] ?? "").trim();
    if (rest === "") {
      // Block: read indented children
      const block: Array<string | Record<string, unknown>> = [];
      const obj: Record<string, unknown> = {};
      let mode: "list" | "object" | "empty" = "empty";
      i++;
      while (i < lines.length) {
        const next = lines[i] ?? "";
        const ind = next.match(/^ */)?.[0].length ?? 0;
        if (next.trim() === "" || next.trim().startsWith("#")) {
          i++;
          continue;
        }
        if (ind === 0) break;
        if (next.trim().startsWith("- ")) {
          mode = "list";
          const itemRaw = next.replace(/^\s*-\s*/, "");
          if (itemRaw.startsWith('"')) {
            block.push(unquote(itemRaw));
          } else if (/^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(itemRaw)) {
            // List of objects (e.g., related_specs)
            const item: Record<string, unknown> = {};
            const firstMatch = itemRaw.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*(.*)$/);
            if (firstMatch) {
              item[firstMatch[1] ?? ""] = parseScalar(firstMatch[2] ?? "");
            }
            i++;
            // Continuation lines for this list item: indented strictly
            // more than the `- ` itself. Breaks on a new sibling (`- `
            // at same indent) or any less-indented line.
            while (i < lines.length) {
              const cont = lines[i] ?? "";
              const contInd = cont.match(/^ */)?.[0].length ?? 0;
              if (contInd <= ind) break;
              if (cont.trim() === "") {
                i++;
                continue;
              }
              const cm = cont.trim().match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*(.*)$/);
              if (!cm) break;
              item[cm[1] ?? ""] = parseScalar(cm[2] ?? "");
              i++;
            }
            block.push(item);
            continue;
          } else {
            block.push(itemRaw);
          }
          i++;
        } else {
          mode = "object";
          // child key
          const cm = next.trim().match(/^([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*(.*)$/);
          if (!cm) throw new Error(`Cannot parse YAML child line: ${next}`);
          const ckey = cm[1] ?? "";
          const cval = (cm[2] ?? "").trim();
          if (cval === "|") {
            // Block scalar — collect indented continuation lines.
            i++;
            const blockLines: string[] = [];
            const blockIndent = ind + 2;
            while (i < lines.length) {
              const cont = lines[i] ?? "";
              const contInd = cont.match(/^ */)?.[0].length ?? 0;
              if (cont.trim() === "") {
                blockLines.push("");
                i++;
                continue;
              }
              if (contInd < blockIndent) break;
              blockLines.push(cont.slice(blockIndent));
              i++;
            }
            obj[ckey] = blockLines.join("\n").replace(/\n+$/, "");
          } else {
            obj[ckey] = parseScalar(cval);
            i++;
          }
        }
      }
      if (mode === "list") out[key] = block;
      else if (mode === "object") out[key] = obj;
      else out[key] = null;
    } else {
      out[key] = parseScalar(rest);
      i++;
    }
  }
  return out;
}

function parseScalar(raw: string): string | number | boolean | null {
  const v = raw.trim();
  if (v === "null") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  if (v.startsWith('"')) return unquote(v);
  return v;
}

function unquote(s: string): string {
  const v = s.trim();
  if (!v.startsWith('"') || !v.endsWith('"')) return v;
  return v
    .slice(1, -1)
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n");
}

// -------------------------------------------------------------------------
// Cost accounting (mirrors brew's matchPricing without depending on it)
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

void DEFAULT_MODEL;
