/**
 * `slowcook init entities` — 0.18.0-α.6 (entity-first foundation).
 *
 * Brownfield path: walks `supabase/migrations/*.sql`, parses the DDL
 * via the existing refine/mermaid `parseDdl`, and emits one
 * `src/lib/entities/<table>.ts` per table containing:
 *   - a TypeScript `interface` (compile-time contract)
 *   - a zod schema + inferred type (runtime parse for boundary
 *     validation)
 *   - a JSDoc header naming the source migrations
 *
 * Plus an `src/lib/entities/index.ts` barrel that re-exports everything.
 *
 * Why this matters (entity-first direction): refine + vibe + testgen
 * + plate + brew should all import the SAME canonical types when they
 * reference domain entities. Today every agent invents its own variant
 * — story-018's `profile`/`owner` drift is a representative case. With
 * generated entities + agents required to import them, drift becomes a
 * typecheck error, not a runtime test failure.
 *
 * Greenfield is deferred — a separate flow where refine designs entities
 * first; this command then runs over the resulting migrations.
 *
 * Idempotency: existing entity files with identical content are not
 * rewritten (preserves git mtime; avoids spurious diff churn). Files
 * with `// @slowcook-entity-protected` marker on the first line are
 * left alone — the consumer has hand-edited and we respect it.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseDdl, type ErdColumn, type ErdEntity } from "../refine/mermaid.js";

interface EntitiesArgs {
  cwd: string;
  outDir: string;
  dryRun: boolean;
  /** Path under cwd to find SQL migrations. Default: supabase/migrations */
  migrationsDir: string;
}

