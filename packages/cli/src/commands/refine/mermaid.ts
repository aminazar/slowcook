/**
 * Convert a Postgres DDL blob (e.g., a spec's schema proposal) into a
 * Mermaid `erDiagram` block. Deliberately shallow — regex-based, not a
 * full SQL parser. Designed for the shapes `create table` and
 * `alter table add column` typically emitted by refine proposals.
 *
 * What it captures:
 *  - New table declarations (`create table foo (...)`) with their columns
 *  - `references` clauses as FK relationships
 *  - `alter table ... add column` entries merged into existing tables
 *
 * What it ignores:
 *  - Indexes, policies, triggers, functions — irrelevant for an ERD
 *  - Check constraints — too complex for a shallow parser
 *  - Computed / generated columns — rare in refine proposals
 *
 * Falls back gracefully: if the DDL doesn't produce any entities, returns
 * an empty diagram with a comment pointing the reader at the raw SQL
 * block in the PR body for manual review.
 */

interface ErdEntity {
  name: string;
  columns: ErdColumn[];
}

interface ErdColumn {
  name: string;
  /** Normalised Postgres type family (uuid / text / int / timestamptz / etc.) */
  type: string;
  /** PK / FK / null markers rolled into a single display hint */
  hints: string[];
}

interface ErdRelationship {
  from: string;
  to: string;
  /** Cardinality sketch — one-to-many until we detect otherwise (rare in refine DDL) */
  shape: "||--o{" | "}o--||" | "||--||";
  label: string;
}

const TYPE_NORMALISATIONS: Array<[RegExp, string]> = [
  [/^uuid\b/i, "uuid"],
  [/^text\b|^varchar\b|^char\b/i, "text"],
  [/^int\b|^integer\b|^bigint\b|^smallint\b|^serial\b/i, "int"],
  [/^bool(ean)?\b/i, "bool"],
  [/^timestamp(tz)?\b|^timestamp with time zone\b/i, "timestamptz"],
  [/^numeric\b|^decimal\b|^real\b|^double\b|^float\b/i, "numeric"],
  [/^jsonb?\b/i, "jsonb"],
  [/^bytea\b/i, "bytea"],
];

function normaliseType(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  for (const [re, canonical] of TYPE_NORMALISATIONS) {
    if (re.test(trimmed)) return canonical;
  }
  // Unknown type → keep the first identifier
  return trimmed.split(/\s/)[0] ?? trimmed;
}

/**
 * Parse a column definition line like:
 *   `recipient_id uuid not null references profiles(id) on delete cascade,`
 * into its constituent parts. Returns null if the line isn't a column.
 */
function parseColumnLine(line: string): {
  column: ErdColumn;
  references?: { table: string };
} | null {
  const trimmed = line.trim().replace(/,$/, "");
  if (!trimmed) return null;
  // Skip known constraint-only lines
  if (/^(primary\s+key|foreign\s+key|unique|check|constraint)\b/i.test(trimmed)) return null;
  // Column name must be the first identifier; bail on anything unparseable
  const match = trimmed.match(/^([a-z_][a-z0-9_]*)\s+([a-z_][a-z0-9_() ]*?)(\s+.*)?$/i);
  if (!match) return null;
  const [, name, rawType, tail = ""] = match;
  const type = normaliseType(rawType!);
  const hints: string[] = [];
  const flags = tail.toLowerCase();
  if (/\bprimary\s+key\b/.test(flags)) hints.push("PK");
  if (/\bnot\s+null\b/.test(flags)) hints.push("NN");
  if (/\bunique\b/.test(flags)) hints.push("U");
  const refMatch = tail.match(/references\s+([a-z_][a-z0-9_]*)/i);
  const refs = refMatch ? { table: refMatch[1]! } : undefined;
  if (refs) hints.push("FK");
  return refs
    ? { column: { name: name!, type, hints }, references: refs }
    : { column: { name: name!, type, hints } };
}

/**
 * Shallow Postgres DDL → { entities, relationships }.
 *
 * Accepts multiple statements; only `create table` and `alter table add
 * column` shapes produce output. Everything else is ignored.
 */
function parseDdl(ddl: string): {
  entities: Map<string, ErdEntity>;
  relationships: ErdRelationship[];
} {
  const entities = new Map<string, ErdEntity>();
  const relationships: ErdRelationship[] = [];

  // Normalise whitespace for multi-line tolerance
  const normalised = ddl.replace(/\r\n/g, "\n");

  // 1. `create table <name> ( <body> );`
  const createRe =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([^;]+?)\)\s*;/gis;
  let m: RegExpExecArray | null;
  while ((m = createRe.exec(normalised)) !== null) {
    const [, tableName, body] = m;
    const entity: ErdEntity = { name: tableName!, columns: [] };
    const lines = body!.split(/\n/);
    for (const line of lines) {
      const parsed = parseColumnLine(line);
      if (!parsed) continue;
      entity.columns.push(parsed.column);
      if (parsed.references) {
        relationships.push({
          from: parsed.references.table,
          to: tableName!,
          shape: "||--o{",
          label: parsed.column.name,
        });
      }
    }
    entities.set(tableName!, entity);
  }

  // 2. `alter table <name> add column <col> <type> ...` — single-column form
  const alterRe =
    /alter\s+table\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+add\s+column\s+([a-z_][a-z0-9_]*)\s+([^;,]+)(?:,|;)/gis;
  while ((m = alterRe.exec(normalised)) !== null) {
    const [, tableName, colName, rest] = m;
    let entity = entities.get(tableName!);
    if (!entity) {
      // Table not declared in this DDL — still render a stub entity so
      // the new column is visible in the diagram
      entity = { name: tableName!, columns: [] };
      entities.set(tableName!, entity);
    }
    const combined = `${colName} ${rest}`;
    const parsed = parseColumnLine(combined);
    if (parsed) {
      entity.columns.push(parsed.column);
      if (parsed.references) {
        relationships.push({
          from: parsed.references.table,
          to: tableName!,
          shape: "||--o{",
          label: parsed.column.name,
        });
      }
    }
  }

  return { entities, relationships };
}

/**
 * Render entities + relationships into a Mermaid `erDiagram` block. The
 * returned string is wrapped in triple-backtick `mermaid` fence so it's
 * ready to drop into a PR body or a `.mmd` file section.
 */
export function ddlToMermaidErd(ddl: string): string {
  const { entities, relationships } = parseDdl(ddl);

  if (entities.size === 0) {
    return (
      "```mermaid\nerDiagram\n" +
      "  %% No entities extracted; see the raw SQL block below for the proposal.\n" +
      "```"
    );
  }

  const lines: string[] = ["```mermaid", "erDiagram"];

  for (const rel of relationships) {
    const label = rel.label.replace(/"/g, "");
    lines.push(`  ${rel.from.toUpperCase()} ${rel.shape} ${rel.to.toUpperCase()} : "${label}"`);
  }

  for (const entity of entities.values()) {
    lines.push(`  ${entity.name.toUpperCase()} {`);
    for (const col of entity.columns) {
      const hints = col.hints.length > 0 ? ` ${col.hints.join(",")}` : "";
      lines.push(`    ${col.type} ${col.name}${hints}`);
    }
    lines.push(`  }`);
  }

  lines.push("```");
  return lines.join("\n");
}

/**
 * Test-only access to the parser — keeps the public surface minimal.
 */
export const __internals = { parseDdl, parseColumnLine };
