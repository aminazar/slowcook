/**
 * 0.19.0+ (slowcook#36) — TypeORM entity-graph extractor. Walks all
 * `**\/*.entity.ts` files containing `@Entity(...)` decorators and emits
 * a Mermaid ERD + per-entity summary table to
 * `.brewing/diagrams/entities.md`.
 *
 * Why: slowcook's existing `emitSchemaDiagram` only knows about
 * `supabase/migrations/*.sql`. Consumers on TypeORM (delgoosh, plus
 * any NestJS monorepo) get nothing from the brownfield-extract step,
 * leaving their slowcook agents (vibe / recipe / brew / chef /
 * investigate) without entity grounding. Hand-curated entities.md
 * is the workaround — this module replaces it with auto-extraction.
 *
 * Detection signal: any `*.entity.ts` file with `@Entity(` decorator.
 * (Skips `node_modules`, `dist`, `.next`, `coverage`.)
 *
 * Parser is regex-based — TypeORM decorators have a strict shape
 * across the ecosystem. Same approach as `ddlToMermaidErd` in
 * refine/mermaid.ts; no AST tooling needed.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";

/** Skip these directories on the recursive walk. */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  "coverage",
  ".git",
  "build",
]);

export interface TypeOrmColumn {
  /** TS property name (camelCase). */
  property: string;
  /** SQL column name (snake_case, from `@Column({ name: 'snake_case' })`). */
  columnName?: string;
  /** TypeORM column type ('uuid', 'text', 'enum', 'jsonb', etc.). */
  columnType?: string;
  /** Whether the column is nullable. */
  nullable?: boolean;
  /** TS type from the property declaration (for context). */
  tsType?: string;
  /** JSDoc COLUMN-DESCRIPTION text, if present. */
  description?: string;
}

export interface TypeOrmRelation {
  /** TS property name on the entity. */
  property: string;
  /** Relation kind. */
  kind: "ManyToOne" | "OneToOne" | "OneToMany" | "ManyToMany";
  /** Target entity class name (the `() => User` part). */
  target: string;
  /** Optional foreign-key column name from @JoinColumn. */
  joinColumn?: string;
}

export interface TypeOrmEntity {
  /** Class name (PascalCase). */
  className: string;
  /** SQL table name from `@Entity('table_name')`. Falls back to class name in snake_case if missing. */
  tableName: string;
  /** Whether the class `extends BaseEntity`. */
  extendsBaseEntity: boolean;
  /** Repo-relative path to the source file. */
  sourcePath: string;
  /** JSDoc TABLE-DESCRIPTION text, if present. */
  description?: string;
  columns: TypeOrmColumn[];
  relations: TypeOrmRelation[];
}

/**
 * Recursive walk under `root` collecting absolute file paths matching
 * the predicate. Skips EXCLUDED_DIRS at any depth.
 */
function walk(root: string, predicate: (path: string) => boolean): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      const path = join(dir, entry);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(path);
      } else if (st.isFile() && predicate(path)) {
        out.push(path);
      }
    }
  }
  return out;
}

/**
 * Find all `*.entity.ts` files under `repoRoot` whose content contains
 * an `@Entity(` decorator. Returns paths sorted alphabetically for
 * deterministic output.
 */
