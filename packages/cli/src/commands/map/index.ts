import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { generateMap } from "./scan.js";
import {
  renderJson,
  renderMarkdown,
  mapsEqual,
  CODE_MAP_JSON_PATH,
  CODE_MAP_MD_PATH,
} from "./render.js";
import type { CodeMap } from "./scan.js";
import { ddlToMermaidErd } from "../refine/mermaid.js";

interface MapArgs {
  subcommand: "generate" | "check";
  repoRoot: string;
  out: string;
  md: string;
  /**
   * 0.13.2+ (brownfield-extraction track for 0.14 mockup-first refinement):
   * also emit `.brewing/diagrams/schema.mmd` from `supabase/migrations/*.sql`.
   * Foundation for refine reading the consumer's existing schema before
   * proposing new tables / FK shapes.
   */
  emitSchema: boolean;
}

function parseArgs(argv: string[]): MapArgs {
  const args: MapArgs = {
    subcommand: "generate",
    repoRoot: process.cwd(),
    out: CODE_MAP_JSON_PATH,
    md: CODE_MAP_MD_PATH,
    emitSchema: false,
  };
  const first = argv[0];
  if (first === "generate" || first === "check") {
    args.subcommand = first;
    argv = argv.slice(1);
  } else if (first === "--help" || first === "-h") {
    printHelp();
    process.exit(0);
  } else if (first && !first.startsWith("-")) {
    console.error(`Unknown subcommand: ${first}`);
    printHelp();
    process.exit(64);
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--cwd" && next) { args.repoRoot = next; i++; }
    else if (a === "--out" && next) { args.out = next; i++; }
    else if (a === "--md" && next) { args.md = next; i++; }
    else if (a === "--emit-schema") { args.emitSchema = true; }
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook map — generate / check the repo-wide code map

The map is a structured list of API routes, pages, React components,
helper functions, and domain types. Lives at \`.brewing/code-map.json\`
(+ rendered \`.brewing/code-map.md\`). The brewing agent reads it as
context so it doesn't have to re-read files every iteration.

Usage:
  slowcook map generate [--cwd <path>] [--out <path>] [--md <path>] [--emit-schema]
  slowcook map check    [--cwd <path>] [--out <path>]

  generate   Write a fresh map to .brewing/code-map.{json,md}.
  check      Fail with exit 1 if the committed map differs from a fresh
             generation. Meant for CI — keeps the map honest.

Options:
  --cwd <path>      Repo root (default: cwd).
  --out <path>      JSON output path (default: .brewing/code-map.json).
  --md  <path>      Markdown output path (default: .brewing/code-map.md).
  --emit-schema     Brownfield: also emit .brewing/diagrams/schema.mmd from
                    supabase/migrations/*.sql (Mermaid erDiagram). Skipped
                    silently when no migrations directory exists.
`);
}

