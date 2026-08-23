/**
 * `slowcook brew --pr N` — implementation resubmit (PR-B, 2026-08-23).
 *
 * Closes the last hand-repair loop in the pipeline: review findings on a
 * brew PR (taste's advisory verdicts, the human's comments) previously
 * died there — every amendment was written by the human. Now the brew
 * agent reads the feedback, amends the implementation on the PR branch,
 * and the SAME verification that gates a fresh brew gates the amendment:
 * story suites green (cross-suite contract included) + fail-closed final
 * gate. On failure everything reverts and the failure is posted as an
 * honest comment; the branch is never left worse than it was.
 *
 * Write scope is the INVERSE of recipe's: implementation surfaces only
 * (src/, supabase/migrations/, mock/, public/). tests/, specs/ and
 * manifests are the frozen contract — a resubmit that wants to change
 * them must escalate to the PM, not edit them.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { LlmClient, LlmMessage, LlmToolDef, LlmToolUse } from "@slowcook-ai/core";

export const BREW_RESUBMIT_WRITE_ROOTS = ["src/", "supabase/migrations/", "mock/", "public/"];
export const BREW_RESUBMIT_FROZEN = ["tests/", "specs/", ".brewing/manifests/", "supabase/tests/"];

const MAX_ROUNDS = 24;
const MAX_FILE_READ_BYTES = 48_000;

export const BREW_RESUBMIT_TOOLS: LlmToolDef[] = [
  {
    name: "read_file",
    description: "Read a file from the repository (truncated after ~48KB).",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Repo-relative path" } },
      required: ["path"],
    },
  },
  {
    name: "list_directory",
    description: "List a repository directory's entries.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Repo-relative directory" } },
      required: ["path"],
    },
  },
  {
    name: "search",
    description: "Search file contents (fixed string or regex via grep -rEn), returns matching lines with paths.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        dir: { type: "string", description: "Repo-relative directory to search (default: src/)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "write_file",
    description:
      "Write a full file. ONLY implementation surfaces are writable (src/, supabase/migrations/, mock/, public/). tests/, specs/ and manifests are the frozen contract — if a finding requires changing them, stop and explain instead.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
];

export interface ResubmitFeedbackItem {
  author: string;
  body: string;
  createdAt: string;
}

/**
 * Which PR comments count as actionable feedback for an implementation
 * resubmit. Taste's advisory reviews ARE feedback; slowcook's own
 * machine notices (bills, ship notes, plate replies) are not; humans are.
 */
export function isBrewFeedback(body: string): boolean {
  if (body.startsWith("**slowcook-taste**")) return true;
  if (body.startsWith("### slowcook ·")) return false;
  return true;
}

export function isPathSafe(repoRoot: string, p: string): boolean {
  if (!p || p.includes("\0")) return false;
  const full = resolve(repoRoot, p);
  return full.startsWith(resolve(repoRoot) + "/");
}

export function isWritablePath(p: string): { ok: boolean; reason?: string } {
  if (p.includes("..")) return { ok: false, reason: "path traversal forbidden" };
  for (const frozen of BREW_RESUBMIT_FROZEN) {
    if (p.startsWith(frozen)) {
      return {
        ok: false,
        reason: `${frozen} is the frozen contract — an implementation resubmit may not edit it. If the finding requires a contract change, escalate to the PM instead.`,
      };
    }
  }
  if (!BREW_RESUBMIT_WRITE_ROOTS.some((r) => p.startsWith(r))) {
    return {
      ok: false,
      reason: `only implementation surfaces are writable (${BREW_RESUBMIT_WRITE_ROOTS.join(", ")})`,
    };
  }
  return { ok: true };
}

export interface ToolExecResult {
  content: string;
  is_error: boolean;
  wrotePath?: string;
}

export function executeBrewResubmitTool(repoRoot: string, tool: LlmToolUse): ToolExecResult {
  const input = tool.input as Record<string, unknown>;
  try {
    switch (tool.name) {
      case "read_file": {
        const p = String(input["path"] ?? "");
        if (!isPathSafe(repoRoot, p)) return { content: `Path escape forbidden: ${p}`, is_error: true };
        const full = join(repoRoot, p);
        if (!existsSync(full) || !statSync(full).isFile())
          return { content: `File not found: ${p}`, is_error: true };
        const txt = readFileSync(full, "utf8");
        return {
          content: txt.length > MAX_FILE_READ_BYTES ? txt.slice(0, MAX_FILE_READ_BYTES) + "\n…(truncated)" : txt,
          is_error: false,
        };
      }
      case "list_directory": {
        const p = String(input["path"] ?? ".");
        if (!isPathSafe(repoRoot, p)) return { content: `Path escape forbidden: ${p}`, is_error: true };
        const full = join(repoRoot, p);
        if (!existsSync(full)) return { content: `Not found: ${p}`, is_error: true };
        const out = execSync(`ls -1a ${JSON.stringify(full)}`, { encoding: "utf8" })
          .split("\n")
          .filter((l) => l && l !== "." && l !== "..")
          .slice(0, 200)
          .join("\n");
        return { content: out || "(empty)", is_error: false };
      }
      case "search": {
        const pattern = String(input["pattern"] ?? "");
        const dir = String(input["dir"] ?? "src/");
        if (!pattern) return { content: "empty pattern", is_error: true };
        if (!isPathSafe(repoRoot, dir)) return { content: `Path escape forbidden: ${dir}`, is_error: true };
        try {
          const out = execSync(
            `grep -rEn --include='*.*' -m 5 ${JSON.stringify(pattern)} ${JSON.stringify(join(repoRoot, dir))} | head -60`,
            { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }
          );
          const rel = out.split("\n").map((l) => l.replace(repoRoot + "/", "")).join("\n");
          return { content: rel.trim() || "(no matches)", is_error: false };
        } catch {
          return { content: "(no matches)", is_error: false };
        }
      }
      case "write_file": {
        const p = String(input["path"] ?? "");
        const content = String(input["content"] ?? "");
        if (!isPathSafe(repoRoot, p)) return { content: `Path escape forbidden: ${p}`, is_error: true };
        const writable = isWritablePath(p);
        if (!writable.ok) return { content: `REFUSED: ${writable.reason}`, is_error: true };
        const full = join(repoRoot, p);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content, "utf8");
        return { content: `wrote ${p} (${content.length} bytes)`, is_error: false, wrotePath: p };
      }
      default:
        return { content: `Unknown tool: ${tool.name}`, is_error: true };
    }
  } catch (e) {
    return { content: `Tool error: ${(e as Error).message.slice(0, 300)}`, is_error: true };
  }
}

