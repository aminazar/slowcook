import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
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

interface MapArgs {
  subcommand: "generate" | "check";
  repoRoot: string;
  out: string;
  md: string;
}

function parseArgs(argv: string[]): MapArgs {
  const args: MapArgs = {
    subcommand: "generate",
    repoRoot: process.cwd(),
    out: CODE_MAP_JSON_PATH,
    md: CODE_MAP_MD_PATH,
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
  slowcook map generate [--cwd <path>] [--out <path>] [--md <path>]
  slowcook map check    [--cwd <path>] [--out <path>]

  generate   Write a fresh map to .brewing/code-map.{json,md}.
  check      Fail with exit 1 if the committed map differs from a fresh
             generation. Meant for CI — keeps the map honest.

Options:
  --cwd <path>   Repo root (default: cwd).
  --out <path>   JSON output path (default: .brewing/code-map.json).
  --md  <path>   Markdown output path (default: .brewing/code-map.md).
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
    return;
  }

  // check: compare existing committed map to a fresh regen
  const existingPath = join(args.repoRoot, args.out);
  if (!existsSync(existingPath)) {
    console.error(
      `Map check failed: no map found at ${args.out}. Run \`slowcook map generate\` and commit the result.`
    );
    process.exit(1);
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
      `Fix by running:\n  npx slowcook map generate\nThen commit the updated ${args.out} + ${args.md}.`
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
