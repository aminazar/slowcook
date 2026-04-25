import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

/**
 * Build the "project context" block that gets injected into the refinement
 * agent's system prompt. Purpose: give the agent enough grounding in the
 * consumer's domain that the PM doesn't have to re-explain vocabulary /
 * invariants / architectural basics on every issue.
 *
 * Composition (in order):
 *   1. Contents of `.brewing/context.md` verbatim (consumer-authored,
 *      deliberately distilled — not a full PRD).
 *   2. One-line summary of each active story in `specs/_index.yaml` so
 *      the agent can cross-reference prior decisions proactively.
 *
 * Both parts are optional — on a greenfield project with neither, this
 * returns a short "no context provided" note instead.
 */
export function buildProjectContext(repoRoot: string): string {
  const sections: string[] = [];

  const contextMd = readContextMd(repoRoot);
  if (contextMd) {
    sections.push("### Project overview (from `.brewing/context.md`)\n");
    sections.push(contextMd.trim());
  } else {
    sections.push(
      "### Project overview\n\n*(No `.brewing/context.md` present — consider adding one so agents don't start from zero on every issue.)*"
    );
  }

  const activeSpecs = readActiveSpecsSummary(repoRoot);
  if (activeSpecs.length > 0) {
    sections.push("\n### Active specs (cross-reference via `related_specs` when applicable)\n");
    for (const line of activeSpecs) sections.push(line);
  }

  const brownfield = readBrownfieldExtracts(repoRoot);
  if (brownfield) sections.push("\n" + brownfield);

  return sections.join("\n");
}

/**
 * 0.13.4+ (brownfield-extraction track for 0.14 mockup-first refinement) —
 * surface map's brownfield extracts (`schema.mmd`, `tokens.md`) inside
 * the agent's project context. Without this wiring the extracts sit in
 * `.brewing/diagrams/` unused. With it, refine's proposals align with
 * the existing entity vocabulary + design tokens instead of inventing.
 *
 * Optional — both files are silently skipped when missing (greenfield
 * path or consumer hasn't run `slowcook map --emit-schema --emit-tokens`).
 */
export function readBrownfieldExtracts(repoRoot: string): string | null {
  const blocks: string[] = [];

  const schemaPath = join(repoRoot, ".brewing/diagrams/schema.mmd");
  if (existsSync(schemaPath)) {
    try {
      const content = readFileSync(schemaPath, "utf8");
      blocks.push(
        "### Existing schema (extracted from `supabase/migrations/*.sql`)\n\n" +
          "Your proposals should reuse these entities by name and follow the same singular/plural conventions when adding new tables. " +
          "Foreign keys to existing entities should match the names below verbatim.\n\n" +
          "```mermaid\n" + content.trim() + "\n```"
      );
    } catch {
      // ignore
    }
  }

  const tokensPath = join(repoRoot, ".brewing/diagrams/tokens.md");
  if (existsSync(tokensPath)) {
    try {
      const content = readFileSync(tokensPath, "utf8");
      blocks.push(
        "### Existing design tokens (extracted from `**/*.css`)\n\n" +
          "Your UI proposals should reuse these tokens by name (e.g. `var(--coral)`, `bg-coral`) instead of inventing new hex/rgb values. " +
          "When the user describes a color in prose (\"red\", \"warm yellow\"), pick the closest existing token rather than introducing a new one.\n\n" +
          content.trim()
      );
    } catch {
      // ignore
    }
  }

  if (blocks.length === 0) return null;
  return "## Brownfield project awareness\n\n" + blocks.join("\n\n");
}

export function readContextMd(repoRoot: string): string | null {
  const path = join(repoRoot, ".brewing", "context.md");
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

interface IndexEntry {
  title?: string;
  status?: string;
  source_issue?: string;
  summary?: string;
  superseded_by?: string | null;
}

function readActiveSpecsSummary(repoRoot: string): string[] {
  const path = join(repoRoot, "specs", "_index.yaml");
  if (!existsSync(path)) return [];
  try {
    const doc = YAML.parse(readFileSync(path, "utf8")) as {
      stories?: Record<string, IndexEntry>;
    };
    const stories = doc.stories ?? {};
    const lines: string[] = [];
    for (const [id, entry] of Object.entries(stories)) {
      if (entry.status !== "active") continue;
      const src = entry.source_issue ? ` (from ${entry.source_issue})` : "";
      const sum = entry.summary ? ` — ${entry.summary}` : "";
      lines.push(`- **story-${id}**${src}: ${entry.title ?? "(no title)"}${sum}`);
    }
    return lines;
  } catch {
    return [];
  }
}
