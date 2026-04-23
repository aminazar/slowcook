import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { findStaleFixtures, detectUnscrubbed } from "@slowcook-ai/recorder";

interface FixturesArgs {
  subcommand: "check" | null;
  cwd: string;
  maxAgeDays: number;
  storyId: string | null;
}

function parseArgs(argv: string[]): FixturesArgs {
  const args: FixturesArgs = {
    subcommand: (argv[0] as "check" | undefined) ?? null,
    cwd: process.cwd(),
    maxAgeDays: 14,
    storyId: null,
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--cwd" && next) {
      args.cwd = next;
      i++;
    } else if (arg === "--max-age-days" && next) {
      args.maxAgeDays = parseInt(next, 10);
      i++;
    } else if (arg === "--story" && next) {
      args.storyId = next;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook fixtures — manage tier-2 acceptance fixtures

Usage:
  slowcook fixtures check [options]

Options:
  --cwd <path>            Repo root (default: .)
  --max-age-days <n>      Fixtures older than this are flagged (default: 14)
  --story <id>            Scope to a single story (default: all stories)
  --help, -h              Show this help

What it does:
  1. Scans every *.json file under tests/fixtures/story-*/**/
  2. Flags fixtures whose recorded_at timestamp is older than the
     threshold. Forces periodic re-record so drift between captured
     data and the live service surfaces quickly.
  3. Scans each fixture's JSON for patterns that should have been
     scrubbed (UUIDs, emails, JWTs, Supabase keys, Bearer tokens).
     Any hit blocks the PR — committed fixtures must never contain
     unscrubbed secrets.
  4. Honours a per-story exemption: if the story's spec has a
     @fixtures-frozen <reason> marker, the story's staleness check
     is skipped (the scrub guard still runs regardless).

Exit codes:
  0   all fixtures clean
  1   at least one stale fixture or scrub violation found
  2   script error (bad args, missing directories, etc.)
`);
}

async function fixturesCheck(args: FixturesArgs): Promise<void> {
  const fixturesRoot = join(args.cwd, "tests/fixtures");

  if (!existsSync(fixturesRoot)) {
    console.log("Noop: tests/fixtures/ does not exist yet. First record run will create it.");
    return;
  }

  // 1. Staleness
  const exemptStories = findFixtureFrozenStories(join(args.cwd, "specs"));
  const stale = findStaleFixtures({
    fixturesRoot,
    ...(args.storyId ? { storyId: args.storyId } : {}),
    maxAgeDays: args.maxAgeDays,
  }).filter((s) => {
    const match = s.path.match(/story-([^/]+)/);
    return !(match && exemptStories.has(match[1] ?? ""));
  });

  // 2. Scrub violations
  const scrubHits: Array<{ path: string; hits: { pattern: string; hit: string }[] }> = [];
  walkJsonFiles(fixturesRoot, (filePath) => {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      const hits = detectUnscrubbed(parsed);
      if (hits.length > 0) scrubHits.push({ path: filePath, hits });
    } catch {
      /* malformed JSON — leave for another linter */
    }
  });

  // Report
  let failed = false;

  if (stale.length > 0) {
    failed = true;
    console.error(`\n✗ ${stale.length} stale fixture(s) (older than ${args.maxAgeDays} days):`);
    for (const s of stale) {
      console.error(`   ${s.path} — ${s.ageDays}d old (recorded_at: ${s.recordedAt ?? "unknown"})`);
    }
    console.error(`\nRe-record by running tests with SLOWCOOK_RECORD=1, or add a @fixtures-frozen marker to the story's spec.`);
  }

  if (scrubHits.length > 0) {
    failed = true;
    console.error(`\n✗ ${scrubHits.length} fixture(s) contain unscrubbed patterns:`);
    for (const f of scrubHits) {
      const uniqueHits = new Set(f.hits.map((h) => h.pattern));
      console.error(`   ${f.path} — patterns: ${Array.from(uniqueHits).join(", ")}`);
    }
    console.error(`\nRe-record with SLOWCOOK_RECORD=1 to regenerate with scrubbing applied, or extend scrubConfig.`);
  }

  if (failed) {
    process.exit(1);
  }

  console.log(`✓ All fixtures clean (${countJsonFiles(fixturesRoot)} file(s) checked).`);
}

function walkJsonFiles(dir: string, visit: (path: string) => void): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = tryStat(full);
    if (!stat) continue;
    if (stat.isDirectory()) walkJsonFiles(full, visit);
    else if (stat.isFile() && full.endsWith(".json")) visit(full);
  }
}

function countJsonFiles(dir: string): number {
  let count = 0;
  walkJsonFiles(dir, () => {
    count++;
  });
  return count;
}

function tryStat(p: string): { isDirectory(): boolean; isFile(): boolean } | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/**
 * Read specs/story-*.yaml; return story ids whose spec contains a
 * `@fixtures-frozen` marker. Shallow scan — we just grep the raw
 * YAML for the marker. Keeps this command free of a YAML parser.
 */
function findFixtureFrozenStories(specsDir: string): Set<string> {
  const frozen = new Set<string>();
  if (!existsSync(specsDir)) return frozen;
  for (const entry of readdirSync(specsDir)) {
    const match = entry.match(/^story-(.+)\.yaml$/);
    if (!match) continue;
    try {
      const src = readFileSync(join(specsDir, entry), "utf8");
      if (/@fixtures-frozen\b/.test(src)) frozen.add(match[1] ?? "");
    } catch {
      /* unreadable; ignore */
    }
  }
  return frozen;
}

export async function fixtures(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  switch (args.subcommand) {
    case "check":
      await fixturesCheck(args);
      return;
    case null:
      printHelp();
      return;
    default:
      console.error(`Unknown fixtures subcommand: ${args.subcommand}`);
      printHelp();
      process.exit(64);
  }
}