function parseArgs(argv: string[]): EntitiesArgs {
  const args: EntitiesArgs = {
    cwd: process.cwd(),
    outDir: "src/lib/entities",
    dryRun: false,
    migrationsDir: "supabase/migrations",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--cwd" && next) { args.cwd = next; i++; }
    else if (a === "--out" && next) { args.outDir = next; i++; }
    else if (a === "--migrations" && next) { args.migrationsDir = next; i++; }
    else if (a === "--dry-run") { args.dryRun = true; }
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook init entities — extract domain ERD → typed schemas (0.18.0-α.6+)

Usage:
  slowcook init entities [--cwd <path>] [--out <dir>] [--migrations <dir>] [--dry-run]

Options:
  --cwd <path>        Repo root (default: current dir).
  --out <dir>         Output directory under cwd (default: src/lib/entities).
  --migrations <dir>  Migrations dir under cwd (default: supabase/migrations).
  --dry-run           Print what would be written; do not touch the filesystem.

What it does:
  1. Concatenates every *.sql under <migrations>/.
  2. Parses CREATE TABLE + ALTER TABLE ADD COLUMN via the same DDL
     parser refine uses for its Mermaid ERD.
  3. For each table, writes <out>/<table>.ts containing:
       - an interface declaration
       - a zod schema + inferred type
  4. Writes <out>/index.ts barrel.

Idempotent: files with identical content aren't rewritten. Files
beginning with the marker '// @slowcook-entity-protected' are skipped
entirely (consumer hand-edit respected).

Exit codes:
  0  success
  2  no migrations found / output dir blocked
`);
}

const PROTECTED_MARKER = "// @slowcook-entity-protected";

interface EmittedFile {
  path: string;
  content: string;
  action: "create" | "update" | "skip-identical" | "skip-protected";
}

export async function initEntities(argv: string[], _cliVersion: string): Promise<void> {
  const args = parseArgs(argv);

  console.log(`slowcook init entities · cwd: ${relative(process.cwd(), args.cwd) || "."}`);

  const migrationsAbs = join(args.cwd, args.migrationsDir);
  if (!existsSync(migrationsAbs)) {
    console.error(`No migrations directory at ${args.migrationsDir} — nothing to extract.`);
    console.error(`Hint: --migrations <path> if your migrations live elsewhere.`);
    process.exit(2);
  }

  const sqlFiles = readdirSync(migrationsAbs)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  if (sqlFiles.length === 0) {
    console.error(`${args.migrationsDir} is empty — nothing to extract.`);
    process.exit(2);
  }

  console.log(`  parsing ${sqlFiles.length} migration file(s) under ${args.migrationsDir}/`);
  const ddl = sqlFiles.map((f) => readFileSync(join(migrationsAbs, f), "utf8")).join("\n");
  const { entities, relationships } = parseDdl(ddl);

  if (entities.size === 0) {
    console.warn(`  no entities recognized in DDL (CREATE TABLE patterns matched 0 times)`);
    process.exit(2);
  }

  // Real-world brownfield migrations frequently add the same column
  // twice — once via `add column foo` then again later via
  // `add column if not exists foo` for idempotent backfills. parseDdl
  // appends both occurrences. Dedupe by column name, keeping the LAST
  // declaration (most recent migration usually has the canonical
  // type / nullability).
  for (const entity of entities.values()) {
    const seen = new Map<string, ErdColumn>();
    for (const col of entity.columns) seen.set(col.name, col);
    entity.columns = [...seen.values()];
  }

  // Build relationships index for cross-references in JSDoc.
  const fkByTable = new Map<string, Array<{ col: string; refsTable: string }>>();
  for (const rel of relationships) {
    if (!fkByTable.has(rel.to)) fkByTable.set(rel.to, []);
    fkByTable.get(rel.to)!.push({ col: rel.label, refsTable: rel.from });
  }

  const outDirAbs = join(args.cwd, args.outDir);
  if (!args.dryRun) mkdirSync(outDirAbs, { recursive: true });

  const emitted: EmittedFile[] = [];
  for (const entity of entities.values()) {
    const fkRefs = fkByTable.get(entity.name) ?? [];
    const content = renderEntityFile({
      entity,
      sourceMigrations: sqlFiles,
      fkRefs,
    });
    const filePath = join(outDirAbs, `${entity.name}.ts`);
    const action = decideAction(filePath, content);
    emitted.push({ path: filePath, content, action });
    if (!args.dryRun && (action === "create" || action === "update")) {
      writeFileSync(filePath, content, "utf8");
    }
  }

  // Barrel index.
  const indexContent = renderIndexFile([...entities.keys()].sort());
  const indexPath = join(outDirAbs, "index.ts");
  const indexAction = decideAction(indexPath, indexContent);
  emitted.push({ path: indexPath, content: indexContent, action: indexAction });
  if (!args.dryRun && (indexAction === "create" || indexAction === "update")) {
    writeFileSync(indexPath, indexContent, "utf8");
  }

  // Report
  for (const e of emitted) {
    const rel = relative(args.cwd, e.path);
    const marker =
      e.action === "create" ? "CREATE" :
      e.action === "update" ? "UPDATE" :
      e.action === "skip-protected" ? "SKIP  " : "SKIP  ";
    const reason =
      e.action === "skip-identical" ? " (identical)" :
      e.action === "skip-protected" ? " (@slowcook-entity-protected marker)" : "";
    console.log(`  ${marker}  ${rel}${reason}`);
  }
  const created = emitted.filter((e) => e.action === "create").length;
  const updated = emitted.filter((e) => e.action === "update").length;
  const skipped = emitted.filter((e) => e.action.startsWith("skip-")).length;
  console.log(
    `${args.dryRun ? "[dry-run] " : ""}done · ${created} created · ${updated} updated · ${skipped} skipped · ${entities.size} entities total`
  );
}

function decideAction(path: string, content: string): EmittedFile["action"] {
  if (!existsSync(path)) return "create";
  const existing = readFileSync(path, "utf8");
  if (existing.startsWith(PROTECTED_MARKER)) return "skip-protected";
  if (existing === content) return "skip-identical";
  return "update";
}

/**
 * Map a normalised Postgres type to a zod schema + TS type fragment.
 * Returns the raw zod call (without `.nullable()` etc.) and the bare TS
 * type. The caller layers null + readonly modifiers.
 */
function pgTypeToTsAndZod(type: string): { ts: string; zod: string } {
  switch (type) {
    case "uuid":
      return { ts: "string", zod: "z.string().uuid()" };
    case "text":
      return { ts: "string", zod: "z.string()" };
    case "int":
      return { ts: "number", zod: "z.number().int()" };
    case "bool":
      return { ts: "boolean", zod: "z.boolean()" };
    case "timestamptz":
      return { ts: "string", zod: "z.string().datetime({ offset: true })" };
    case "numeric":
      return { ts: "number", zod: "z.number()" };
    case "jsonb":
      return { ts: "unknown", zod: "z.unknown()" };
    case "bytea":
      return { ts: "Uint8Array", zod: "z.instanceof(Uint8Array)" };
    default:
      return { ts: "unknown", zod: "z.unknown()" };
  }
}

function pascalCase(s: string): string {
  return s
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

function renderColumn(col: ErdColumn): { interfaceLine: string; schemaLine: string } {
  const { ts, zod } = pgTypeToTsAndZod(col.type);
  const isNullable = !col.hints.includes("NN") && !col.hints.includes("PK");
  const pkComment = col.hints.includes("PK") ? " /** PK */" : "";
  const hintsAttr = col.hints.length > 0 ? ` // ${col.hints.join(" ")}` : "";
  const interfaceLine = isNullable
    ? `  ${col.name}: ${ts} | null;${pkComment}${hintsAttr}`
    : `  ${col.name}: ${ts};${pkComment}${hintsAttr}`;
  const zodValue = isNullable ? `${zod}.nullable()` : zod;
  const schemaLine = `  ${col.name}: ${zodValue},`;
  return { interfaceLine, schemaLine };
}

interface RenderArgs {
  entity: ErdEntity;
  sourceMigrations: string[];
  fkRefs: Array<{ col: string; refsTable: string }>;
}

function renderEntityFile(args: RenderArgs): string {
  const { entity, sourceMigrations, fkRefs } = args;
  const typeName = pascalCase(entity.name);
  const schemaName = `${typeName}Schema`;

  const cols = entity.columns.map(renderColumn);
  const interfaceBody = cols.map((c) => c.interfaceLine).join("\n");
  const schemaBody = cols.map((c) => c.schemaLine).join("\n");

  const fkLines = fkRefs.length
    ? fkRefs.map((r) => ` *   - ${r.col} → ${r.refsTable}`).join("\n") + "\n"
    : "";

  return `/**
 * AUTO-GENERATED by \`slowcook init entities\`. Do not hand-edit.
 *
 * To customise: prefix this file with \`${PROTECTED_MARKER}\` on the
 * first line. Future regenerations will leave the file alone.
 *
 * Source migrations:
${sourceMigrations.map((m) => ` *   - ${m}`).join("\n")}
${fkRefs.length ? ` *\n * Foreign keys:\n${fkLines} */` : " */"}
import { z } from "zod";

export interface ${typeName} {
${interfaceBody}
}

export const ${schemaName} = z.object({
${schemaBody}
});

export type ${typeName}Inferred = z.infer<typeof ${schemaName}>;
`;
}

function renderIndexFile(tableNames: string[]): string {
  const lines = tableNames
    .map((t) => `export * from "./${t}.js";`)
    .join("\n");
  return `/**
 * AUTO-GENERATED by \`slowcook init entities\`. Do not hand-edit.
 *
 * Re-exports every entity declared from supabase/migrations/. Agents
 * (vibe / testgen / plate / brew) should import canonical entity types
 * from this barrel rather than re-declaring shapes per story.
 */
${lines}
`;
}

// Exported for unit tests.
export const __internals = {
  pgTypeToTsAndZod,
  pascalCase,
  renderEntityFile,
  renderIndexFile,
  decideAction,
  PROTECTED_MARKER,
};
