import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { historyIndexReadPath } from "../../lib/local-state.js";
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
  // Anchor-validity (dash dogfood: models invent plausible-but-nonexistent
  // prd_ref anchors). When the repo has a PRD with {#anchor} markers, list
  // them — an emitted prd_ref.anchor MUST be one of these.
  const prdAnchors = readPrdAnchors(repoRoot);
  if (prdAnchors.length > 0) {
    sections.push("\n### PRD anchors (prd_ref.anchor MUST be one of these — never invent one)\n");
    sections.push(prdAnchors.join(" · "));
  }

    sections.push("\n### Active specs (cross-reference via `related_specs` when applicable)\n");
    for (const line of activeSpecs) sections.push(line);
  }

  const brownfield = readBrownfieldExtracts(repoRoot);
  if (brownfield) sections.push("\n" + brownfield);

  // α.66 — pass skipOverlapWithAuto so history-index doesn't double up
  // when the auto/ digests are present (they cover components +
  // api_routes + migrations + mock_surface byte-identically).
  const autoPresent = existsSync(join(repoRoot, ".brewing/repo-knowledge/auto"));
  const historyDigest = readHistoryIndexDigest(repoRoot, { skipOverlapWithAuto: autoPresent });
  if (historyDigest) sections.push("\n" + historyDigest);

  const entitiesDigest = readEntitiesDigest(repoRoot);
  if (entitiesDigest) sections.push("\n" + entitiesDigest);

  // α.62 — prefer the disk-cached `.brewing/repo-knowledge/auto/*.md`
  // digests (emitted by `slowcook refresh-knowledge`) over re-scanning
  // in-process. The on-disk versions are also seen by other agents
  // (chef, vibe, etc.) so the team shares one reading. Falls back to
  // the in-memory α.61 scan if the dir doesn't exist (first run on a
  // repo where refresh-knowledge hasn't run yet).
  const knowledgeAuto = readKnowledgeAutoBlock(repoRoot);
  if (knowledgeAuto) {
    sections.push("\n" + knowledgeAuto);
  } else {
    // α.61 fallback — in-memory NestJS scan.
    const nestjsDigest = readNestJsBackendDigest(repoRoot);
    if (nestjsDigest) sections.push("\n" + nestjsDigest);
  }

  // α.63 — also surface the curated/ block (git-history mining +
  // future agent-written insights). Tracked in git; carries
  // commit-conventions, co-changes, ownership, fix-recipe seeds,
  // issue traceability.
  const knowledgeCurated = readKnowledgeCuratedBlock(repoRoot);
  if (knowledgeCurated) sections.push("\n" + knowledgeCurated);

  return sections.join("\n");
}

/**
 * α.63 — assemble the `.brewing/repo-knowledge/curated/*.md` files
 * into one block. These are mined from git history (and in later
 * alphas, written-back by chef / vibe / testgen). Tracked in git so
 * fresh clones get the organizational memory immediately.
 */
function readKnowledgeCuratedBlock(repoRoot: string): string | null {
  const curatedDir = join(repoRoot, ".brewing/repo-knowledge/curated");
  if (!existsSync(curatedDir)) return null;
  const order = [
    "commit-conventions.md",
    "ownership.md",
    "co-changes.md",
    "fix-recipe-seeds.md",
    "chef-known-fixes.md",      // populated later when chef writes
    "test-patterns.md",          // populated later when testgen writes
    "design-conventions.md",     // populated later when vibe writes
    "issue-traceability.md",
  ];
  const parts: string[] = [];
  parts.push("## Repo knowledge — curated (`.brewing/repo-knowledge/curated/`)\n");
  parts.push("Durable organizational memory: conventions + coupling + insights either mined from git history (α.63) or appended by agents over time (α.65+). Treat as soft signal — entries carry evidence trails but staleness is for review, not auto-invalidation.\n");
  let found = 0;
  for (const fname of order) {
    const path = join(curatedDir, fname);
    if (!existsSync(path)) continue;
    try {
      const body = readFileSync(path, "utf8");
      if (body.trim().length === 0) continue;
      parts.push(body.trim());
      parts.push("");
      found++;
    } catch { /* ignore */ }
  }
  if (found === 0) return null;
  return parts.join("\n");
}