export function findEntityFiles(repoRoot: string): string[] {
  const candidates = walk(repoRoot, (p) => p.endsWith(".entity.ts"));
  const real = candidates.filter((p) => {
    try {
      const src = readFileSync(p, "utf8");
      return /@Entity\s*\(/.test(src);
    } catch {
      return false;
    }
  });
  real.sort();
  return real;
}

/**
 * Parse one TypeORM entity source file. Returns null if no `@Entity`
 * decorator is found (defense-in-depth — findEntityFiles already
 * filtered).
 */
export function parseEntityFile(
  source: string,
  sourcePath: string
): TypeOrmEntity | null {
  // Class name + extends BaseEntity check.
  const classMatch = source.match(
    /export\s+class\s+(\w+)(?:\s+extends\s+(\w+))?/
  );
  if (!classMatch) return null;
  const className = classMatch[1]!;
  const extendsBaseEntity = classMatch[2] === "BaseEntity";

  // Table name from @Entity('snake_case_plural'). Fallback to className.
  const entityMatch = source.match(/@Entity\s*\(\s*['"]([^'"]+)['"]\s*\)/);
  const tableName =
    entityMatch?.[1] ??
    className
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase();

  // JSDoc above the class (TABLE-DESCRIPTION: ...).
  const tableDescMatch = source.match(
    /TABLE-DESCRIPTION:\s*([^\n*]+?)(?:\s*\*\/|\s*\n\s*\*\s*TABLE-)/
  );
  const description = tableDescMatch?.[1]?.trim();

  // Columns: @Column(...) followed by `[public ]<property>: <type>`.
  // The decorator may span multiple lines; we capture the args block in
  // a balanced way using a permissive `[^@]*?` lookahead — fine because
  // the next `@` always opens the next decorator or the property.
  const columns: TypeOrmColumn[] = [];
  const columnRe =
    /@Column\s*\(\s*(\{[\s\S]*?\})\s*\)\s*(?:public\s+|readonly\s+)?(\w+)\s*[?!]?\s*:\s*([^;]+);/g;
  let cm: RegExpExecArray | null;
  while ((cm = columnRe.exec(source)) !== null) {
    const [, args, property, tsType] = cm;
    columns.push({
      property: property!,
      columnName: args!.match(/name:\s*['"]([^'"]+)['"]/)?.[1],
      columnType: args!.match(/type:\s*['"]([^'"]+)['"]/)?.[1],
      nullable: /nullable:\s*true/.test(args!),
      tsType: tsType!.trim(),
    });
  }
  // Also catch bare `@Column()` (no args) — TypeORM allows this.
  const bareColumnRe =
    /@Column\s*\(\s*\)\s*(?:public\s+|readonly\s+)?(\w+)\s*[?!]?\s*:\s*([^;]+);/g;
  while ((cm = bareColumnRe.exec(source)) !== null) {
    const [, property, tsType] = cm;
    columns.push({
      property: property!,
      tsType: tsType!.trim(),
    });
  }

  // Relations: @ManyToOne / @OneToOne / @OneToMany / @ManyToMany.
  const relations: TypeOrmRelation[] = [];
  const relRe =
    /@(ManyToOne|OneToOne|OneToMany|ManyToMany)\s*\(\s*\(\)\s*=>\s*(\w+)[\s\S]*?\)\s*(?:@JoinColumn\s*\(\s*\{?\s*(?:name:\s*['"]([^'"]+)['"])?[^}]*\}?\s*\)\s*)?(?:public\s+|readonly\s+)?(\w+)/g;
  let rm: RegExpExecArray | null;
  while ((rm = relRe.exec(source)) !== null) {
    const [, kind, target, joinColumn, property] = rm;
    relations.push({
      property: property!,
      kind: kind as TypeOrmRelation["kind"],
      target: target!,
      joinColumn,
    });
  }

  return {
    className,
    tableName,
    extendsBaseEntity,
    sourcePath,
    description,
    columns,
    relations,
  };
}

/**
 * Mermaid relation shape per TypeORM kind.
 *   ManyToOne   N owners → 1 target          → `}o--||`
 *   OneToOne    1 owner  → 1 target          → `||--o|`
 *   OneToMany   1 owner  → 0..N targets      → `||--o{`
 *   ManyToMany  N owners → N targets         → `}o--o{`
 */
const RELATION_SHAPES: Record<TypeOrmRelation["kind"], string> = {
  ManyToOne: "}o--||",
  OneToOne: "||--o|",
  OneToMany: "||--o{",
  ManyToMany: "}o--o{",
};

/**
 * Render one Mermaid `erDiagram` covering all entities + their
 * relations. For very large graphs (>40 entities) the diagram is hard
 * to read — but splitting by domain requires semantic knowledge we
 * don't have. We render one big ERD; consumers can grep for entities
 * they care about + use the per-entity table below for details.
 */