export async function map(argv: string[], cliVersion: string): Promise<void> {
  const args = parseArgs(argv);

  const fresh = generateMap({
    repoRoot: args.repoRoot,
    slowcookVersion: cliVersion,
  });

  if (args.subcommand === "generate") {
    writeFreshMap(args.repoRoot, args.out, args.md, fresh);
    summary(fresh);
    if (args.emitSchema) {
      const schemaResult = emitSchemaDiagram(args.repoRoot);
      if (schemaResult.written) {
        console.log(
          `Wrote .brewing/diagrams/schema.mmd (${schemaResult.entityCount} entities, ${schemaResult.migrationsCount} migrations parsed).`
        );
      } else {
        console.log(
          `Skipped schema emit: ${schemaResult.skippedReason}`
        );
      }
    }
    return;
  }

  // check: compare existing committed map to a fresh regen.
  //
  // 0.12.4+ — code-map files are gitignored by default (see init's
  // gitignore section). When the file isn't present, the check
  // becomes a no-op success: the brew/CI workflow regenerates the
  // map at runtime via `slowcook map generate`, so "missing" is the
  // expected state on a fresh checkout. Existing consumers that
  // still commit the map (pre-0.12.4 setups) keep the staleness
  // verdict.
  const existingPath = join(args.repoRoot, args.out);
  if (!existsSync(existingPath)) {
    console.log(
      `✓ Map check skipped — ${args.out} is not committed (gitignored as of 0.12.4). ` +
        `The map regenerates fresh on every \`slowcook map generate\` / brew iter / CI workflow start.`
    );
    return;
  }
  let existing: CodeMap;
  try {
    existing = JSON.parse(readFileSync(existingPath, "utf8")) as CodeMap;
  } catch (e) {
    console.error(
      `Map check failed: could not parse ${args.out} — ${(e as Error).message}. Run \`slowcook map generate\` to refresh.`
    );
    process.exit(1);
  }
  if (mapsEqual(existing, fresh)) {
    console.log(`✓ Map is up to date (${summaryCounts(fresh)}).`);
    return;
  }
  console.error(
    `✗ Map is stale. The committed \`${args.out}\` does not match what would be generated from the current source tree.\n\n` +
      `  Committed: ${summaryCounts(existing)}\n` +
      `  Fresh:     ${summaryCounts(fresh)}\n\n` +
      `Either regenerate (\`npx slowcook map generate\` then commit), ` +
      `OR if you've migrated to gitignored code-map (slowcook 0.12.4+), ` +
      `delete the committed file (\`git rm .brewing/code-map.json .brewing/code-map.md\`) and the check will become a no-op.`
  );
  process.exit(1);
}

export function writeFreshMap(
  repoRoot: string,
  outJson: string,
  outMd: string,
  fresh: CodeMap
): void {
  const jsonPath = join(repoRoot, outJson);
  const mdPath = join(repoRoot, outMd);
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, renderJson(fresh), "utf8");
  writeFileSync(mdPath, renderMarkdown(fresh), "utf8");
}

function summary(map: CodeMap): void {
  console.log(`Wrote ${CODE_MAP_JSON_PATH} + ${CODE_MAP_MD_PATH}`);
  console.log(`  ${summaryCounts(map)}`);
}

function summaryCounts(m: CodeMap): string {
  return `${m.api_routes.length} routes, ${m.pages.length} pages, ${m.components.length} components, ${m.helpers.length} helpers, ${m.types.length} types`;
}

/**
 * 0.13.2 (brownfield-extraction track for 0.14 mockup-first refinement) —
 * walk `supabase/migrations/*.sql`, concatenate, hand to ddlToMermaidErd,
 * write `.brewing/diagrams/schema.mmd`. Refine reads this file later as
 * project-awareness so its proposals (new tables / FKs) align with the
 * existing entity vocabulary instead of inventing.
 *
 * Skipped silently when no `supabase/migrations/` directory exists —
 * not every consumer uses Supabase.
 */
export function emitSchemaDiagram(repoRoot: string): {
  written: boolean;
  entityCount?: number;
  migrationsCount?: number;
  skippedReason?: string;
} {
  const dir = join(repoRoot, "supabase/migrations");
  if (!existsSync(dir)) {
    return { written: false, skippedReason: "no supabase/migrations/ directory" };
  }
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  if (files.length === 0) {
    return { written: false, skippedReason: "supabase/migrations/ is empty" };
  }
  const ddl = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  const mermaid = ddlToMermaidErd(ddl);
  // Count entities — quick parse of the rendered output.
  // Each entity becomes a `  NAME {` line in the erDiagram block.
  const entityCount = (mermaid.match(/^ {2}[A-Z_]+\s*\{/gm) ?? []).length;

  const outDir = join(repoRoot, ".brewing/diagrams");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "schema.mmd");
  const header =
    `<!-- Auto-emitted by \`slowcook map --emit-schema\`. Do not hand-edit; regenerate. -->\n` +
    `<!-- Source: ${files.length} migration file(s) under supabase/migrations/. -->\n\n`;
  writeFileSync(outPath, header + mermaid + "\n", "utf8");
  return { written: true, entityCount, migrationsCount: files.length };
}
