import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
} from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import {
  buildManifest,
  diffManifest,
  type Manifest,
  type TestEntry,
} from "@slowcook-ai/core";
import {
  discoverTests,
  validateStackConfig,
  type StackConfig,
} from "../stack-resolve.js";

const CLI_VERSION = "0.2.0";

interface ManifestArgs {
  subcommand: "record" | "verify";
  stackConfig: string;
  manifestPath: string;
  storyId: string | null;
  /** dovizir §9 — glob overriding the `story-<id>` filename convention. */
  match?: string;
  cwd: string;
}

function defaultManifestPath(storyId: string | null): string {
  return storyId
    ? `.brewing/manifests/story-${storyId}.json`
    : `.brewing/manifests/all.json`;
}

function parseArgs(argv: string[]): ManifestArgs {
  const sub = argv[0];
  if (sub !== "record" && sub !== "verify") {
    printHelp();
    process.exit(64);
  }
  const args: ManifestArgs = {
    subcommand: sub,
    stackConfig: ".brewing/stack.json",
    manifestPath: "",
    storyId: null,
    cwd: process.cwd(),
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--stack-config" && next) {
      args.stackConfig = next;
      i++;
    } else if (arg === "--manifest" && next) {
      args.manifestPath = next;
      i++;
    } else if (arg === "--match" && next) {
      args.match = next;
      i++;
    } else if (arg === "--story" && next) {
      args.storyId = next;
      i++;
    } else if (arg === "--cwd" && next) {
      args.cwd = next;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (!args.manifestPath) {
    args.manifestPath = defaultManifestPath(args.storyId);
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook manifest — record or verify the set of discoverable tests

Usage:
  slowcook manifest record [options]
  slowcook manifest verify [options]

Common options:
  --match <glob>           Which discovered files belong to this story, when the
                           stack does not name them story-<id>.test.* (e.g.
                           Foundry: --match '**/Wallet*.t.sol'). Overrides the
                           filename convention.
  --stack-config <path>    Path to stack.json (default: .brewing/stack.json)
  --manifest <path>        Path to write/read manifest JSON
                           (default: .brewing/manifests/all.json, or
                            .brewing/manifests/story-<id>.json if --story set)
  --story <id>             Tag manifest with this story id
  --cwd <path>             Working directory for discovery commands (default: .)
  --help, -h               Show this help

record:
  Runs every suite's discover_command, writes a manifest capturing the set
  of tests that exist right now. Meant for human-invoked freezing after a
  story's tests are approved.

verify:
  Re-runs discovery and compares against the recorded manifest. Exits 1 if
  any recorded test is no longer discoverable (file deleted, renamed, or
  broken). Newly-discovered tests are informational only.

Exit codes:
  0 = verify: manifest matches; record: manifest written
  1 = verify: missing tests detected
  2 = script error (missing config, exec failure, parse error)
`);
}

function sh(stackConfigPath: string, cwd: string): StackConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(stackConfigPath, "utf8"));
  } catch (e) {
    console.error(
      `Could not read stack config at ${stackConfigPath}: ${(e as Error).message}`
    );
    process.exit(2);
  }
  try {
    return validateStackConfig(raw);
  } catch (e) {
    console.error(`Invalid stack config: ${(e as Error).message}`);
    process.exit(2);
  }
  // unreachable — the two process.exit calls above terminate
}

function appendGhSummary(md: string): void {
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (!summary) return;
  try {
    appendFileSync(summary, md);
  } catch {
    // best effort
  }
}

export async function manifest(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const config = sh(args.stackConfig, args.cwd);

  if (args.subcommand === "record") {
    return recordManifest(args, config);
  }
  return verifyManifest(args, config);
}

function recordManifest(args: ManifestArgs, config: StackConfig): void {
  const { tests, suites, errors } = discoverTests(config, { cwd: args.cwd });

  if (errors.length > 0) {
    console.error("Discovery errors (refusing to record an incomplete manifest):");
    for (const err of errors) {
      console.error(`  [${err.suite}] ${err.message}`);
    }
    process.exit(2);
  }

  // 0.11.18+ — when `--story <id>` is set, FILTER the discovered
  // tests to those belonging to that story. Slowcook's per-story
  // file-naming convention is `tests/<dir>/story-<id>(.test.*|-*.test.*)`,
  // so we match files where the basename starts with `story-<id>`
  // followed by `.` or `-` (or end of path), preventing story-007
  // from matching story-0070.
  //
  // Without this filter, every story-N manifest captured all
  // discoverable tests, breaking brew's per-story scope: brew on
  // story-007 would target reds in stories 003/004/etc. and the
  // per-iter test scope was effectively the full suite. See slowcook
  // GitHub issue #5 for the original bug report.
  //
  // dovizir handover §9 — `story-<id>` in the FILENAME is a stack-ts naming
  // convention, not a universal one. Foundry suites are `*.t.sol` with no
  // story ids anywhere, so `--story N` matched nothing and manifest refused
  // to write; the live workaround was recording everything and hand-editing
  // `story_id`. `--match <glob>` lets a stack say how ITS files map to a
  // story, instead of the convention being hard-coded.
  let filteredTests = tests;
  let filteredSuites = suites;
  if (args.storyId || args.match) {
    const matcher = args.match
      ? globToRegExp(args.match)
      : new RegExp(`(?:^|/)story-${escapeRegex(args.storyId!)}(?:[-.]|$)`);
    filteredTests = tests.filter((t) => matcher.test(t.file));
    if (filteredTests.length === 0) {
      console.error(
        args.match
          ? `No tests matched --match "${args.match}" under the configured discovery roots. ` +
            `Refusing to write an empty manifest.`
          : `No tests matched story id "${args.storyId}". Expected files matching ` +
            `\`story-${args.storyId}.test.*\` or \`story-${args.storyId}-*.test.*\` ` +
            `under the configured discovery roots.\n` +
            `  That naming is a TypeScript convention — if this stack names test files ` +
            `differently (e.g. Foundry's \`*.t.sol\`), pass \`--match '<glob>'\` to say which ` +
            `files belong to this story. Refusing to write an empty manifest.`
      );
      process.exit(2);
    }
    // Recompute per-suite counts from the filtered set so the manifest's
    // `suites[].test_count` reflects the FILTERED total, not raw discovery.
    filteredSuites = suites.map((s) => ({
      ...s,
      test_count: filteredTests.filter((t) =>
        // Heuristic: tests whose suite-of-origin matches this suite name.
        // Slowcook only has one vitest suite today; this is a forward-
        // compat hedge for multi-suite stacks.
        true
      ).length,
    }));
  }

  // P4 — harvest @slowcook-rung markers so ladder mode has its release order.
  const markersByFile = new Map<string, { rung: number; title: string }[]>();
  for (const f of new Set(filteredTests.map((t) => t.file))) {
    try {
      const abs = isAbsolute(f) ? f : join(args.cwd ?? process.cwd(), f);
      if (existsSync(abs)) markersByFile.set(f, parseRungMarkers(readFileSync(abs, "utf8")));
    } catch { /* unreadable file = no rungs; ladder degrades to plain */ }
  }
  const rungedTests = assignRungs(filteredTests, markersByFile);
  const rungCount = rungedTests.filter((t) => t.release_order !== undefined).length;
  if (rungCount > 0) console.log(`  rungs: ${rungCount}/${rungedTests.length} tests carry release_order (ladder-ready)`);

  const m = buildManifest({
    slowcookVersion: CLI_VERSION,
    storyId: args.storyId,
    tests: rungedTests,
    suites: filteredSuites,
  });

  // Ensure directory exists
  const dir = dirname(args.manifestPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  writeFileSync(args.manifestPath, JSON.stringify(m, null, 2) + "\n", "utf8");

  console.log(
    `Recorded ${m.tests.length} test(s) across ${m.suites.length} suite(s) → ${args.manifestPath}` +
      (args.storyId
        ? ` (filtered to story-${args.storyId}; from ${tests.length} total discovered)`
        : "")
  );
  for (const s of m.suites) {
    console.log(`  [${s.suite}] ${s.test_count} tests`);
  }
  appendGhSummary(
    `### Manifest recorded\n\n- ${m.tests.length} tests across ${m.suites.length} suites\n- Written to \`${args.manifestPath}\`\n`
  );
}

