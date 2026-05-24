/**
 * @slowcook 0.19.0-α.44 — multifurcation pre-step.
 *
 * Some GitHub issues are not stories. They are programs of work disguised
 * as tickets ("everything according to mock", "rewrite the patient app",
 * "wire X to Y" where X and Y are whole subsystems). Forcing those
 * through refine produces a fuzzy mega-spec that no downstream agent can
 * reasonably implement.
 *
 * This module runs a cheap LLM pass BEFORE refine's relationship +
 * refinement calls. It returns either:
 *
 *   - { kind: "one", rationale } — refine proceeds normally
 *   - { kind: "many", sub_issues, rationale } — refine posts a
 *     PM-facing proposal listing the proposed sub-issues + halts; the
 *     PM decides whether to file the split. The original issue is
 *     marked `slowcook-multifurcation-proposed` so refine doesn't loop.
 *
 * Sub-issue titles + summaries are PM-style by contract (see prompt
 * rules): intent-shaped, no file paths or pipeline names, ≤ 80 char
 * titles, 1-3 sentence summaries. Quality of the proposal is the
 * PM's call — the comment template makes editing easy.
 */

import type { LlmClient } from "@slowcook-ai/core";
import { MULTIFURCATION_SYSTEM } from "@slowcook-ai/llm-anthropic";

export interface MultifurcationSubIssue {
  title: string;
  summary: string;
  /** Optional — titles of OTHER sub-issues this one depends on landing first. */
  depends_on?: string[];
}

export type MultifurcationVerdict =
  | { kind: "one"; rationale: string }
  | { kind: "many"; rationale: string; sub_issues: MultifurcationSubIssue[] };

export interface MultifurcationInputs {
  issueTitle: string;
  issueBody: string;
}

export interface MultifurcationResult {
  verdict: MultifurcationVerdict;
  costUsd: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
  };
}

export async function assessMultifurcation(
  inputs: MultifurcationInputs,
  opts: { llm: LlmClient; model: string }
): Promise<MultifurcationResult> {
  const userMessage = `## Issue under review\n\n### Title\n${inputs.issueTitle}\n\n### Body\n${inputs.issueBody || "(empty body)"}\n\nReturn the JSON verdict per the system prompt.`;

  const response = await opts.llm.complete({
    system: MULTIFURCATION_SYSTEM,
    cacheSystem: false,
    model: opts.model,
    messages: [{ role: "user", content: userMessage }],
    maxTokens: 2048,
  });

  return {
    verdict: parseMultifurcationJson(response.text),
    costUsd: response.costUsd,
    usage: response.usage,
  };
}

/**
 * Parse the JSON verdict. Tolerant of leading/trailing prose (some
 * models still wrap JSON in fences despite the prompt). Defaults to
 * `{ kind: "one", rationale: "(parser fallback — model output unparseable)" }`
 * so that an LLM hiccup never blocks refine.
 */
export function parseMultifurcationJson(text: string): MultifurcationVerdict {
  const json = extractJsonBlob(text);
  if (!json) {
    return {
      kind: "one",
      rationale: "(parser fallback — model output unparseable, treating as single story)",
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {
      kind: "one",
      rationale: "(parser fallback — JSON parse failed)",
    };
  }
  if (!raw || typeof raw !== "object") {
    return { kind: "one", rationale: "(parser fallback — non-object verdict)" };
  }
  const o = raw as Record<string, unknown>;
  const verdict = typeof o.verdict === "string" ? o.verdict.toLowerCase() : "";
  const rationale = typeof o.rationale === "string" ? o.rationale.trim() : "";

  if (verdict === "one") {
    return { kind: "one", rationale: rationale || "(no rationale provided)" };
  }
  if (verdict === "many") {
    const subRaw = Array.isArray(o.sub_issues) ? o.sub_issues : [];
    const sub_issues: MultifurcationSubIssue[] = [];
    for (const entry of subRaw) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const title = typeof e.title === "string" ? e.title.trim() : "";
      const summary = typeof e.summary === "string" ? e.summary.trim() : "";
      if (!title || !summary) continue;
      const depRaw = Array.isArray(e.depends_on) ? e.depends_on : [];
      const depends_on = depRaw
        .filter((d): d is string => typeof d === "string" && d.trim().length > 0)
        .map((d) => d.trim());
      const item: MultifurcationSubIssue = { title, summary };
      if (depends_on.length > 0) item.depends_on = depends_on;
      sub_issues.push(item);
    }
    // Guardrail: if the model said "many" but failed to produce ≥2 valid
    // sub-issues, fall back to "one" rather than emit a broken proposal.
    // Always tag the rationale so downstream logs reveal the downgrade.
    if (sub_issues.length < 2) {
      const prefix =
        "(parser fallback — verdict was many but fewer than 2 valid sub-issues parsed)";
      return {
        kind: "one",
        rationale: rationale ? `${prefix} · original rationale: ${rationale}` : prefix,
      };
    }
    return {
      kind: "many",
      rationale: rationale || "(no rationale provided)",
      sub_issues,
    };
  }
  return {
    kind: "one",
    rationale: rationale || `(parser fallback — unknown verdict "${verdict}")`,
  };
}

