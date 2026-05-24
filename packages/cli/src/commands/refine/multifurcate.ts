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

import type { LlmClient, Spec } from "@slowcook-ai/core";
import { MULTIFURCATION_SYSTEM } from "@slowcook-ai/llm-anthropic";

/**
 * One existing spec the model needs to be aware of when proposing a
 * split, so it can mark sub-issues that overlap with active scope
 * INSTEAD of silently omitting them. The PM needs to see the full
 * picture, not a hidden side-channel.
 *
 * Built from `listActiveSpecs(repoRoot)` — a single line of Spec.
 */
export interface ActiveSpecDigest {
  story_id: string;
  title: string;
  summary: string;
}

export interface MultifurcationSubIssue {
  title: string;
  summary: string;
  /** Optional — titles of OTHER sub-issues this one depends on landing first. */
  depends_on?: string[];
  /**
   * cli α.45 — set when the proposed sub-issue's scope is already covered
   * by an active spec. The PM still sees the sub-issue (so the parent
   * issue's full scope is visible), but the comment renders an "Already
   * covered by story-NNN" annotation and the PM can fold it into the
   * existing story rather than opening a duplicate.
   */
  existing_spec_id?: string;
}

export type MultifurcationVerdict =
  | { kind: "one"; rationale: string }
  | { kind: "many"; rationale: string; sub_issues: MultifurcationSubIssue[] };

export interface MultifurcationInputs {
  issueTitle: string;
  issueBody: string;
  /**
   * cli α.45 — list of currently active specs in this repo. The
   * multifurcation prompt uses them to annotate sub-issues that
   * overlap with existing scope (story_id is the PM-visible
   * reference; title + summary give the model enough context to
   * decide whether overlap is real).
   *
   * Empty array is fine — model just won't tag anything.
   */
  activeSpecs?: ActiveSpecDigest[];
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
  const userMessage = buildMultifurcationUserMessage(inputs);
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
 * Compose the user-side message. Exported for tests so the snapshot can
 * assert active-specs context lands where the model expects it.
 */
export function buildMultifurcationUserMessage(inputs: MultifurcationInputs): string {
  const sections: string[] = [];
  sections.push("## Issue under review");
  sections.push(`### Title\n${inputs.issueTitle}`);
  sections.push(`### Body\n${inputs.issueBody || "(empty body)"}`);

  const specs = inputs.activeSpecs ?? [];
  if (specs.length > 0) {
    sections.push("## Active specs in this repo");
    sections.push(
      "If any proposed sub-issue's scope is ALREADY covered by one of these, " +
        "set `existing_spec_id` to that story_id in the sub-issue object. " +
        "Still include the sub-issue in the proposal — the PM needs the full picture, " +
        "the annotation tells them this slice is already on the ratchet. " +
        "Do NOT silently omit overlapping sub-issues."
    );
    for (const s of specs) {
      const summary = s.summary && s.summary.length > 0 ? ` — ${s.summary}` : "";
      sections.push(`- **story-${s.story_id}** "${s.title}"${summary}`);
    }
  }

  sections.push("Return the JSON verdict per the system prompt.");
  return sections.join("\n\n");
}

/**
 * Compact a Spec list down to the digest shape the multifurcation
 * prompt consumes. Summary is the first ~150 chars of the first
 * acceptance scenario (the most spec-like prose); falls back to a
 * non_goal or empty string.
 */
export function digestActiveSpecs(specs: Spec[]): ActiveSpecDigest[] {
  return specs.map((s) => {
    const firstScenario = s.acceptance_scenarios[0] ?? "";
    const firstInvariant = s.invariants[0] ?? "";
    const raw = firstScenario || firstInvariant || s.non_goals[0] || "";
    const summary = raw.replace(/\s+/g, " ").trim().slice(0, 150);
    return { story_id: s.story_id, title: s.title, summary };
  });
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
      // cli α.45 — overlap annotation. Accept variants the model may
      // emit (existing_spec_id, story_id, covered_by_story) and
      // normalize to plain digit-suffix form ("002" not "story-002").
      const rawId =
        (typeof e.existing_spec_id === "string" && e.existing_spec_id) ||
        (typeof e.covered_by_story === "string" && e.covered_by_story) ||
        (typeof e.story_id === "string" && e.story_id) ||
        "";
      const normalised = rawId.trim().replace(/^story-/i, "");
      if (normalised.length > 0) item.existing_spec_id = normalised;
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
  const overlapCount = proposal.sub_issues.filter((s) => s.existing_spec_id).length;
  lines.push(
    `#### Proposed sub-issues (${proposal.sub_issues.length}${overlapCount > 0 ? `, ${overlapCount} overlap existing specs` : ""})`
  );
  lines.push("");
  for (let i = 0; i < proposal.sub_issues.length; i++) {
    const s = proposal.sub_issues[i]!;
    const overlapBadge = s.existing_spec_id
      ? ` _(already covered by story-${escapeMd(s.existing_spec_id)})_`
      : "";
    lines.push(`**${i + 1}. ${escapeMd(s.title)}**${overlapBadge}`);
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
    "- 👍 **Looks right** → file each sub-issue that DOESN'T have an _already covered by_ tag. For tagged ones, decide per row whether to fold them into the existing story (comment on that story) or skip. Then close this one or remove `needs-refinement` from it."
  );
  lines.push(
    "- ✏️ **Needs tweaking** → reply with the edited list (edit titles, drop or add entries, change overlap calls). Remove the `slowcook-multifurcation-proposed` label and I'll re-propose."
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