/** Escape regex meta-characters in a story id (defensive — story ids
 *  are normally numeric, but the type allows any string). */
/**
 * Minimal glob → RegExp for `--match` (dovizir §9). Supports `**`, `*` and
 * `?`; everything else is literal. Deliberately small — this picks files out
 * of an already-discovered list, it is not a filesystem walker.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") { out += ".*"; i++; if (glob[i + 1] === "/") i++; }
      else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`(?:^|/)?${out}$`);
}

/**
 * Ladder rungs (P4). testgen annotates tests with \`// @slowcook-rung N\`
 * markers on the line above a describe/it. This parses a test FILE's markers
 * into ordered (rung, titleFragment) pairs, and assignRungs() maps each
 * discovered test id to its rung by first-matching title fragment. Tests
 * with no marker get no release_order (rung 0 — released immediately).
 */
export function parseRungMarkers(fileText: string): { rung: number; title: string }[] {
  const out: { rung: number; title: string }[] = [];
  const lines = fileText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /@slowcook-rung\s+(\d+)/.exec(lines[i]!);
    if (!m) continue;
    // the annotated declaration is the next non-comment line with a string title
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const t = /(?:describe|it|test)\s*\(\s*["'\`]([^"'\`]+)["'\`]/.exec(lines[j]!);
      if (t) { out.push({ rung: parseInt(m[1]!, 10), title: t[1]! }); break; }
    }
  }
  return out;
}

export function assignRungs(
  tests: { id: string; file: string }[],
  markersByFile: Map<string, { rung: number; title: string }[]>
): { id: string; file: string; release_order?: number }[] {
  return tests.map((t) => {
    const markers = markersByFile.get(t.file) ?? [];
    const hit = markers.find((mk) => t.id.includes(mk.title));
    return hit ? { ...t, release_order: hit.rung } : t;
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function verifyManifest(args: ManifestArgs, config: StackConfig): void {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(args.manifestPath, "utf8"));
  } catch (e) {
    console.error(
      `Could not read manifest at ${args.manifestPath}: ${(e as Error).message}`
    );
    process.exit(2);
  }

  const { tests, errors } = discoverTests(config, { cwd: args.cwd });
  if (errors.length > 0) {
    console.error("Discovery errors during verify:");
    for (const err of errors) {
      console.error(`  [${err.suite}] ${err.message}`);
    }
    // Discovery errors mean we can't trust the current snapshot — exit 2.
    process.exit(2);
  }

  const diff = diffManifest(manifest, tests);

  if (diff.missing.length === 0) {
    const msg = `Manifest verified: all ${manifest.tests.length} recorded tests still discoverable.${diff.added.length ? ` (${diff.added.length} new tests since record — informational.)` : ""}`;
    console.log(msg);
    appendGhSummary(`### Manifest verify\n\n✅ ${msg}\n`);
    if (diff.added.length) {
      console.log(`\nNew tests since record (informational):`);
      for (const t of diff.added) console.log(`  + ${t.id}`);
    }
    process.exit(0);
  }

  console.error(
    `Manifest verify FAILED: ${diff.missing.length} recorded test(s) no longer discoverable.`
  );
  for (const t of diff.missing) {
    console.error(`  - ${t.id}`);
    console.log(`::error file=${t.file}::Manifest verify — test missing from current discovery: ${t.id}`);
  }
  appendGhSummary(
    `### Manifest verify\n\n❌ ${diff.missing.length} recorded test(s) missing from current discovery.\n\n${diff.missing
      .map((t: TestEntry) => `- \`${t.id}\``)
      .join("\n")}\n`
  );
  process.exit(1);
}
