/**
 * 0.19.0-α.36 — refine Pass B: reflexive brownfield-answer pass.
 *
 * After Pass A drafts clarifying questions, this second LLM call checks
 * each question against the same brownfield context Pass A saw and
 * decides whether the context already answers it. The PM only sees the
 * unanswered questions in the main comment body; the answered ones go
 * into a `<details>` audit-trail block so a technical PM can verify.
 *
 * Skipped entirely on greenfield projects (no `.brewing/context.md`,
 * no `src/lib/entities/`, no `specs/_index.yaml` entries) — there's no
 * context to draw from, so Pass B would always emit zero answers
 * and just burn an LLM call.
 *
 * The pattern mirrors `side-effects-audit.ts`: structured JSON output,
 * deterministic markdown rendering on slowcook's side.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LlmClient } from "@slowcook-ai/core";
import { BROWNFIELD_ANSWER_SYSTEM } from "@slowcook-ai/llm-anthropic";

export interface AnsweredQ {
  question: string;
  answer: string;
  source: string;
}

export interface UnansweredQ {
  question: string;
  why_unanswered: string;
}

export interface BrownfieldAnswerResult {
  answered: AnsweredQ[];
  unanswered: UnansweredQ[];
  costUsd: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
  };
}

/**
 * Detect whether the consumer's repo has ANY brownfield signal that
 * Pass B could draw from. Greenfield = none of these present:
 *
 *   - `.brewing/context.md` with non-empty content
 *   - `src/lib/entities/*.ts` (at least one entity file)
 *   - `specs/_index.yaml` (at least one active story)
 *   - `.brewing/diagrams/entities.md` or `.brewing/diagrams/schema.mmd`
 *
 * Cheap check (filesystem stat + small reads). No LLM. Used to gate
 * Pass B so greenfield projects don't pay for an empty-answer call.
 */
export function hasBrownfield(repoRoot: string): boolean {
  // 1. context.md with body
  try {
    const p = join(repoRoot, ".brewing", "context.md");
    if (existsSync(p) && statSync(p).size > 20) return true;
  } catch {
    /* fall through */
  }
  // 2. entities/
  try {
    const dir = join(repoRoot, "src", "lib", "entities");
    if (
      existsSync(dir) &&
      readdirSync(dir).some((f) => f.endsWith(".ts") && f !== "index.ts")
    ) {
      return true;
    }
  } catch {
    /* fall through */
  }
  // 3. specs index with stories
  try {
    const p = join(repoRoot, "specs", "_index.yaml");
    if (existsSync(p)) {
      const body = readFileSync(p, "utf8");
      // crude: look for any `story_id:` or 1+ keyed entry under stories:.
      if (/\bstory_id:|\n\s{2,}\w[\w-]*:/.test(body)) return true;
    }
  } catch {
    /* fall through */
  }
  // 4. brownfield extracts
  for (const rel of [
    ".brewing/diagrams/entities.md",
    ".brewing/diagrams/schema.mmd",
    ".brewing/tokens.md",
  ]) {
    try {
      if (existsSync(join(repoRoot, rel))) return true;
    } catch {
      /* fall through */
    }
  }
  return false;
}

export interface BrownfieldAnswerInputs {
  draftQuestionsMarkdown: string;
  projectContext: string;
  mockExcerpt?: string;
}

/**
 * Run Pass B. Returns structured answered/unanswered split + cost.
 * Throws on JSON parse failure — caller decides whether to fall back
 * (today: caller catches + posts the original Pass A markdown unchanged).
 */
export async function answerQuestionsFromBrownfield(
  inputs: BrownfieldAnswerInputs,
  opts: { llm: LlmClient; model: string }
): Promise<BrownfieldAnswerResult> {
  const userMessage = buildUserMessage(inputs);
  const response = await opts.llm.complete({
    system: BROWNFIELD_ANSWER_SYSTEM,
    cacheSystem: false,
    model: opts.model,
    messages: [{ role: "user", content: userMessage }],
    maxTokens: 4096,
  });
  const { answered, unanswered } = parseAnswerJson(response.text);
  return {
    answered,
    unanswered,
    costUsd: response.costUsd,
    usage: response.usage,
  };
}

function buildUserMessage(inputs: BrownfieldAnswerInputs): string {
  const sections: string[] = [];
  sections.push("## Brownfield context (what Pass A saw)");
  sections.push("");
  sections.push(inputs.projectContext);
  if (inputs.mockExcerpt && inputs.mockExcerpt.trim()) {
    sections.push("");
    sections.push("## Mock excerpt (design source-of-truth for this story)");
    sections.push("");
    sections.push("```tsx");
    sections.push(inputs.mockExcerpt);
    sections.push("```");
  }
  sections.push("");
  sections.push("## Pass A's draft questions (markdown)");
  sections.push("");
  sections.push(inputs.draftQuestionsMarkdown);
  sections.push("");
  sections.push(
    "Emit the JSON object only — no prose, no fences. Copy questions verbatim including any (a)/(b)/(c) options."
  );
  return sections.join("\n");
}

