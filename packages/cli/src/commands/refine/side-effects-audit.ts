/**
 * @slowcook 0.18.0+ — side-effects audit.
 *
 * After refine's relationship pass detects contradiction, this 2nd LLM
 * pass enumerates the EXACT assertions in conflicting stories that
 * would need to flip if the new issue is approved. PM reviews
 * granularly + accepts (testgen modifies the listed assertions) or
 * rejects (drop the issue).
 *
 * Replaces the prior all-or-nothing "supersede whole story" model.
 *
 * Inputs come from refine's existing context:
 *   - issue title + body
 *   - list of conflicting story IDs (from RelationshipVerdict)
 *   - repo root (to read spec yamls + test files)
 *
 * Output: structured JSON parsed into SideEffectsAudit; comment body
 * formatter elsewhere renders it as a markdown table for the PM.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { LlmClient } from "@slowcook-ai/core";
import { SIDE_EFFECTS_AUDIT_SYSTEM } from "@slowcook-ai/llm-anthropic";

export interface MustChangeEntry {
  story: string;
  file: string;
  line_range: string;
  current_assertion: string;
  required_change: string;
  reason: string;
}

export interface CompatibleEntry {
  story: string;
  assertion: string;
  reason: string;
}

export interface RemovedEntry {
  story: string;
  file: string;
  line_range: string;
  assertion: string;
  reason: string;
}

export interface SideEffectsAudit {
  must_change: MustChangeEntry[];
  compatible: CompatibleEntry[];
  removed: RemovedEntry[];
}

export interface AuditInputs {
  issueTitle: string;
  issueBody: string;
  conflictingStoryIds: string[];
  repoRoot: string;
}

export interface AuditResult {
  audit: SideEffectsAudit;
  costUsd: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreateTokens: number;
  };
}

/**
 * Run the side-effects audit. Reads conflicting specs + their tests
 * into the prompt; calls LLM; parses JSON; returns structured audit.
 */
export async function auditSideEffects(
  inputs: AuditInputs,
  opts: { llm: LlmClient; model: string }
): Promise<AuditResult> {
  const { issueTitle, issueBody, conflictingStoryIds, repoRoot } = inputs;
  const userMessage = buildUserMessage(issueTitle, issueBody, conflictingStoryIds, repoRoot);

  const response = await opts.llm.complete({
    system: SIDE_EFFECTS_AUDIT_SYSTEM,
    cacheSystem: false,
    model: opts.model,
    messages: [{ role: "user", content: userMessage }],
    maxTokens: 4096,
  });

  const audit = parseAuditJson(response.text);
  return {
    audit,
    costUsd: response.costUsd,
    usage: response.usage,
  };
}

function buildUserMessage(
  issueTitle: string,
  issueBody: string,
  conflictingStoryIds: string[],
  repoRoot: string
): string {
  const sections: string[] = [];
  sections.push("## New issue");
  sections.push("**Title:** " + issueTitle);
  sections.push("");
  sections.push(issueBody);
  sections.push("");

  for (const id of conflictingStoryIds) {
    sections.push(`## Conflicting story: ${id}`);
    const specPath = join(repoRoot, "specs", `story-${id}.yaml`);
    if (existsSync(specPath)) {
      sections.push("### Spec");
      sections.push("```yaml");
      sections.push(readFileSync(specPath, "utf8"));
      sections.push("```");
    } else {
      sections.push(`(spec file not found at specs/story-${id}.yaml — proceed with test files only)`);
    }

    sections.push("### Test files (with line numbers)");
    const testsDir = join(repoRoot, "tests/integration");
    if (existsSync(testsDir)) {
      const matchingTests = readdirSync(testsDir).filter((n) => n.startsWith(`story-${id}`));
      for (const fname of matchingTests) {
        const path = join(testsDir, fname);
        const body = readFileSync(path, "utf8");
        sections.push(`#### tests/integration/${fname}`);
        sections.push("```tsx");
        // Add line numbers so the audit can cite line ranges.
        const numbered = body
          .split("\n")
          .map((ln, i) => `${String(i + 1).padStart(4, " ")}  ${ln}`)
          .join("\n");
        sections.push(numbered);
        sections.push("```");
      }
      if (matchingTests.length === 0) {
        sections.push(`(no test files found matching story-${id}-*)`);
      }
    }
  }

  sections.push("---");
  sections.push("Audit per the system prompt; emit a single JSON object.");

  return sections.join("\n");
}

