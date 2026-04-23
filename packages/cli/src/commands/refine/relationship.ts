import { z } from "zod";
import type { LlmClient } from "./llm.js";
import type { Spec, RelationshipVerdict, ForgeAdapter } from "@slowcook-ai/core";
import { RELATIONSHIP_ANALYST_SYSTEM } from "./prompts.js";

const VerdictSchema = z.object({
  kind: z.enum(["new_or_independent", "follow_up", "overlap", "contradiction"]),
  conflicting_ids: z.array(z.string()),
  reasoning: z.string(),
});

export interface RelationshipInput {
  issueTitle: string;
  issueBody: string;
  activeSpecs: Spec[];
}

export interface RelationshipOptions {
  llm: LlmClient;
  model: string;
}

export interface RelationshipResult {
  verdict: RelationshipVerdict;
  costUsd: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
  };
  model: string;
}

export async function analyzeRelationship(
  input: RelationshipInput,
  options: RelationshipOptions
): Promise<RelationshipResult> {
  const userMessage = buildUserMessage(input);
  const response = await options.llm.complete({
    system: RELATIONSHIP_ANALYST_SYSTEM,
    cacheSystem: true,
    model: options.model,
    messages: [{ role: "user", content: userMessage }],
    maxTokens: 1024,
    // temperature omitted — newer reasoning-enabled Claude models reject it.
  });

  return {
    verdict: parseVerdict(response.text),
    costUsd: response.costUsd,
    usage: response.usage,
    model: response.model,
  };
}

function buildUserMessage(input: RelationshipInput): string {
  const specSection =
    input.activeSpecs.length === 0
      ? "There are no active specs yet."
      : input.activeSpecs
          .map((s) => `### story-${s.story_id} — ${s.title} (status: ${s.status})\n` + specSummary(s))
          .join("\n\n");

  return `## New issue

Title: ${input.issueTitle}

Body:
${input.issueBody}

## Existing active specs

${specSection}

## Task

Classify the relationship of the new issue to the existing specs. Respond with ONLY JSON per the schema in your system prompt.`;
}

function specSummary(spec: Spec): string {
  const lines: string[] = [];
  if (spec.invariants.length) {
    lines.push(`Invariants: ${spec.invariants.join("; ")}`);
  }
  if (spec.api_contract && spec.api_contract.length) {
    const endpoints = spec.api_contract
      .map((e) => {
        const obj = e as { method?: string; path?: string };
        return `${obj.method ?? "?"} ${obj.path ?? "?"}`;
      })
      .join(", ");
    lines.push(`API: ${endpoints}`);
  }
  if (spec.acceptance_scenarios.length) {
    lines.push(`Acceptance: ${spec.acceptance_scenarios.slice(0, 3).join(" / ")}`);
  }
  if (spec.non_goals.length) {
    lines.push(`Non-goals: ${spec.non_goals.join("; ")}`);
  }
  return lines.join("\n");
}

export function parseVerdict(raw: string): RelationshipVerdict {
  const cleaned = extractJsonObject(raw);
  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(
      `Relationship analyst returned non-JSON. First 300 chars: ${cleaned.slice(0, 300)}`
    );
  }
  const parsed = VerdictSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Relationship analyst output failed schema validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`
    );
  }
  const v = parsed.data;
  if (v.kind === "new_or_independent") {
    return { kind: "new_or_independent", reasoning: v.reasoning };
  }
  if (v.kind === "follow_up") {
    return { kind: "follow_up", related_ids: v.conflicting_ids, reasoning: v.reasoning };
  }
  if (v.kind === "overlap") {
    return { kind: "overlap", conflicting_ids: v.conflicting_ids, reasoning: v.reasoning };
  }
  return { kind: "contradiction", conflicting_ids: v.conflicting_ids, reasoning: v.reasoning };
}

/** Best-effort extraction of a JSON object from LLM output that may contain prose. */
function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  // Direct JSON?
  if (trimmed.startsWith("{")) return trimmed;
  // Fenced code block?
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) return fence[1].trim();
  // First brace through matching brace?
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

/**
 * Format a spec reference for user-facing prose (issue comments, PR bodies).
 * Prefers GitHub's native issue-number reference (\`#N\`) which auto-renders
 * as a hyperlink. Falls back to the internal \`story-N\` id if the spec has
 * no \`source_issue\` recorded.
 *
 * Inside YAML specs and internal slowcook state, keep using \`story-N\` —
 * it's the stable canonical identifier. This function is only for prose.
 */
export function specRefForProse(spec: Spec): string {
  const issueNum = spec.source_issue?.match(/#?(\d+)/)?.[1];
  if (issueNum) return `#${issueNum} (story-${spec.story_id})`;
  return `story-${spec.story_id}`;
}

