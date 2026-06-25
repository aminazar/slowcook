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
      if (ref) chain += `.references(() => ${tableVar(ref.targetEntity)}.${ref.targetField})`;
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

  const importLine = `import { ${[...usedBuilders].sort().join(", ")} } from "drizzle-orm/sqlite-core";`;
  const header =
    `// @convention LCR data adaptor — generated by \`slowcook vibe schema\` from the\n` +
    `// LCR plan's data model (specs' data_contract). Deterministic; do not hand-edit —\n` +
    `// change a spec's data_contract and regenerate. SQLite-portable (brew swaps to\n` +
    `// Postgres, inheriting these models). ${entities.length} entities.`;

  return `${header}\n${importLine}\n\n${blocks.join("\n\n")}\n`;
}
