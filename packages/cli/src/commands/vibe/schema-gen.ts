/**
 * GUCDI — deterministic Drizzle schema generator (pure). The first GENERATION
 * pass of the whole-app LCR vibe. Because the LCR plan's data model is already
 * well-typed (menu emits structured `data_contract` field types + relations),
 * the SQLite/Drizzle schema falls out mechanically — no LLM, no drift, testable.
 *
 * Structure → deterministic; content/judgment (seed data, surfaces) → LLM. This
 * is that boundary. Output mirrors the rewo LCR precedent: one `@story`-annotated
 * table per entity + inferred row types, SQLite-portable (brew swaps SQLite →
 * Postgres, inheriting the models). See docs/plans/vibe-whole-mock-lcr.md.
 */
import type { PlanEntity } from "./lcr-plan.js";

/** Table variable name: lower-first-letter of the entity (OperatorAuditLog →
 *  operatorAuditLog, Wallet → wallet). */
export function tableVar(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/** SQL table/column name: snake_case. */
export function snake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

interface Mapped {
  /** the drizzle column expression sans chaining, e.g. `text("status", { enum: [...] })` */
  expr: string;
  /** which top-level drizzle builders this used (for the import line) */
  builder: "text" | "integer" | "real";
}

/** Map a data_contract field type → a Drizzle SQLite column builder. Robust to
 *  the `|null` nullability suffix (stripped by the caller) and unknown types
 *  (default to text). */
export function mapType(rawType: string, sqlName: string): Mapped {
  const t = rawType.trim().toLowerCase();
  const col = JSON.stringify(sqlName);

  const enumMatch = /^enum\s*\((.*)\)$/.exec(t);
  if (enumMatch) {
    const values = enumMatch[1]!
      .split(/[|,]/)
      .map((v) => v.trim())
      .filter(Boolean);
    return { expr: `text(${col}, { enum: [${values.map((v) => JSON.stringify(v)).join(", ")}] })`, builder: "text" };
  }
  if (/^(uuid|string|text|varchar|char)/.test(t)) return { expr: `text(${col})`, builder: "text" };
  if (/^(timestamp|datetime|date|time)/.test(t)) return { expr: `integer(${col}, { mode: "timestamp" })`, builder: "integer" };
  if (/^(bool|boolean)/.test(t)) return { expr: `integer(${col}, { mode: "boolean" })`, builder: "integer" };
  if (/^(int|integer|bigint|serial|number)/.test(t)) return { expr: `integer(${col})`, builder: "integer" };
  if (/^(float|real|double|decimal|numeric|money)/.test(t)) return { expr: `real(${col})`, builder: "real" };
  if (/^(json|jsonb)/.test(t)) return { expr: `text(${col}, { mode: "json" })`, builder: "text" };
  return { expr: `text(${col})`, builder: "text" }; // safe default
}

/** Parse a relation declaration into (sourceField → targetEntity.targetField).
 *  Accepts `Entity.field → Target.tcol`, `field → Target.tcol`, with `→` or `->`. */
export function parseRelation(rel: string): { field: string; targetEntity: string; targetField: string } | null {
  const parts = rel.split(/→|->/).map((s) => s.trim());
  if (parts.length !== 2) return null;
  const [left, right] = parts;
  const field = left!.includes(".") ? left!.split(".").pop()!.trim() : left!.trim();
  const rdot = right!.split(".");
  if (rdot.length < 2) return null;
  const targetEntity = rdot[0]!.trim();
  const targetField = rdot[1]!.trim();
  if (!field || !targetEntity || !targetField) return null;
  return { field, targetEntity, targetField };
}

/** Generate the full `schema.ts` content from the plan's entity model. */
export function compileDrizzleSchema(entities: PlanEntity[]): string {
  const usedBuilders = new Set<string>(["sqliteTable"]);
  const knownEntities = new Set(entities.map((e) => e.name));
  const blocks: string[] = [];
  let usedReferences = false;

  for (const e of entities) {
    // field → reference (only when the target entity is in the model).
    const refByField = new Map<string, { targetEntity: string; targetField: string }>();
    for (const rel of e.relations) {
      const parsed = parseRelation(rel);
      if (parsed && knownEntities.has(parsed.targetEntity)) {
        refByField.set(parsed.field, { targetEntity: parsed.targetEntity, targetField: parsed.targetField });
      }
    }

    const cols: string[] = [];
    for (const f of e.fields) {
      const nullable = /\|\s*null\s*$/.test(f.type);
      const baseType = f.type.replace(/\|\s*null\s*$/, "");
      const sqlName = snake(f.name);
      const m = mapType(baseType, sqlName);
      usedBuilders.add(m.builder);
      const isPk = f.name === "id";
      let chain = m.expr;
      if (isPk) chain += ".primaryKey()";
      // A foreign key lives on the *referencing* column, never on the PK. A
      // relation that names this entity's `id` as the source is the inverse
      // (has-one/has-many) of a real FK that lives on the child table — skip it
      // here; the child emits the actual `.references()`.
      const ref = isPk ? undefined : refByField.get(f.name);
      // Annotate the callback return as AnySQLiteColumn so circular / mutual FKs
      // (gate↔epic etc.) don't trip TS7022/7024 "implicit any in its own
      // initializer" — the documented Drizzle fix for self/circular references.
      if (ref) { chain += `.references((): AnySQLiteColumn => ${tableVar(ref.targetEntity)}.${ref.targetField})`; usedReferences = true; }
      if (!nullable && !isPk) chain += ".notNull()";
      cols.push(`  ${f.name}: ${chain},`);
    }

    const provenance = `// @story ${e.fromStories.map((s) => `story-${s}`).join(", ")}`;
    blocks.push(
      `${provenance}\nexport const ${tableVar(e.name)} = sqliteTable(${JSON.stringify(snake(e.name))}, {\n${cols.join("\n")}\n});\n` +
        `export type ${e.name} = typeof ${tableVar(e.name)}.$inferSelect;\n` +
        `export type New${e.name} = typeof ${tableVar(e.name)}.$inferInsert;`
    );
  }

  const importParts = [...usedBuilders].sort();
  if (usedReferences) importParts.push("type AnySQLiteColumn");
  const importLine = `import { ${importParts.join(", ")} } from "drizzle-orm/sqlite-core";`;
  const header =
    `// @convention LCR data adaptor — generated by \`slowcook vibe schema\` from the\n` +
    `// LCR plan's data model (specs' data_contract). Deterministic; do not hand-edit —\n` +
    `// change a spec's data_contract and regenerate. SQLite-portable (brew swaps to\n` +
    `// Postgres, inheriting these models). ${entities.length} entities.`;

  return `${header}\n${importLine}\n\n${blocks.join("\n\n")}\n`;
}

/** SQLite storage affinity for a data_contract type. The mock runs a real
 *  in-browser SQLite (sql.js) seeded at boot; these are the CREATE TABLE types. */
export function sqliteType(rawType: string): "TEXT" | "INTEGER" | "REAL" {
  const t = rawType.trim().toLowerCase();
  if (/^enum\s*\(/.test(t)) return "TEXT";
  if (/^(uuid|string|text|varchar|char|json|jsonb)/.test(t)) return "TEXT";
  if (/^(float|real|double|decimal|numeric|money)/.test(t)) return "REAL";
  if (/^(timestamp|datetime|date|time|bool|boolean|int|integer|bigint|serial|number)/.test(t)) return "INTEGER";
  return "TEXT";
}

/** Generate CREATE TABLE DDL from the plan's entity model — run by the mock's
 *  sql.js bootstrap to materialise the schema in the in-browser DB. Deterministic
 *  twin of compileDrizzleSchema; enum fields get a CHECK constraint, `id` is the
 *  PK, relations become inline REFERENCES (skipped on the PK / unknown targets). */
export function compileSqliteDdl(entities: PlanEntity[]): string {
  const known = new Set(entities.map((e) => e.name));
  const stmts: string[] = [];
  for (const e of entities) {
    const refByField = new Map<string, { targetEntity: string; targetField: string }>();
    for (const rel of e.relations) {
      const parsed = parseRelation(rel);
      if (parsed && known.has(parsed.targetEntity)) refByField.set(parsed.field, { targetEntity: parsed.targetEntity, targetField: parsed.targetField });
    }
    const cols: string[] = [];
    for (const f of e.fields) {
      const nullable = /\|\s*null\s*$/.test(f.type);
      const base = f.type.replace(/\|\s*null\s*$/, "");
      const name = snake(f.name);
      const isPk = f.name === "id";
      let c = `  ${name} ${sqliteType(base)}`;
      if (isPk) c += " PRIMARY KEY";
      else if (!nullable) c += " NOT NULL";
      const em = /^enum\s*\((.*)\)$/.exec(base.trim().toLowerCase());
      if (em) {
        const vals = em[1]!.split(/[|,]/).map((v) => v.trim()).filter(Boolean);
        c += ` CHECK (${name} IN (${vals.map((v) => `'${v}'`).join(", ")}))`;
      }
      const ref = isPk ? undefined : refByField.get(f.name);
      if (ref) c += ` REFERENCES ${snake(ref.targetEntity)}(${snake(ref.targetField)})`;
      cols.push(c);
    }
    stmts.push(`CREATE TABLE ${snake(e.name)} (\n${cols.join(",\n")}\n);`);
  }
  return stmts.join("\n\n") + "\n";
}

/** Deterministic db-bootstrap module (db.ts): a real in-browser SQLite (sql.js)
 *  created + DDL-materialised + seeded once at boot, exposed as a Drizzle db so
 *  the mock's query layer runs real SQL — the mock→prod swap is then a
 *  data-source change, not a rewrite. Pure template (no entity-specific content);
 *  the seed (seed.ts) + query adaptor (queries.ts) are the LLM pass. */
export function dbBootstrapTs(): string {
  return `// @convention LCR data adaptor runtime — generated by \`slowcook vibe seed\`.
// A real in-browser SQLite (sql.js) seeded once at boot; the query layer
// (queries.ts) runs Drizzle/SQL, so mock→prod is a data-source swap, not a
// rewrite. Requires deps: drizzle-orm, sql.js. Do not hand-edit.
import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { drizzle, type SQLJsDatabase } from "drizzle-orm/sql-js";
import * as schema from "./schema";
import { DDL } from "./ddl";
import { seed } from "./seed";

export type DB = SQLJsDatabase<typeof schema>;

let _dbPromise: Promise<DB> | null = null;

/** Lazily boot the in-memory SQLite, materialise the schema, seed it once. */
export function getDb(): Promise<DB> {
  if (!_dbPromise) {
    _dbPromise = (async () => {
      const SQL = await initSqlJs({ locateFile: () => wasmUrl });
      const sqlite = new SQL.Database();
      sqlite.run(DDL);
      const db = drizzle(sqlite, { schema });
      await seed(db);
      return db;
    })();
  }
  return _dbPromise;
}
`;
}
