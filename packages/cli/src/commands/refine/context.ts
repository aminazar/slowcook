import { readFileSync, existsSync, readdirSync } from "node:fs";
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

  const historyDigest = readHistoryIndexDigest(repoRoot);
  if (historyDigest) sections.push("\n" + historyDigest);

  const entitiesDigest = readEntitiesDigest(repoRoot);
  if (entitiesDigest) sections.push("\n" + entitiesDigest);

  return sections.join("\n");
}

/**
 * 0.18.0-α.6 — surface a digest of `src/lib/entities/*.ts` (emitted by
 * `slowcook init entities` from the consumer's database migrations).
 * These are the canonical types every agent (refine, vibe, testgen,
 * plate, brew) must use when its spec/component/test references a
 * domain entity. Eliminates the prop-shape drift class (story-018's
 * `profile`/`owner` divergence between testgen + mock).
 */
export function readEntitiesDigest(repoRoot: string): string | null {
  const dir = join(repoRoot, "src/lib/entities");
  if (!existsSync(dir)) return null;
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "index.ts").sort();
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const lines: string[] = [];
  lines.push("## Entities (auto-generated from supabase/migrations)\n");
  lines.push(
    "These TypeScript interfaces + zod schemas under `src/lib/entities/` are the canonical types for the consumer's domain. Every agent — refine, vibe, testgen, plate, brew — MUST import from `@/lib/entities` when referencing domain shape. Don't redeclare entity props inline; if a domain field is missing, surface a refine-stage gap (entity needs a column → migration → regenerate)."
  );
  lines.push("");
  for (const file of files) {
    const tableName = file.replace(/\.ts$/, "");
    const path = join(dir, file);
    let body = "";
    try { body = readFileSync(path, "utf8"); } catch { continue; }
    const interfaceMatch = body.match(/export interface (\w+) \{([\s\S]*?)\n\}/);
    if (!interfaceMatch || !interfaceMatch[1] || !interfaceMatch[2]) continue;
    const typeName = interfaceMatch[1];
    const cols = interfaceMatch[2]
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//") && !l.startsWith("*"))
      .map((l) => {
        // strip trailing comments + JSDoc, normalise spacing
        const cleaned = l.replace(/\/\*\*[^*]*\*\//g, "").replace(/\/\/.*$/, "").replace(/;$/, "").trim();
        return cleaned;
      })
      .filter((l) => l.length > 0);
    if (cols.length === 0) continue;
    lines.push(`### ${typeName} \`@/lib/entities/${tableName}\``);
    for (const col of cols.slice(0, 30)) {
      lines.push(`- ${col}`);
    }
    if (cols.length > 30) lines.push(`- … ${cols.length - 30} more (see file)`);
    lines.push("");
  }
  lines.push(
    "Import the barrel for convenience: `import type { Profiles, Rewos, RewoReactions } from \"@/lib/entities\";`"
  );
  lines.push("");
  return lines.join("\n");
}

/**
 * 0.17.0 — surface a digest of `.brewing/history-index.json` (emitted by
 * the refine entry point before the LLM runs). The digest lists existing
 * components + props, API routes, migrations + columns, and test helpers
 * so refine asks the right brownfield-conflict questions instead of
 * letting downstream agents collide on duplicate names + prop shapes.
 *
 * Truncation: the full index can be large; refine doesn't need EVERY
 * field, only the names + signatures. Full file is on disk for vibe +
 * testgen to consume in detail.
 */
