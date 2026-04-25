import { emitSchemaDiagram, emitTokensCatalog } from "../map/index.js";

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
}

function parseArgs(argv: string[]): ExtractArgs {
  const args: ExtractArgs = {
    repoRoot: process.cwd(),
    schema: false,
    tokens: false,
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
  slowcook extract [--schema] [--tokens] [--cwd <path>]

  No flag = extract everything (currently --schema + --tokens).
  Outputs are gitignored; regenerate per refine run.

Targets:
  --schema    .brewing/diagrams/schema.mmd
              Mermaid erDiagram from supabase/migrations/*.sql.
              Skipped silently when no migrations directory exists.
  --tokens    .brewing/diagrams/tokens.md
              Design-token catalog from :root + @theme blocks in
              **/*.css (skipping node_modules / .next / build dirs).
              Skipped silently when no .css files / no tokens are found.

This command does NOT run the ts-morph code-map scan; for that,
use \`slowcook map generate\`.
`);
}

export async function extract(argv: string[], _cliVersion: string): Promise<void> {
  const args = parseArgs(argv);

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
}