export function entitiesToMermaidErd(entities: TypeOrmEntity[]): string {
  if (entities.length === 0) {
    return "```mermaid\nerDiagram\n  %% No @Entity decorators found.\n```";
  }
  const lines: string[] = ["```mermaid", "erDiagram"];
  const known = new Set(entities.map((e) => e.className));
  for (const e of entities) {
    for (const r of e.relations) {
      // Skip relations whose target isn't a known entity (e.g. enum types).
      if (!known.has(r.target)) continue;
      const label = r.property.replace(/"/g, "");
      lines.push(`  ${e.className} ${RELATION_SHAPES[r.kind]} ${r.target} : "${label}"`);
    }
  }
  // Always render entity boxes even with no columns (helps when a
  // class only has relations, e.g. junction tables).
  for (const e of entities) {
    lines.push(`  ${e.className} {`);
    // Show only NOTABLE columns: anything that looks like an FK or
    // status enum or has a tableName (the rest belong in the per-
    // entity table below). Cap at 6 to keep diagram readable.
    const notable = e.columns
      .filter((c) => c.columnName?.endsWith("_id") || c.columnType === "enum")
      .slice(0, 6);
    if (notable.length === 0) {
      // Show the first ~3 columns so the box isn't empty.
      for (const c of e.columns.slice(0, 3)) {
        lines.push(`    ${c.columnType ?? "any"} ${c.columnName ?? c.property}`);
      }
    } else {
      for (const c of notable) {
        const t = c.columnType ?? "any";
        lines.push(`    ${t} ${c.columnName ?? c.property}`);
      }
    }
    lines.push(`  }`);
  }
  lines.push("```");
  return lines.join("\n");
}

/**
 * Render the per-entity summary table for the entities.md artifact.
 * Pairs with the Mermaid ERD above to give agents structured access
 * to the entity vocabulary.
 */
export function entitiesToSummaryTable(entities: TypeOrmEntity[]): string {
  const lines: string[] = [];
  lines.push(
    "| Entity | Table | Purpose | Key relations | Notable columns |"
  );
  lines.push("|---|---|---|---|---|");
  for (const e of entities) {
    const purpose = (e.description ?? "—").replace(/\|/g, "\\|");
    const relations =
      e.relations
        .slice(0, 4)
        .map((r) => `${r.kind} ${r.target}`)
        .join("; ") || "—";
    const notableCols =
      e.columns
        .filter((c) => c.columnName?.endsWith("_id") || c.columnType === "enum")
        .slice(0, 5)
        .map((c) => c.columnName ?? c.property)
        .join(", ") || "—";
    lines.push(
      `| ${e.className} | \`${e.tableName}\` | ${purpose} | ${relations} | ${notableCols} |`
    );
  }
  return lines.join("\n");
}

/**
 * Full entities.md document body. Static header + conventions section
 * (drawn from delgoosh dogfood — these are the same conventions every
 * NestJS+TypeORM consumer follows) + the ERD + summary table.
 */
export function renderEntitiesMarkdown(entities: TypeOrmEntity[]): string {
  const baseEntityHits = entities.filter((e) => e.extendsBaseEntity).length;
  const baseEntityHint =
    baseEntityHits > 0
      ? `${baseEntityHits} of ${entities.length} entities \`extend BaseEntity\` — assume the same UUID-id + soft-delete pattern when adding new entities.`
      : "No `BaseEntity` parent class detected — entities define their own primary keys.";

  return `# Entity graph (auto-generated by \`slowcook extract --entities\`)

> **Auto-generated; do not hand-edit.** Regenerate by running \`slowcook extract --entities\`.
> Source: \`*.entity.ts\` files containing an \`@Entity(\` decorator.

This artifact is consumed by slowcook agents (vibe / recipe / brew / chef / investigate) to ground their work in the existing entity vocabulary. Without it agents hallucinate table shapes and column names.

## Quick stats

- **${entities.length} entities** discovered
- **${entities.reduce((n, e) => n + e.relations.length, 0)} relations** declared
- ${baseEntityHint}

## Conventions (inferred from the codebase)

- Tables follow snake_case_plural (e.g. \`@Entity('patients')\`).
- TS properties are camelCase; SQL columns are snake_case via \`@Column({ name: 'snake_case' })\`.
- Foreign keys follow the \`<foreign_table_singular>_id\` pattern.
- Enum columns reference \`@Column({ type: 'enum', enum: <EnumFromRepoEnums> })\`.
- Relations are declared via \`@ManyToOne\` / \`@OneToOne\` / \`@OneToMany\` / \`@ManyToMany\` + \`@JoinColumn\`.

## Entity-relationship diagram

${entitiesToMermaidErd(entities)}

## Per-entity summary

${entitiesToSummaryTable(entities)}

## Source paths

${entities.map((e) => `- \`${e.sourcePath}\` — \`${e.className}\``).join("\n")}
`;
}

/**
 * Public entry — walks the repo, parses entities, returns the rendered
 * markdown body PLUS counts for the caller (which writes the file).
 * Skipped silently if no .entity.ts files with @Entity are found —
 * consumer probably uses Prisma / Drizzle / Supabase / raw SQL.
 */
export function buildEntitiesArtifact(repoRoot: string): {
  written: boolean;
  body?: string;
  entityCount?: number;
  relationCount?: number;
  fileCount?: number;
  skippedReason?: string;
} {
  const files = findEntityFiles(repoRoot);
  if (files.length === 0) {
    return {
      written: false,
      skippedReason:
        "no `*.entity.ts` files with `@Entity(...)` decorator found (TypeORM signal absent)",
    };
  }
  const entities: TypeOrmEntity[] = [];
  for (const f of files) {
    try {
      const src = readFileSync(f, "utf8");
      const repoRelative = f.startsWith(repoRoot)
        ? f.slice(repoRoot.length + 1)
        : f;
      const e = parseEntityFile(src, repoRelative);
      if (e) entities.push(e);
    } catch {
      // Skip unreadable files silently.
    }
  }
  if (entities.length === 0) {
    return {
      written: false,
      skippedReason: `${files.length} candidate file(s) found but none parsed cleanly`,
    };
  }
  return {
    written: true,
    body: renderEntitiesMarkdown(entities),
    entityCount: entities.length,
    relationCount: entities.reduce((n, e) => n + e.relations.length, 0),
    fileCount: files.length,
  };
}

// Test-only helper. Avoids exporting internals to the public surface.
export const __testOnly__ = {
  parseEntityFile,
  walk,
  entitiesToMermaidErd,
  entitiesToSummaryTable,
};

// Avoid unused-import warning on `basename` if not used above.
void basename;