export function readHistoryIndexDigest(repoRoot: string): string | null {
  const path = join(repoRoot, ".brewing/history-index.json");
  if (!existsSync(path)) return null;
  try {
    const idx = JSON.parse(readFileSync(path, "utf8")) as {
      components?: Array<{ name: string; file: string; props: string[]; tests_covering: string[] }>;
      api_routes?: Array<{ method: string; path: string; file: string }>;
      migrations?: Array<{ file: string; tables_created: string[]; columns_added: Record<string, string[]> }>;
      test_helpers?: Array<{ name: string; file: string; purpose: string }>;
      mock_surface?: Array<{ file: string; route: string | null; name: string; excerpt: string }>;
    };
    const lines: string[] = [];
    lines.push("## Code history index (auto-generated; treat as authoritative)\n");
    lines.push(
      "Refine MUST consult this index when deciding whether the new spec extends, supersedes, or duplicates existing surface area. Reference entries by name in your Q&A so the PM sees you've grounded against current code."
    );
    lines.push("");

    if (idx.components && idx.components.length > 0) {
      lines.push("### Existing components (with prop shape + test coverage)");
      for (const c of idx.components) {
        const propsStr = c.props.length > 0 ? ` props={${c.props.join(", ")}}` : " (no Props interface found)";
        const cov = c.tests_covering.length > 0 ? ` covered by ${c.tests_covering.length} test(s)` : " (uncovered)";
        lines.push(`- **${c.name}** \`${c.file}\`${propsStr}${cov}`);
      }
      lines.push("");
    }

    if (idx.api_routes && idx.api_routes.length > 0) {
      lines.push("### Existing API routes");
      for (const r of idx.api_routes) {
        lines.push(`- ${r.method} ${r.path} \`${r.file}\``);
      }
      lines.push("");
    }

    if (idx.migrations && idx.migrations.length > 0) {
      lines.push("### Existing migrations (tables + columns)");
      for (const m of idx.migrations) {
        const tablesStr = m.tables_created.length > 0
          ? `creates ${m.tables_created.join(", ")}`
          : "alters existing tables";
        lines.push(`- \`${m.file}\` — ${tablesStr}`);
      }
      lines.push("");
      lines.push("Column-level detail is in `.brewing/history-index.json`.");
      lines.push("");
    }

    // 0.19.0-α.23 — mock surface is the consumer's hand-authored
    // design source-of-truth. When the PM says "match the mock" or
    // gestures at an existing flow, refine reads the actual mock JSX
    // here instead of asking the PM for paths.
    if (idx.mock_surface && idx.mock_surface.length > 0) {
      lines.push("### Mock surface (design source-of-truth)");
      lines.push(
        "These are the consumer's hand-authored mock pages/components. When the PM says \"match the mock\" or references an existing flow without citing a file, treat these as the canonical design. Mirror layout, role toggles, copy, and behavior in your spec; only deviate when the PM explicitly asks."
      );
      lines.push("");
      for (const m of idx.mock_surface) {
        const routeLabel = m.route ? `route \`${m.route}\`` : "component";
        lines.push(`<details><summary><strong>${m.name}</strong> — ${routeLabel} (\`${m.file}\`)</summary>\n`);
        lines.push("```tsx");
        lines.push(m.excerpt);
        lines.push("```");
        lines.push("</details>\n");
      }
      lines.push("");
    }

    if (idx.test_helpers && idx.test_helpers.length > 0) {
      lines.push("### Existing test helpers (use these idioms; don't invent new mocking patterns)");
      for (const h of idx.test_helpers.slice(0, 30)) {
        const purpose = h.purpose ? ` — ${h.purpose}` : "";
        lines.push(`- \`${h.name}\` from \`${h.file}\`${purpose}`);
      }
      lines.push("");
    }

    lines.push("### Brownfield-conflict Q&A discipline");
    lines.push(
      "Before emitting the spec, scan the new requirements against this index. If ANY of these conflicts exist, ask the PM in your Q&A round:"
    );
    lines.push(
      "- A required component name matches an existing component but with INCOMPATIBLE prop shape → ask: \"Component X exists with props {Y}; new spec implies props {Z}. Extend (back-compat) or replace (breaks tests covering it)?\""
    );
    lines.push(
      "- A required API route matches an existing route → ask: \"Route X exists; spec implies a different request/response shape. Extend or version?\""
    );
    lines.push(
      "- A required table OR column matches an existing migration → confirm: \"Table X already exists with columns {Y}; spec needs columns {Z}. The new migration will be ALTER TABLE ... ADD COLUMN, not CREATE TABLE.\""
    );
    lines.push(
      "- A test helper exists for a needed mocking idiom → DON'T propose a new helper; reference the existing one in your spec's `testing` notes."
    );

    return lines.join("\n");
  } catch {
    return null;
  }
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