function specsRef(ids: string[], activeSpecs: Spec[]): string {
  return ids
    .map((id) => {
      const found = activeSpecs.find((s) => s.story_id === id);
      if (found) return specRefForProse(found);
      return `\`story-${id}\``;
    })
    .join(", ");
}

/** Comment body posted to the issue when relationship analysis surfaces a conflict. */
export function overlapCommentBody(
  verdict: Extract<RelationshipVerdict, { kind: "overlap" }>,
  activeSpecs: Spec[] = []
): string {
  const specs = specsRef(verdict.conflicting_ids, activeSpecs);
  return `### slowcook · overlap detected

This issue overlaps with existing active specs: ${specs}.

**Reasoning:** ${verdict.reasoning}

Please choose how to proceed:

- **Merge**: close this issue and extend the overlapping spec. Comment \`/slowcook merge-into story-<id>\` and I'll relabel.
- **Delta**: reframe this issue to cover only what the overlapping spec doesn't (and say so in the body). I'll re-analyze on the next comment.
- **Duplicate**: close this issue if it's entirely covered.

I'll pause refinement until the issue body or labels are updated.`;
}

/**
 * Comment body for the follow_up verdict — posted informationally, does NOT
 * halt refinement. Tells the PM "I noticed this builds on X, will cite it in
 * the resulting spec, proceeding with refinement now."
 */
export function followUpCommentBody(
  verdict: Extract<RelationshipVerdict, { kind: "follow_up" }>,
  activeSpecs: Spec[] = []
): string {
  const specs = specsRef(verdict.related_ids, activeSpecs);
  return `### slowcook · follow-up detected

This issue builds on top of ${specs} — it fulfills scope the prior spec(s) explicitly deferred via \`non_goals\` or "future story" phrasing. That's a legitimate scope-growth pattern, not a duplication. **Continuing with refinement.**

**Reasoning:** ${verdict.reasoning}

The resulting spec will list the predecessor(s) in its \`related_specs\` field so the chain is auditable.`;
}

export function contradictionCommentBody(
  verdict: Extract<RelationshipVerdict, { kind: "contradiction" }>,
  hasChangeOfMind: boolean,
  activeSpecs: Spec[] = []
): string {
  const specs = specsRef(verdict.conflicting_ids, activeSpecs);
  if (hasChangeOfMind) {
    return `### slowcook · change-of-mind authorized

This issue contradicts existing active specs: ${specs}. The \`change-of-mind\` label is present, so I'll proceed with refinement; the resulting spec will explicitly supersede those stories.

**Reasoning:** ${verdict.reasoning}

Proceeding with clarifying questions...`;
  }
  return `### slowcook · contradiction — refinement blocked

This issue contradicts existing active specs: ${specs}.

**Reasoning:** ${verdict.reasoning}

The ratchet means previously-accepted decisions stay in force unless explicitly revoked. To proceed:

- If this is a **genuine change of mind**, add the \`change-of-mind\` label and re-comment. I will then refine the spec with explicit \`supersedes\` tracking.
- If this is an **accidental conflict**, revise the issue body to align with the existing specs and remove the contradiction. I'll re-analyze on the next comment.
- If you intend the overlapping specs to **coexist** and think this isn't a real contradiction, add a comment explaining the independence and I'll re-classify.

I've added the \`blocked-contradiction\` label for visibility.`;
}
