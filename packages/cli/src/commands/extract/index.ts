import {
  emitSchemaDiagram,
  emitTokensCatalog,
  emitEntitiesDiagram,
} from "../map/index.js";
import { runSurvey, writeSurvey } from "./survey.js";
import { runAsBuiltCli } from "./as-built-cli.js";

/**
 * 0.13.5+ — focused brownfield extraction command. A thin wrapper over
 * `emitSchemaDiagram` + `emitTokensCatalog` from the map package, exposed
 * as a top-level command so refine / investigate workflows can run it
 * WITHOUT first paying for `slowcook map generate`'s ts-morph scan +
 * `npm ci`. Both emitters are pure regex/filesystem walks over their
 * inputs (supabase/migrations + **\/*.css) — they don't need the
 * consumer's node_modules installed.
 *
 * Usage:
 *   slowcook extract                    # all extracts (current default)
 *   slowcook extract --schema           # just .brewing/diagrams/schema.mmd
 *   slowcook extract --tokens           # just .brewing/diagrams/tokens.md
 *   slowcook extract --cwd <path>
 *
 * Outputs land in `.brewing/diagrams/` (gitignored — regenerated each
 * refine run, lives only as long as the workflow's checkout).
 */
interface ExtractArgs {
  repoRoot: string;
  schema: boolean;
  tokens: boolean;
  entities: boolean;
  survey: boolean;
  asBuilt: boolean;
  allowUncited: boolean;
  model: string | null;
}

function parseArgs(argv: string[]): ExtractArgs {
  const args: ExtractArgs = {
    repoRoot: process.cwd(),
    schema: false,
    tokens: false,
    entities: false,
    survey: false,
    asBuilt: false,
    allowUncited: false,
    model: null,
  };
  let any = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--cwd" && next) {
      args.repoRoot = next;
      i++;
    } else if (a === "--schema") {
      args.schema = true;
      any = true;
    } else if (a === "--tokens") {
      args.tokens = true;
      any = true;
    } else if (a === "--entities") {
      args.entities = true;
      any = true;
    } else if (a === "--survey") {
      args.survey = true;
      any = true;
    } else if (a === "--as-built") {
      args.asBuilt = true;
      any = true;
    } else if (a === "--allow-uncited") {
      args.allowUncited = true;
    } else if (a === "--model" && next) {
      args.model = next;
      i++;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${a}`);
      printHelp();
      process.exit(64);
    }
  }
  // Default = extract everything when no specific flag is passed.
  if (!any) {
    args.schema = true;
    args.tokens = true;
    args.entities = true;
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook extract — brownfield project-awareness extracts

Walks the consumer's existing code/config and writes refine-readable
context blocks to .brewing/diagrams/. Designed to run BEFORE refine /
investigate so their proposals align with the project's existing
schema + design tokens instead of inventing.

Usage:
  slowcook extract [--schema] [--tokens] [--entities] [--cwd <path>]
  slowcook extract --survey   [--cwd <path>]
  slowcook extract --as-built [--cwd <path>] [--model <id>] [--allow-uncited]

  No flag = the diagram extracts (--schema + --tokens + --entities).
  Diagram outputs are gitignored; regenerate per refine run.
  --survey / --as-built outputs are INTAKE ARTIFACTS — commit them.

Targets:
  --schema    .brewing/diagrams/schema.mmd
              Mermaid erDiagram from supabase/migrations/*.sql.
              Skipped silently when no migrations directory exists.
  --tokens    .brewing/diagrams/tokens.md
              Design-token catalog from :root + @theme blocks in
              **/*.css (skipping node_modules / .next / build dirs).
              Skipped silently when no .css files / no tokens are found.
  --entities  .brewing/diagrams/entities.md (0.19.0+ / slowcook#36)
              Mermaid ERD + per-entity table from TypeORM
              **/*.entity.ts files containing @Entity decorators.
              Skipped silently when no entity files are found (e.g.
              Prisma / Drizzle / Supabase consumers). Tracked in git
              by default; the init gitignore template carves out an
              exception for this file.

  --survey    .brewing/extract-survey.json (#262 tier 0 — deterministic).
              Doc catalog dated via git (stale-honest), story-spec
              aggregate, commit/branch evidence, issues/PRs via gh when
              available. Entries are knowledge-claim shaped for direct
              ingestion by §7.18-style intakes.
  --as-built  .brewing/as-built.md (#262 tier 1 — LLM, key-less capable
              via SLOWCOOK_LLM=claude-cli). AS-OBSERVED product truth in
              five fixed sections; every bullet must carry a (path)
              citation — enforced by a validator; founder questions
              close the doc. Fails on uncited bullets unless
              --allow-uncited.

This command does NOT run the ts-morph code-map scan; for that,
use \`slowcook map generate\`.
`);
}

export async function extract(argv: string[], _cliVersion: string): Promise<void> {
  const args = parseArgs(argv);

  if (args.survey || args.asBuilt) {
    const survey = runSurvey(args.repoRoot);
    if (args.survey) {
      const file = writeSurvey(args.repoRoot, survey);
      console.log(`Wrote ${file} (${survey.claims.length} claims${survey.skipped.length ? `; skipped: ${survey.skipped.join("; ")}` : ""}).`);
    }
    if (args.asBuilt) {
      await runAsBuiltCli(args.repoRoot, survey, { model: args.model, allowUncited: args.allowUncited });
    }
    return;
  }

  if (args.schema) {
    const r = emitSchemaDiagram(args.repoRoot);
    if (r.written) {
      console.log(
        `Wrote .brewing/diagrams/schema.mmd (${r.entityCount} entities, ${r.migrationsCount} migrations parsed).`
      );
    } else {
      console.log(`Skipped schema extract: ${r.skippedReason}`);
    }
  }

  if (args.tokens) {
    const r = emitTokensCatalog(args.repoRoot);
    if (r.written) {
      console.log(
        `Wrote .brewing/diagrams/tokens.md (${r.lightCount} light, ${r.darkCount} dark, ${r.themeCount} @theme; ${r.filesScanned} css file(s) scanned).`
      );
    } else {
      console.log(`Skipped tokens extract: ${r.skippedReason}`);
    }
  }

  if (args.entities) {
    const r = emitEntitiesDiagram(args.repoRoot);
    if (r.written) {
      console.log(
        `Wrote .brewing/diagrams/entities.md (${r.entityCount} entities, ${r.relationCount} relations, ${r.fileCount} *.entity.ts file(s) scanned).`
      );
    } else {
      console.log(`Skipped entities extract: ${r.skippedReason}`);
    }
  }
}