export function buildResubmitSystem(): string {
  return `You are slowcook's brew agent, amending an EXISTING implementation on its PR branch in response to review feedback.

Rules:
- The tests, specs, and manifests are the FROZEN CONTRACT. You cannot edit them (writes there are refused). If a finding can only be satisfied by changing the contract, do NOT work around it — end your reply with a paragraph starting "ESCALATE:" explaining exactly what contract change the finding requires and why.
- Address the feedback items directly and minimally. No drive-by refactors.
- The implementation must stay green: every story test that passes now must still pass. Regressions are auto-reverted, so wasted work.
- When you are done editing (or have nothing safe to change), reply WITHOUT tool calls: a short summary of what you changed and why, one bullet per feedback item, marking any you deliberately declined with a reason.`;
}

export function buildResubmitUserPrompt(args: {
  prNumber: number;
  storyId: string;
  specYaml: string | null;
  diff: string;
  feedback: ResubmitFeedbackItem[];
  codeMapSlice: string | null;
}): string {
  const parts: string[] = [];
  parts.push(
    `## PR #${args.prNumber} — implementation for story-${args.storyId}\n\nYou are on the PR branch; the files are on disk. The diff below is what this PR currently changes relative to its base.`
  );
  if (args.specYaml) parts.push(`## Spec (the contract's source of truth)\n\n\`\`\`yaml\n${args.specYaml}\n\`\`\``);
  if (args.codeMapSlice) parts.push(`## Code map (orientation)\n\n${args.codeMapSlice}`);
  parts.push(
    `## Review feedback to address (newest last)\n\n` +
      args.feedback
        .map((f) => `### @${f.author} (${f.createdAt})\n\n${f.body.slice(0, 4000)}`)
        .join("\n\n")
  );
  parts.push(`## Current PR diff\n\n\`\`\`diff\n${args.diff}\n\`\`\``);
  return parts.join("\n\n---\n\n");
}

export interface ResubmitAgentOutcome {
  editedPaths: string[];
  summary: string;
  escalation: string | null;
  spendUsd: number;
  rounds: number;
}

/** The agent loop — pure orchestration over an injected LlmClient. */
export async function runResubmitAgent(args: {
  llm: LlmClient;
  model: string;
  repoRoot: string;
  userPrompt: string;
  maxRounds?: number;
  budgetUsd?: number;
}): Promise<ResubmitAgentOutcome> {
  const messages: LlmMessage[] = [{ role: "user", content: args.userPrompt }];
  const edited = new Set<string>();
  let spendUsd = 0;
  let rounds = 0;
  let finalText = "";
  const maxRounds = args.maxRounds ?? MAX_ROUNDS;
  const budget = args.budgetUsd ?? 5;

  for (let round = 0; round < maxRounds; round++) {
    rounds = round + 1;
    const response = await args.llm.complete({
      model: args.model,
      maxTokens: 8192,
      system: buildResubmitSystem(),
      tools: BREW_RESUBMIT_TOOLS,
      messages,
    });
    spendUsd += response.costUsd;
    if (response.text) finalText = response.text;
    const toolUses = response.toolUses ?? [];
    if (toolUses.length === 0) break;
    messages.push({ role: "assistant", content: response.text || "(tool calls)" });
    messages.push({
      role: "user",
      content: toolUses.map((t) => {
        const result = executeBrewResubmitTool(args.repoRoot, t);
        if (result.wrotePath) edited.add(result.wrotePath);
        return {
          type: "tool_result" as const,
          tool_use_id: t.id,
          content: result.content,
          is_error: result.is_error,
        };
      }),
    });
    if (spendUsd >= budget) {
      messages.push({
        role: "user",
        content: `Budget reached ($${spendUsd.toFixed(2)}). Stop editing and reply now with your summary (no tool calls).`,
      });
    }
  }

  const escalation = finalText.match(/(^|\n)ESCALATE:([\s\S]+)$/);
  return {
    editedPaths: [...edited],
    summary: finalText.trim(),
    escalation: escalation ? escalation[2]!.trim().slice(0, 2000) : null,
    spendUsd,
    rounds,
  };
}