/**
 * Parse Pass B's JSON output. Tolerant of stray code fences / leading
 * prose (the model occasionally adds "Here is the JSON:" despite the
 * prompt). Falls back to JSON.parse of the largest brace-balanced
 * substring.
 */
export function parseAnswerJson(text: string): {
  answered: AnsweredQ[];
  unanswered: UnansweredQ[];
} {
  let raw = text.trim();
  // Strip markdown code-fence wrappers if the model added them.
  raw = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  // If the model prefixed prose, find the first { and matching close.
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace > 0 && lastBrace > firstBrace) {
    raw = raw.slice(firstBrace, lastBrace + 1);
  }
  const parsed = JSON.parse(raw) as { answered?: unknown; unanswered?: unknown };
  const answered = Array.isArray(parsed.answered)
    ? parsed.answered.filter(isAnsweredQ)
    : [];
  const unanswered = Array.isArray(parsed.unanswered)
    ? parsed.unanswered.filter(isUnansweredQ)
    : [];
  return { answered, unanswered };
}

function isAnsweredQ(x: unknown): x is AnsweredQ {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.question === "string" &&
    typeof r.answer === "string" &&
    typeof r.source === "string"
  );
}

function isUnansweredQ(x: unknown): x is UnansweredQ {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return typeof r.question === "string" && typeof r.why_unanswered === "string";
}

/**
 * Render the `<details>` audit-trail block listing brownfield-answered
 * questions. Returns empty string when there are no answered Qs (no
 * point spamming the comment with an empty disclosure).
 */
export function formatAnsweredDetails(answered: AnsweredQ[]): string {
  if (answered.length === 0) return "";
  const lines: string[] = [];
  lines.push("");
  lines.push(
    `<details>\n<summary>🔍 <strong>${answered.length} question${answered.length === 1 ? "" : "s"} answered from brownfield context (audit trail)</strong></summary>\n`
  );
  lines.push("");
  lines.push(
    `_I checked the entities digest, active specs, brownfield extracts, and mock before asking the PM. These would have been questions, but the answer was already in the codebase:_\n`
  );
  answered.forEach((a, i) => {
    lines.push(`**${i + 1}. ${a.question.trim()}**`);
    lines.push("");
    lines.push(`Answer: ${a.answer.trim()}`);
    lines.push("");
    lines.push(`Source: \`${a.source.trim()}\``);
    lines.push("");
  });
  lines.push("</details>");
  return lines.join("\n");
}

/**
 * Render the visible PM-facing question list from `unanswered`. Each
 * question text is preserved verbatim (Pass A's labeled-options format
 * survives). Numbered list, blank-line separated. Empty when there are
 * no unanswered Qs (caller decides what to do — probably emit a spec
 * directly next round, or post a "nothing more to ask" note).
 */
export function formatUnansweredQuestions(unanswered: UnansweredQ[]): string {
  if (unanswered.length === 0) return "";
  return unanswered
    .map((u, i) => `**${i + 1}.** ${u.question.trim()}`)
    .join("\n\n");
}

/**
 * Compose the final question-comment markdown body, replacing Pass A's
 * raw questions output with the Pass B filtered view + audit details.
 * Leading "I checked first..." note appears only when at least one
 * answer was found, so greenfield-like cases (Pass B ran but found
 * nothing) don't show a misleading "I checked first" banner.
 */
export function composePassBComment(
  result: BrownfieldAnswerResult,
  fallbackMarkdown: string
): string {
  const totalQs = result.answered.length + result.unanswered.length;
  // If Pass B parsed zero questions altogether — most likely a parse
  // glitch where the model didn't return either array. Fall back to
  // Pass A's original markdown so we never lose the questions entirely.
  if (totalQs === 0) return fallbackMarkdown;
  const lines: string[] = [];
  if (result.answered.length > 0) {
    lines.push(
      `_🔍 Checked brownfield first: **${result.answered.length} of ${totalQs}** question${totalQs === 1 ? "" : "s"} already answered in your codebase (see audit trail below). **${result.unanswered.length}** still need${result.unanswered.length === 1 ? "s" : ""} your input:_`
    );
    lines.push("");
  }
  if (result.unanswered.length > 0) {
    lines.push(formatUnansweredQuestions(result.unanswered));
  } else {
    lines.push(
      `_✅ All ${result.answered.length} draft questions were answered from brownfield context. I'll proceed to emit the spec on the next pass — re-trigger this agent (remove + re-add the \`needs-refinement\` label) when you've confirmed the audit trail below._`
    );
  }
  lines.push(formatAnsweredDetails(result.answered));
  return lines.join("\n");
}
