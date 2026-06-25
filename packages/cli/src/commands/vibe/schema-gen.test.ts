import { describe, it, expect } from "vitest";
import { compileDrizzleSchema, compileSqliteDdl, sqliteType, mapType, snake, tableVar, parseRelation } from "./schema-gen.js";
import type { PlanEntity } from "./lcr-plan.js";

describe("schema-gen helpers", () => {
  it("maps field types to Drizzle column builders", () => {
    expect(mapType("uuid", "id").expr).toBe('text("id")');
    expect(mapType("string", "name").expr).toBe('text("name")');
    expect(mapType("integer", "count").expr).toBe('integer("count")');
    expect(mapType("float", "rate").expr).toBe('real("rate")');
    expect(mapType("boolean", "active").expr).toBe('integer("active", { mode: "boolean" })');
    expect(mapType("timestamp", "created_at").expr).toBe('integer("created_at", { mode: "timestamp" })');
    expect(mapType("json", "meta").expr).toBe('text("meta", { mode: "json" })');
    expect(mapType("enum(a|b|c)", "kind").expr).toBe('text("kind", { enum: ["a", "b", "c"] })');
    expect(mapType("enum(open,closed)", "state").expr).toBe('text("state", { enum: ["open", "closed"] })');
    expect(mapType("weirdtype", "x").expr).toBe('text("x")'); // safe default
  });

  it("snake_cases names and lower-firsts the table var", () => {
    expect(snake("OperatorAuditLog")).toBe("operator_audit_log");
    expect(snake("Wallet")).toBe("wallet");
    expect(tableVar("OperatorAuditLog")).toBe("operatorAuditLog");
  });

  it("parses relation declarations (with and without source-entity prefix)", () => {
    expect(parseRelation("OperatorAuditLog.operator_id → Member.id")).toEqual({ field: "operator_id", targetEntity: "Member", targetField: "id" });
    expect(parseRelation("reporter_id -> Member.id")).toEqual({ field: "reporter_id", targetEntity: "Member", targetField: "id" });
    expect(parseRelation("garbage")).toBeNull();
  });
});

describe("compileDrizzleSchema", () => {
  const entities: PlanEntity[] = [
    {
      name: "Member",
      fields: [
        { name: "id", type: "uuid", fromStories: ["001"] },
        { name: "handle", type: "string", fromStories: ["001"] },
      ],
      relations: [],
      fromStories: ["001"],
    },
    {
      name: "OperatorAuditLog",
      fields: [
        { name: "id", type: "uuid", fromStories: ["017"] },
        { name: "operator_id", type: "uuid", fromStories: ["017"] },
        { name: "action_type", type: "enum(worker_certified|worker_decertified)", fromStories: ["017"] },
        { name: "note", type: "text|null", fromStories: ["017"] },
        { name: "created_at", type: "timestamp", fromStories: ["017"] },
      ],
      relations: ["OperatorAuditLog.operator_id → Member.id"],
      fromStories: ["017"],
    },
  ];

  const out = compileDrizzleSchema(entities);

  it("emits a sqliteTable per entity with @story provenance", () => {
    expect(out).toContain("// @story story-001\nexport const member = sqliteTable(\"member\", {");
    expect(out).toContain("// @story story-017\nexport const operatorAuditLog = sqliteTable(\"operator_audit_log\", {");
  });

  it("makes `id` the primary key and non-id non-null fields .notNull()", () => {
    expect(out).toContain('id: text("id").primaryKey(),');
    expect(out).toContain('handle: text("handle").notNull(),');
  });

  it("resolves a relation to a typed .references() thunk", () => {
    expect(out).toContain('operator_id: text("operator_id").references(() => member.id).notNull(),');
  });

  it("keeps a `|null` field nullable (no .notNull())", () => {
    expect(out).toContain('note: text("note"),');
    expect(out).not.toContain('note: text("note").notNull()');
  });

  it("emits an enum column + inferred row types + minimal imports", () => {
    expect(out).toContain('action_type: text("action_type", { enum: ["worker_certified", "worker_decertified"] }).notNull(),');
    expect(out).toContain("export type OperatorAuditLog = typeof operatorAuditLog.$inferSelect;");
    expect(out).toContain("export type NewMember = typeof member.$inferInsert;");
    expect(out).toContain('import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";');
  });

  it("never makes the `id` primary key a foreign key (drops the inverse relation)", () => {
    const inverse = compileDrizzleSchema([
      { name: "Project", fields: [{ name: "id", type: "uuid", fromStories: ["1"] }], relations: ["Project.id → Wallet.project_id"], fromStories: ["1"] },
      { name: "Wallet", fields: [{ name: "id", type: "uuid", fromStories: ["1"] }, { name: "project_id", type: "uuid", fromStories: ["1"] }], relations: ["Wallet.project_id → Project.id"], fromStories: ["1"] },
    ]);
    expect(inverse).toContain('id: text("id").primaryKey(),'); // project.id is a clean PK, no FK
    expect(inverse).not.toContain("references(() => wallet");
    expect(inverse).toContain('project_id: text("project_id").references(() => project.id).notNull(),'); // FK on the child
  });

  it("skips .references() when the target entity isn't in the model", () => {
    const orphan = compileDrizzleSchema([
      { name: "Ticket", fields: [{ name: "id", type: "uuid", fromStories: ["x"] }, { name: "ghost_id", type: "uuid", fromStories: ["x"] }], relations: ["ghost_id → Ghost.id"], fromStories: ["x"] },
    ]);
    expect(orphan).not.toContain(".references(");
    expect(orphan).toContain('ghost_id: text("ghost_id").notNull(),');
  });
});

describe("compileSqliteDdl", () => {
  it("maps types to SQLite affinities + emits PK, NOT NULL, enum CHECK, FK", () => {
    const ddl = compileSqliteDdl([
      { name: "Member", fields: [{ name: "id", type: "uuid", fromStories: ["1"] }], relations: [], fromStories: ["1"] },
      {
        name: "OperatorAuditLog",
        fields: [
          { name: "id", type: "uuid", fromStories: ["17"] },
          { name: "operator_id", type: "uuid", fromStories: ["17"] },
          { name: "action_type", type: "enum(certified|decertified)", fromStories: ["17"] },
          { name: "amount", type: "float", fromStories: ["17"] },
          { name: "note", type: "text|null", fromStories: ["17"] },
          { name: "created_at", type: "timestamp", fromStories: ["17"] },
        ],
        relations: ["OperatorAuditLog.operator_id → Member.id"],
        fromStories: ["17"],
      },
    ]);
    expect(sqliteType("uuid")).toBe("TEXT");
    expect(sqliteType("timestamp")).toBe("INTEGER");
    expect(sqliteType("float")).toBe("REAL");
    expect(ddl).toContain("CREATE TABLE member (");
    expect(ddl).toContain("id TEXT PRIMARY KEY");
    expect(ddl).toContain("operator_id TEXT NOT NULL REFERENCES member(id)");
    expect(ddl).toContain("action_type TEXT NOT NULL CHECK (action_type IN ('certified', 'decertified'))");
    expect(ddl).toContain("amount REAL NOT NULL");
    expect(ddl).toContain("note TEXT,"); // nullable: no NOT NULL
    expect(ddl).toContain("created_at INTEGER NOT NULL");
  });
});
