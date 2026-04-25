/**
 * Re-export shim + PR-body helpers.
 *
 * As of 0.13.1 (llm-agnosticism refactor): the four Anthropic-tuned
 * system prompts (SPEC_CHECKLIST_MD, RELATIONSHIP_ANALYST_SYSTEM,
 * REFINEMENT_ANALYST_SYSTEM, AMENDMENT_SYSTEM) live in
 * `@slowcook-ai/llm-anthropic/prompts/refine`. This file re-exports
 * them so existing imports keep working AND keeps the PR-body helpers
 * (`draftPrTitle`, `renderProposalsSection`, `draftPrBody`) which
 * aren't LLM-specific — they're plain markdown formatters.
 */

import type { Spec } from "@slowcook-ai/core";
import { ddlToMermaidErd } from "./mermaid.js";

export {
  SPEC_CHECKLIST_MD,
  RELATIONSHIP_ANALYST_SYSTEM,
  REFINEMENT_ANALYST_SYSTEM,
  AMENDMENT_SYSTEM,
} from "@slowcook-ai/llm-anthropic";

/** Trivial, used only as a title for the draft PR. */
export function draftPrTitle(storyId: string, title: string): string {
  return `spec: story-${storyId} — ${title}`;
}

/**
 * Render the spec's `proposals` block as a human-readable markdown
 * section for the draft-spec PR body (0.11+). Empty when there are no
 * proposals. Schema proposals get a Mermaid ERD; other categories render
 * as bullet lists. Each proposal shows its status prominently so a human
 * reviewer can tell at a glance what still needs attention.
 */
export function renderProposalsSection(spec: Spec): string {
  if (!spec.proposals) return "";
  const p = spec.proposals;
  const parts: string[] = ["## Proposals", ""];

  const statusBadge = (status: string): string => {
    switch (status) {
      case "approved":
        return "✅ approved";
      case "rejected":
        return "❌ rejected";
      case "deferred":
        return "🟡 deferred";
      case "blocked_on_clarification":
        return "❓ blocked on clarification";
      case "pending":
      default:
        return "⏳ pending";
    }
  };

  if (p.schema) {
    parts.push(`### 🗄 Schema — ${statusBadge(p.schema.status)}`, "");
    if (p.schema.rationale) parts.push(`_${p.schema.rationale}_`, "");
    const sql = typeof p.schema.sql === "string" ? p.schema.sql.trim() : "";
    if (sql) {
      parts.push(ddlToMermaidErd(sql), "", "<details><summary>Raw SQL</summary>", "", "```sql", sql, "```", "</details>", "");
    }
  }

  if (p.ui_layout) {
    parts.push(`### 🎨 UI layout — ${statusBadge(p.ui_layout.status)}`, "");
    if (p.ui_layout.rationale) parts.push(`_${p.ui_layout.rationale}_`, "");
    if (p.ui_layout.viewport_coverage?.length) {
      parts.push(`**Viewports:** ${p.ui_layout.viewport_coverage.join(", ")}`);
    }
    if (p.ui_layout.components_to_reuse?.length) {
      parts.push(`**Reuse:** ${p.ui_layout.components_to_reuse.map((c) => `\`${c}\``).join(", ")}`);
    }
    if (p.ui_layout.tokens_to_reuse?.length) {
      parts.push(`**Tokens to reuse:** ${p.ui_layout.tokens_to_reuse.map((t) => `\`${t}\``).join(", ")}`);
    }
    if (p.ui_layout.tokens_to_add?.length) {
      parts.push(`**Tokens to add:** ${p.ui_layout.tokens_to_add.map((t) => `\`${t}\``).join(", ")}`);
    }
    parts.push("");
  }

  if (p.routes) {
    parts.push(`### 🛣 Routes — ${statusBadge(p.routes.status)}`, "");
    if (p.routes.rationale) parts.push(`_${p.routes.rationale}_`, "");
    if (p.routes.paths.length > 0) {
      parts.push("| Path | File |", "| --- | --- |");
      for (const r of p.routes.paths) {
        parts.push(`| \`${r.path}\` | \`${r.file}\` |`);
      }
      parts.push("");
    }
  }

  if (p.auth) {
    parts.push(`### 🔐 Auth — ${statusBadge(p.auth.status)}`, "");
    if (p.auth.rationale) parts.push(`_${p.auth.rationale}_`, "");
    if (p.auth.requirements?.length) {
      for (const req of p.auth.requirements) parts.push(`- ${req}`);
      parts.push("");
    }
  }

  if (p.perf_budget) {
    parts.push(`### ⚡ Perf budget — ${statusBadge(p.perf_budget.status)}`, "");
    if (p.perf_budget.rationale) parts.push(`_${p.perf_budget.rationale}_`, "");
    if (p.perf_budget.budgets) {
      for (const [k, v] of Object.entries(p.perf_budget.budgets)) {
        parts.push(`- \`${k}\`: ${v}`);
      }
      parts.push("");
    }
  }

  if (p.observability) {
    parts.push(`### 📈 Observability — ${statusBadge(p.observability.status)}`, "");
    if (p.observability.rationale) parts.push(`_${p.observability.rationale}_`, "");
    if (p.observability.log_events?.length) {
      parts.push(`**Events:** ${p.observability.log_events.map((e) => `\`${e}\``).join(", ")}`);
    }
    if (p.observability.metrics?.length) {
      parts.push(`**Metrics:** ${p.observability.metrics.map((m) => `\`${m.name}\` (${m.type})`).join(", ")}`);
    }
    parts.push("");
  }

  if (p.infra) {
    parts.push(`### ☁ Infra — ${statusBadge(p.infra.status)}`, "");
    if (p.infra.rationale) parts.push(`_${p.infra.rationale}_`, "");
    if (p.infra.runtime) parts.push(`**Runtime:** \`${p.infra.runtime}\``);
    if (p.infra.deploy_target) parts.push(`**Deploy target:** \`${p.infra.deploy_target}\``);
    if (p.infra.notes) parts.push("", p.infra.notes);
    parts.push("");
  }

  if (p.api_shape) {
    parts.push(`### 🔌 API shape — ${statusBadge(p.api_shape.status)}`, "");
    if (p.api_shape.rationale) parts.push(`_${p.api_shape.rationale}_`, "");
    if (p.api_shape.endpoints?.length) {
      for (const e of p.api_shape.endpoints) {
        parts.push(`- \`${e.method} ${e.path}\``);
      }
      parts.push("");
    }
  }

  parts.push(
    "_Resolve each proposal by editing the spec YAML's `status` field (pending → approved/rejected) OR by replying to this PR with prose guidance for refine to iterate._"
  );
  return parts.join("\n");
}

export function draftPrBody(args: {
  storyId: string;
  issueNumber: number;
  supersedes: string[];
  spec?: Spec;
}): string {
  const supersedesSection =
    args.supersedes.length > 0
      ? `\n## Supersedes\n\nThis spec explicitly supersedes: ${args.supersedes
          .map((id) => `story-${id}`)
          .join(", ")}. The index has been updated to mark those stories as superseded.\n`
      : "";
  const proposalsSection = args.spec ? renderProposalsSection(args.spec) : "";
  const proposalsBlock = proposalsSection ? `\n${proposalsSection}\n` : "";
  return `Spec refined from #${args.issueNumber} by the slowcook refinement agent.

Review the YAML, edit anything that needs tightening, then mark this PR ready-for-review and merge to freeze the spec.
${supersedesSection}${proposalsBlock}
---
*Generated by \`slowcook refine\`.*`;
}