/**
 * α.62 — assemble the `.brewing/repo-knowledge/auto/*.md` digests
 * into one block. Reads in a stable order so the byte sequence is
 * deterministic across runs (helps Anthropic prompt cache stay warm).
 * Returns null if the dir doesn't exist (consumer hasn't run
 * `slowcook refresh-knowledge` yet).
 */
function readKnowledgeAutoBlock(repoRoot: string): string | null {
  const autoDir = join(repoRoot, ".brewing/repo-knowledge/auto");
  if (!existsSync(autoDir)) return null;
  const order = [
    "config.md",
    "backend-entities.md",
    "backend-enums.md",
    "backend-routes.md",
    "frontend-types.md",
    "frontend-contexts.md",
    "frontend-components.md",
    "routes-inventory.md",
    "tokens.md",
    "migrations.md",
  ];
  const parts: string[] = [];
  parts.push("## Repo knowledge (auto-generated digests, from `.brewing/repo-knowledge/auto/`)\n");
  parts.push("These are deterministic extractions of the consumer's actual code shape. Agents MUST reference names/paths/values from here verbatim — do not invent routes, field aliases, or enum values not listed.\n");
  let found = 0;
  for (const fname of order) {
    const path = join(autoDir, fname);
    if (!existsSync(path)) continue;
    try {
      const body = readFileSync(path, "utf8")
        .replace(/^<!--[^>]*-->\n?/gm, ""); // strip metadata header
      if (body.trim().length === 0) continue;
      parts.push(body.trim());
      parts.push("");
      found++;
    } catch { /* ignore */ }
  }
  if (found === 0) return null;
  return parts.join("\n");
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
export function readHistoryIndexDigest(repoRoot: string, opts: { skipOverlapWithAuto?: boolean } = {}): string | null {
  const path = historyIndexReadPath(repoRoot);
  if (!existsSync(path)) return null;
  try {
    const idx = JSON.parse(readFileSync(path, "utf8")) as {
      components?: Array<{ name: string; file: string; props: string[]; tests_covering: string[] }>;
      api_routes?: Array<{ method: string; path: string; file: string }>;
      migrations?: Array<{ file: string; tables_created: string[]; columns_added: Record<string, string[]> }>;
      test_helpers?: Array<{ name: string; file: string; purpose: string }>;
      mock_surface?: Array<{ file: string; route: string | null; name: string; excerpt: string }>;
      git_attention?: {
        rename_chains?: Record<string, string[]>;
        co_changes?: Record<string, Array<{ file: string; strength: number }>>;
        recent_prs_by_file?: Record<string, Array<{ number: number; title: string; merged_at: string | null }>>;
        pr_spec_corpus?: Array<{ source: "pr" | "spec"; id: string; title: string; tokens: string[] }>;
      };
    };
    const lines: string[] = [];
    lines.push("## Code history index (auto-generated; treat as authoritative)\n");
    lines.push(
      "Refine MUST consult this index when deciding whether the new spec extends, supersedes, or duplicates existing surface area. Reference entries by name in your Q&A so the PM sees you've grounded against current code."
    );
    lines.push("");

    // α.66 — when auto/ digests exist they cover components / api_routes
    // / migrations / mock_surface byte-identically. Skip those sections
    // here to avoid ~20-30KB of duplicate context (Anthropic prompt
    // cache + per-token cost both benefit). Keep test_helpers +
    // git_attention below — they're NOT in auto/.
    const skipOverlap = opts.skipOverlapWithAuto ?? false;

    if (!skipOverlap && idx.components && idx.components.length > 0) {
      lines.push("### Existing components (with prop shape + test coverage)");
      for (const c of idx.components) {
        const propsStr = c.props.length > 0 ? ` props={${c.props.join(", ")}}` : " (no Props interface found)";
        const cov = c.tests_covering.length > 0 ? ` covered by ${c.tests_covering.length} test(s)` : " (uncovered)";
        lines.push(`- **${c.name}** \`${c.file}\`${propsStr}${cov}`);
      }
      lines.push("");
    }

    if (!skipOverlap && idx.api_routes && idx.api_routes.length > 0) {
      lines.push("### Existing API routes");
      for (const r of idx.api_routes) {
        lines.push(`- ${r.method} ${r.path} \`${r.file}\``);
      }
      lines.push("");
    }

    if (!skipOverlap && idx.migrations && idx.migrations.length > 0) {
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

    if (!skipOverlap && idx.mock_surface && idx.mock_surface.length > 0) {
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

    if (skipOverlap) {
      lines.push("_(components / api_routes / migrations / mock_surface sections omitted — auto/ digests cover them.)_");
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

    // 0.19.0-α.43 — git-history attention layer. Surface the four
    // signals (renames, co-changes, recent PRs per file, PR+spec
    // corpus) so refine grounds new specs in actual project history,
    // not just snapshot structure. Cap each list aggressively so the
    // digest stays prompt-sized; full data is in the json on disk.
    const ga = idx.git_attention;
    if (ga) {
      const renameEntries = Object.entries(ga.rename_chains ?? {});
      const coChangeEntries = Object.entries(ga.co_changes ?? {});
      const prEntries = Object.entries(ga.recent_prs_by_file ?? {});
      const corpus = ga.pr_spec_corpus ?? [];
      const anyContent =
        renameEntries.length > 0 ||
        coChangeEntries.length > 0 ||
        prEntries.length > 0 ||
        corpus.length > 0;

      if (anyContent) {
        lines.push("### Git-history attention (renames, couplings, recent PRs, corpus)");
        lines.push(
          "Brownfield repos are sequential. These four signals come from `git log` + `gh pr list` and tell refine which surface area carries prior intent — DON'T propose a rename or new file when the history shows the existing name is what reviewers and the PM use."
        );
        lines.push("");

        if (renameEntries.length > 0) {
          lines.push("**Files that were renamed** (use the CURRENT path; older names are just for grep continuity):");
          for (const [current, previous] of renameEntries.slice(0, 20)) {
            lines.push(`- \`${current}\` ← was \`${previous.join("\`, \`")}\``);
          }
          lines.push("");
        }

        if (coChangeEntries.length > 0) {
          lines.push("**Change-coupling** (files that historically change together — if your spec touches one, expect to touch the others):");
          for (const [file, partners] of coChangeEntries.slice(0, 15)) {
            const partnerStr = partners
              .map((p) => `\`${p.file}\` (${Math.round(p.strength * 100)}%)`)
              .join(", ");
            lines.push(`- \`${file}\` → ${partnerStr}`);
          }
          lines.push("");
        }

        if (prEntries.length > 0) {
          lines.push("**Recent PRs per file** (intent-shaped Keys: PR titles describe WHY, not WHAT — read these before proposing changes near the listed files):");
          for (const [file, prs] of prEntries.slice(0, 15)) {
            const prStr = prs
              .slice(0, 3)
              .map((p) => `#${p.number} ${p.title}${p.merged_at ? "" : " (open)"}`)
              .join(" · ");
            lines.push(`- \`${file}\` — ${prStr}`);
          }
          lines.push("");
        }

        if (corpus.length > 0) {
          lines.push(
            `**Searchable PR + spec corpus** (${corpus.length} entries in \`pr_spec_corpus\` on disk). Each entry has tokens for cheap keyword retrieval — when the PM's issue mentions a concept, find the corpus entries whose tokens overlap before assuming the concept is new.`
          );
          lines.push("");
        }
      }
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

/**
 * α.61 — surface a digest of NestJS/TypeORM backend shape so refine
 * doesn't hallucinate routes, DTO field names, and enum values on
 * monorepo consumers that use this stack.
 *
 * Scans (best-effort, all paths optional):
 *   - packages/(any)/entities/X.entity.ts for TypeORM entity classes
 *     (extracts class name + each Column/OneToMany/ManyToOne field)
 *   - apps/(any)/src/modules/(any)/X.controller.ts for HTTP controllers
 *     (extracts class + each Get/Post/Put/Delete/Patch handler)
 *   - packages/enums/src/X.enum.ts for enum values
 *
 * Returns null when none of these directories exist (greenfield or
 * non-NestJS repo) so the function stays a no-op for other stacks.
 *
 * Truncation: per-entity column list capped at 20; per-controller
 * route list capped at 15; enum values capped at 20. The full files
 * are on disk for testgen / brew if more detail needed.
 *
 * NOT a replacement for `readEntitiesDigest` (which targets the
 * supabase-style structure `slowcook init entities` emits) — both
 * fire side-by-side; one is null on stacks that aren't its target.
 */
export function readNestJsBackendDigest(repoRoot: string): string | null {
  const lines: string[] = [];
  const entityFiles = findFilesByGlob(repoRoot, /\/entities\/[^/]+\.entity\.ts$/);
  const controllerFiles = findFilesByGlob(repoRoot, /\/(modules|controllers)\/[^/]+\/[^/]+\.controller\.ts$/);
  const enumFiles = existsSync(join(repoRoot, "packages/enums/src"))
    ? readdirSync(join(repoRoot, "packages/enums/src")).filter((f) => f.endsWith(".enum.ts")).map((f) => `packages/enums/src/${f}`)
    : [];
  if (entityFiles.length === 0 && controllerFiles.length === 0 && enumFiles.length === 0) return null;

  lines.push("## Backend shape (NestJS/TypeORM — α.61)");
  lines.push("");
  lines.push(
    "These are the **actual** entity columns, controller routes, and enum values present in the consumer's backend. " +
    "When the spec references a backend route or field name, it MUST use names from this list — do NOT invent paths " +
    "like `/api/v1/...` or field aliases like `topic` when the entity column is `title`. If a needed field is absent, " +
    "explicitly emit a `database_migrations:` section in the spec listing the SQL DDL changes required."
  );
  lines.push("");

  if (entityFiles.length > 0) {
    lines.push("### TypeORM entities");
    for (const rel of entityFiles.slice(0, 25)) {
      const body = safeRead(repoRoot, rel);
      if (!body) continue;
      const classMatch = body.match(/export class (\w+) extends BaseEntity/) ?? body.match(/export class (\w+)/);
      if (!classMatch) continue;
      const className = classMatch[1]!;
      const cols = extractTypeOrmColumns(body).slice(0, 20);
      lines.push(`- **${className}** (\`${rel}\`)`);
      for (const col of cols) lines.push(`  - ${col}`);
    }
    if (entityFiles.length > 25) lines.push(`- … ${entityFiles.length - 25} more entity files`);
    lines.push("");
  }

  if (controllerFiles.length > 0) {
    lines.push("### HTTP controllers + routes");
    for (const rel of controllerFiles.slice(0, 25)) {
      const body = safeRead(repoRoot, rel);
      if (!body) continue;
      const controllerMatch = body.match(/@Controller\(['"]([^'"]*)['"]\)/);
      const base = controllerMatch ? controllerMatch[1]! : "";
      const allRoutes = extractNestRoutes(body);
      const routes = allRoutes.slice(0, 40);
      if (routes.length === 0) continue;
      lines.push(`- \`${rel}\` (base: \`/${base}\`)`);
      for (const r of routes) lines.push(`  - \`${r.method} /${joinPath(base, r.path)}\` → \`${r.handler}\``);
      if (allRoutes.length > 40) lines.push(`  - … ${allRoutes.length - 40} more routes in this file`);
    }
    if (controllerFiles.length > 25) lines.push(`- … ${controllerFiles.length - 25} more controller files`);
    lines.push("");
  }

  if (enumFiles.length > 0) {
    lines.push("### Enums (`packages/enums/src/`)");
    for (const rel of enumFiles.slice(0, 30)) {
      const body = safeRead(repoRoot, rel);
      if (!body) continue;
      const enumMatch = body.match(/export enum (\w+) \{([\s\S]*?)\}/);
      if (!enumMatch) continue;
      const enumName = enumMatch[1]!;
      const values = (enumMatch[2] ?? "")
        .split(",")
        .map((v) => v.trim().split("=")[0]!.trim().replace(/['"\s/*]/g, ""))
        .filter((v) => v && /^[A-Z_]+$/.test(v))
        .slice(0, 20);
      if (values.length === 0) continue;
      lines.push(`- **${enumName}**: ${values.join(" · ")}`);
    }
    if (enumFiles.length > 30) lines.push(`- … ${enumFiles.length - 30} more enum files`);
    lines.push("");
  }

  return lines.join("\n");
}

function findFilesByGlob(repoRoot: string, pattern: RegExp): string[] {
  const out: string[] = [];
  const skipDirs = new Set(["node_modules", ".git", ".next", "dist", "build", ".turbo", "coverage"]);
  const walk = (dir: string, depthRemaining: number) => {
    if (depthRemaining < 0) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (skipDirs.has(name)) continue;
      const abs = join(dir, name);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) walk(abs, depthRemaining - 1);
      else {
        const rel = abs.slice(repoRoot.length + 1);
        if (pattern.test(rel)) out.push(rel);
      }
    }
  };
  walk(repoRoot, 6); // depth 6 covers most monorepo layouts (packages/X/src/entities/foo.entity.ts)
  return out;
}

function safeRead(repoRoot: string, rel: string): string | null {
  try { return readFileSync(join(repoRoot, rel), "utf8"); } catch { return null; }
}

function extractTypeOrmColumns(body: string): string[] {
  // Pull `public foo: Type` lines (the actual field declarations, NOT the
  // decorator-config object lines that also look like `type: 'uuid'`).
  // Strategy: regex for ANY line starting with optional whitespace + access
  // modifier (public|private|readonly) + identifier + `:` + type expression
  // ending at `;`. Skip plain `key: value` lines (those are decorator config).
  const lines = body.split("\n");
  const out: string[] = [];
  const fieldRe = /^\s*(?:public|private|readonly|protected)\s+(\w+)(\?)?\s*:\s*([^;]+);/;
  for (const l of lines) {
    const m = l.match(fieldRe);
    if (!m) continue;
    const name = m[1]!;
    const optional = m[2] ? "?" : "";
    const type = (m[3] ?? "").trim().replace(/\s+/g, " ");
    out.push(`${name}${optional}: ${type}`);
  }
  return [...new Set(out)];
}

function extractNestRoutes(body: string): Array<{ method: string; path: string; handler: string }> {
  // Find each HTTP-verb decorator and walk forward through intervening
  // decorators (which may span multiple lines, e.g. @ApiOperation({…})
  // with the body on lines 2..N) until we find the actual method
  // signature `(public|private|async)? handler(...)`.
  //
  // Strategy: from the @Verb line, scan up to 60 lines forward, trying
  // the handler regex on each. Skip lines that are inside an unclosed
  // decorator parenthesis. Stop early on next @Get/Post/Put/Delete/Patch
  // (we missed the handler somehow).
  const lines = body.split("\n");
  const out: Array<{ method: string; path: string; handler: string }> = [];
  const httpVerbRe = /^\s*@(Get|Post|Put|Delete|Patch)\(([^)]*)\)/;
  const nextHttpVerbRe = /^\s*@(Get|Post|Put|Delete|Patch)\(/;
  const handlerRe = /^\s*(?:public|private|protected)?\s*(?:async\s+)?(\w+)\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? "").match(httpVerbRe);
    if (!m) continue;
    const method = m[1]!.toUpperCase();
    const rawPath = (m[2] ?? "").trim().replace(/^['"`]|['"`]$/g, "");
    let parenDepth = 0;
    let handler = "?";
    for (let j = i + 1; j < Math.min(i + 60, lines.length); j++) {
      const ln = lines[j] ?? "";
      // Hard stop: another HTTP verb at the same indent level — we've
      // passed our handler without finding it; this happens on malformed
      // controllers.
      if (parenDepth === 0 && nextHttpVerbRe.test(ln)) break;
      // Track paren depth so multi-line decorator bodies don't get
      // accidentally treated as the handler signature.
      for (const ch of ln) {
        if (ch === "(") parenDepth++;
        else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
      }
      // Skip lines that are starting a new decorator (handler is below)
      if (/^\s*@\w+/.test(ln)) continue;
      // Skip blank lines
      if (/^\s*$/.test(ln)) continue;
      // Only consider potential handler line when we're not inside an
      // unclosed decorator paren (parenDepth being 0 at line start means
      // any prior decorator closed last line).
      const handlerMatch = ln.match(handlerRe);
      if (handlerMatch) {
        const word = handlerMatch[1]!;
        // Filter out anything starting with an uppercase (likely a type
        // ref) or one of a known reserved-word set.
        if (word === "if" || word === "switch" || word === "while" || word === "for" || /^[A-Z]/.test(word)) continue;
        handler = word;
        break;
      }
    }
    out.push({ method, path: rawPath, handler });
  }
  return out;
}

function joinPath(base: string, sub: string): string {
  const b = base.replace(/^\/|\/$/g, "");
  const s = sub.replace(/^\/|\/$/g, "");
  if (!b) return s;
  if (!s) return b;
  return `${b}/${s}`;
}


/** every {#anchor} marker in docs/PRD.md (empty when no PRD). */
export function readPrdAnchors(repoRoot: string): string[] {
  const path = join(repoRoot, "docs", "PRD.md");
  if (!existsSync(path)) return [];
  try {
    const text = readFileSync(path, "utf8");
    return [...text.matchAll(/\{#([a-z0-9-]+)\}/g)].map((m) => m[1]!);
  } catch {
    return [];
  }
}
