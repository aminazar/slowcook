import { readFileSync, appendFileSync } from "node:fs";
import { execSync } from "node:child_process";
import {
  checkFrozenPaths,
  type FrozenPathsConfig,
  type ChangedFile,
  type Violation,
} from "@slowcook-ai/core";

interface GuardArgs {
  base: string;
  head: string;
  override: boolean;
  config: string;
}

function parseArgs(argv: string[]): GuardArgs {
  const args: GuardArgs = {
    base: "origin/main",
    head: "HEAD",
    override: false,
    config: ".brewing/frozen-paths.json",
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--base" && next) {
      args.base = next;
      i++;
    } else if (arg === "--head" && next) {
      args.head = next;
      i++;
    } else if (arg === "--override") {
      args.override = true;
    } else if (arg === "--config" && next) {
      args.config = next;
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
slowcook guard — enforce frozen paths between two git refs

Usage:
  slowcook guard [options]

Options:
  --base <ref>       Base git ref to compare from (default: origin/main)
  --head <ref>       Head git ref to compare to (default: HEAD)
  --override         Report violations but exit 0 (use via CI label for audit)
  --config <path>    Config file path (default: .brewing/frozen-paths.json)
  --help, -h         Show this help

Exit codes:
  0 = no violations (or --override and there were violations)
  1 = violations
  2 = script error (bad config, git failure)
`);
}

function sh(cmd: string): string {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

function appendGhSummary(md: string): void {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  try {
    appendFileSync(summary, md);
  } catch {
    // best effort — CI output is the source of truth
  }
}

export async function guard(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  // Load config
  let config: FrozenPathsConfig;
  try {
    config = JSON.parse(readFileSync(args.config, "utf8"));
  } catch (e) {
    console.error(
      `Could not read config at ${args.config}: ${(e as Error).message}`
    );
    process.exit(2);
  }

  // Collect changed files
  let paths: string[];
  try {
    const out = sh(`git diff --name-only ${args.base}...${args.head}`);
    paths = out ? out.split("\n").filter(Boolean) : [];
  } catch (e) {
    console.error(
      `git diff failed between ${args.base} and ${args.head}: ${(e as Error).message}`
    );
    process.exit(2);
  }

  if (paths.length === 0) {
    console.log("No changed files.");
    process.exit(0);
  }

  // For partial-freeze files, fetch base/head content
  const partial = config.partial ?? {};
  const changed: ChangedFile[] = paths.map((path) => {
    const out: ChangedFile = { path };
    if (partial[path]) {
      try {
        out.baseContent = sh(`git show ${args.base}:${path}`);
      } catch {
        // file didn't exist at base — leave undefined
      }
      try {
        out.headContent = readFileSync(path, "utf8");
      } catch {
        // file doesn't exist in working tree (deleted)
      }
    }
    return out;
  });

  const violations = checkFrozenPaths(changed, config);

  if (violations.length === 0) {
    console.log(
      `No frozen-path violations in ${paths.length} changed file(s).`
    );
    appendGhSummary(
      `### Frozen-path guard\n\n✅ No violations in ${paths.length} changed file(s).\n`
    );
    process.exit(0);
  }

  const lines = violations.map(
    (v: Violation) => `- \`${v.file}\` — ${v.rule}`
  );
  console.error(`Frozen-path violations (${violations.length}):`);
  console.error(lines.join("\n"));

  const mdHeader = `### Frozen-path guard\n\n`;
  if (args.override) {
    appendGhSummary(
      `${mdHeader}⚠️ ${violations.length} violation(s), but \`--override\` is set — advisory only.\n\n${lines.join("\n")}\n`
    );
    console.log("::warning::override flag present — not failing.");
    process.exit(0);
  } else {
    appendGhSummary(
      `${mdHeader}❌ ${violations.length} violation(s).\n\n${lines.join("\n")}\n`
    );
    for (const v of violations) {
      console.log(
        `::error file=${v.file}::Frozen-path violation — ${v.rule}`
      );
    }
    process.exit(1);
  }
}