function parseAuditJson(raw: string): SideEffectsAudit {
  // Find the first { and parse from there. Be defensive — the LLM might
  // wrap JSON in code fences or prose.
  const stripped = raw.replace(/```json\s*|\s*```/g, "");
  const firstBrace = stripped.indexOf("{");
  if (firstBrace === -1) {
    throw new Error("Side-effects audit: no JSON object in LLM response");
  }
  const parsed = JSON.parse(stripped.slice(firstBrace));
  return {
    must_change: Array.isArray(parsed.must_change) ? parsed.must_change : [],
    compatible: Array.isArray(parsed.compatible) ? parsed.compatible : [],
    removed: Array.isArray(parsed.removed) ? parsed.removed : [],
  };
}

// ----- Comment body formatter -----

/**
 * Render the audit as a markdown comment for the PR. PM sees this
 * instead of the bare "blocked-contradiction" message.
 */
export function sideEffectsCommentBody(
  audit: SideEffectsAudit,
  conflictingStoryIds: string[]
): string {
  const lines: string[] = [];
  lines.push("### slowcook · side-effects audit");
  lines.push("");
  const ids = conflictingStoryIds.map((id) => `\`story-${id}\``).join(", ");
  lines.push(
    `This issue contradicts existing active spec(s): ${ids}. Below is the granular set of assertions that would need to change if you approve this issue.`
  );
  lines.push("");

  if (audit.must_change.length === 0 && audit.removed.length === 0) {
    lines.push("**Net side-effects: NONE.** The contradiction was conservatively classified — no existing assertion actually needs to change. You can proceed without superseding anything; reply with `/refine accept side-effects` to continue.");
    return lines.join("\n");
  }

  if (audit.must_change.length > 0) {
    lines.push(`#### Must change (${audit.must_change.length})`);
    lines.push("");
    lines.push("| Story | File | Lines | Currently asserts | Required change |");
    lines.push("|---|---|---|---|---|");
    for (const e of audit.must_change) {
      lines.push(
        `| story-${e.story} | \`${e.file}\` | ${e.line_range} | ${escapeForCell(e.current_assertion)} | ${escapeForCell(e.required_change)} |`
      );
    }
    lines.push("");
  }

  if (audit.removed.length > 0) {
    lines.push(`#### Removed (${audit.removed.length})`);
    lines.push("");
    lines.push("| Story | File | Lines | Assertion |");
    lines.push("|---|---|---|---|");
    for (const e of audit.removed) {
      lines.push(
        `| story-${e.story} | \`${e.file}\` | ${e.line_range} | ${escapeForCell(e.assertion)} |`
      );
    }
    lines.push("");
  }

  if (audit.compatible.length > 0) {
    lines.push(`#### Compatible — no action (${audit.compatible.length})`);
    for (const e of audit.compatible) {
      lines.push(`- story-${e.story}: ${e.assertion} — ${e.reason}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    "**Reply with `/refine accept side-effects`** (or add the `change-of-mind` label) to proceed. Testgen will modify the listed assertions when the spec is emitted."
  );
  lines.push(
    "**Reply with `/refine reject`** to drop this issue without changes."
  );
  lines.push(
    "**Or revise the issue body** to align with existing assertions; refine will re-audit on the next comment."
  );

  return lines.join("\n");
}

function escapeForCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