/**
 * Extract the first balanced { ... } JSON blob from raw model text.
 * Strips common decorations: leading prose, ```json fences, trailing
 * commentary. Returns null if no balanced object is found.
 */
function extractJsonBlob(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fenced && fenced[1]) return fenced[1];

  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * PM-facing comment body listing the proposed sub-issues. The template
 * mirrors the refine "questions-first" layout — proposal up top, agent's
 * rationale folded into a <details> block, action prompts at the bottom.
 *
 * The HTML comment `<!-- slowcook:multifurcation -->` is a sentinel
 * future refine runs grep for to skip re-proposing on the same issue.
 */
export function multifurcationCommentBody(
  proposal: { rationale: string; sub_issues: MultifurcationSubIssue[] },
  opts: { issueTitle: string }
): string {
  const lines: string[] = [];
  lines.push("<!-- slowcook:multifurcation -->");
  lines.push("### slowcook · refinement agent 🍲");
  lines.push("");
  lines.push(
    `This issue looks like **more than one story** to me. Before I produce a spec, please confirm the split below — refine ships one PR per story, and a single mega-spec usually misses the things that matter at each user-facing slice.`
  );
  lines.push("");
  lines.push(`#### Proposed sub-issues (${proposal.sub_issues.length})`);
  lines.push("");
  for (let i = 0; i < proposal.sub_issues.length; i++) {
    const s = proposal.sub_issues[i]!;
    lines.push(`**${i + 1}. ${escapeMd(s.title)}**`);
    lines.push("");
    lines.push(escapeMd(s.summary));
    if (s.depends_on && s.depends_on.length > 0) {
      lines.push("");
      lines.push(`_Depends on: ${s.depends_on.map((d) => `"${d}"`).join(", ")}_`);
    }
    lines.push("");
  }
  lines.push("<details><summary>Why I think this should split</summary>");
  lines.push("");
  lines.push(proposal.rationale);
  lines.push("");
  lines.push("</details>");
  lines.push("");
  lines.push("#### What to do");
  lines.push("");
  lines.push(
    "- 👍 **Looks right** → file each sub-issue, then close this one (or remove `needs-refinement` from it). Each sub-issue runs through refine independently."
  );
  lines.push(
    "- ✏️ **Needs tweaking** → reply with the edited list (edit titles, drop or add entries). Remove the `slowcook-multifurcation-proposed` label and I'll re-propose."
  );
  lines.push(
    "- 👎 **Keep as one** → reply \"keep as one\" and remove both labels (`slowcook-multifurcation-proposed` and `needs-refinement`, then re-add `needs-refinement`). I'll proceed with a single spec."
  );
  lines.push("");
  lines.push(
    `_For context, the original title was: **${escapeMd(opts.issueTitle)}**_`
  );
  return lines.join("\n");
}

function escapeMd(s: string): string {
  return s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Detect whether a multifurcation proposal has already been posted on
 * an issue's comment thread. Used by the agent to skip re-running the
 * LLM pass when the PM is still deciding.
 */
export function hasExistingMultifurcationComment(
  comments: Array<{ body: string }>
): boolean {
  return comments.some((c) => c.body.includes("<!-- slowcook:multifurcation -->"));
}
