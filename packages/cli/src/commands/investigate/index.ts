/**
 * `slowcook investigate` — bug-flow analogue of refine.
 *
 * Reads a GitHub issue (label: `bug`), uses code tools to find the
 * failure locus, emits `.brewing/bug-profiles/B-<id>.yaml` and opens
 * a PR proposing the profile. The PR's merge triggers
 * `slowcook-recipe-regression.yml` (alpha.3) which kicks off
 * `recipe --regression` to write the failing test.
 *
 * **Status**: alpha.2a — scaffold only. Parses args, prints what it
 * WOULD do. Real LLM agent + PR opening land in alpha.2b. Calling the
 * command today exits with a clear "not yet implemented" notice so
 * accidental wiring (e.g., a workflow trigger) fails fast and visibly.
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  validateBugProfile,
  type BugProfile,
  BUG_PROFILE_SCHEMA_VERSION,
} from "./schema.js";

interface InvestigateArgs {
  issueNumber: number;
  repoRoot: string;
  /** Dry-run: print the would-be profile to stdout, don't write files / open PR. */
  dryRun: boolean;
}

function parseArgs(argv: string[]): InvestigateArgs {
  const args: InvestigateArgs = {
    issueNumber: 0,
    repoRoot: process.cwd(),
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if ((arg === "--issue" || arg === "-i") && next) {
      args.issueNumber = parseInt(next, 10);
      i++;
    } else if (arg === "--cwd" && next) {
      args.repoRoot = next;
      i++;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook investigate — diagnose a bug from a GitHub issue and emit a bug-profile.

Usage:
  slowcook investigate --issue <number> [--cwd <path>] [--dry-run]

Status: alpha.2a — scaffold only. Real agent integration in alpha.2b.

What it WILL do (alpha.2b):
  1. Fetch issue #<number> body + prior comments via gh
  2. Run an LLM agent loop with read-only code tools
  3. Emit a bug-profile.yaml (schema_version ${BUG_PROFILE_SCHEMA_VERSION})
  4. Open a PR with the profile under .brewing/bug-profiles/B-<n>.yaml

Today (alpha.2a):
  Prints "not yet implemented" + a stub bug-profile shape + exits 64.
  This intentional non-implementation prevents accidental workflow
  wiring from running an empty agent in production.
`);
}

/**
 * Pick the next free bug-id by walking `.brewing/bug-profiles/`
 * (and once branches exist, also \`slowcook/bug-profile/B-*\`). Same
 * race-aware pattern as story-id assignment (slowcook#8 fix).
 *
 * Exposed for use by alpha.2b once the agent emits real profiles.
 */
export function pickNextBugId(repoRoot: string): string {
  const dir = join(repoRoot, ".brewing/bug-profiles");
  let max = 0;
  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)) {
      const m = entry.match(/^B-(\d+)\.ya?ml$/);
      if (m) {
        const n = parseInt(m[1] ?? "0", 10);
        if (n > max) max = n;
      }
    }
  }
  return `B-${max + 1}`;
}

/**
 * Build a stub bug profile from issue metadata only — no code reading.
 * alpha.2a placeholder. alpha.2b replaces this with an LLM-driven
 * agent that actually investigates.
 */
export function buildStubProfile(args: {
  issueNumber: number;
  issueTitle: string;
  bugId: string;
  cliVersion: string;
  now: Date;
}): BugProfile {
  return {
    schema_version: BUG_PROFILE_SCHEMA_VERSION,
    bug_id: args.bugId,
    title: args.issueTitle,
    source_issue: `#${args.issueNumber}`,
    status: "investigated",
    investigated_by: `slowcook-investigate@${args.cliVersion}-stub`,
    created_at: args.now.toISOString(),
    symptom: ["(not yet investigated — alpha.2a stub)"],
    expected: ["(not yet investigated — alpha.2a stub)"],
    reproduction: ["(not yet investigated — alpha.2a stub)"],
    failure_locus: {
      file: "(unknown)",
      diagnosis: "Stub profile emitted by alpha.2a scaffold. Real investigation lands in alpha.2b.",
    },
    regression_assertion: ["(not yet investigated — alpha.2a stub)"],
    fix_scope: [],
  };
}

export async function investigate(
  argv: string[],
  cliVersion: string
): Promise<void> {
  const args = parseArgs(argv);
  if (!args.issueNumber || isNaN(args.issueNumber)) {
    console.error("slowcook investigate: --issue <number> is required");
    printHelp();
    process.exit(64);
  }

  console.error(
    `slowcook investigate (${cliVersion}) — alpha.2a scaffold. Real agent integration in alpha.2b.`
  );

  // Build a stub profile so downstream consumers can exercise the
  // schema + file-system layout while the agent is still being built.
  const bugId = pickNextBugId(args.repoRoot);
  const profile = buildStubProfile({
    issueNumber: args.issueNumber,
    issueTitle: `(issue #${args.issueNumber})`,
    bugId,
    cliVersion,
    now: new Date(),
  });

  const validation = validateBugProfile(profile);
  if (!validation.ok) {
    console.error(`slowcook investigate: stub profile failed self-validation:`);
    for (const e of validation.errors) console.error(`  - ${e}`);
    process.exit(70);
  }

  if (args.dryRun) {
    console.log(JSON.stringify(profile, null, 2));
    console.error("\n(dry-run: not writing files, not opening PR)");
    process.exit(0);
  }

  // alpha.2a: write the stub to disk so the next-id picker advances
  // and consumers can see the file layout. Real PR opening lands in
  // alpha.2b alongside the LLM agent.
  const outDir = join(args.repoRoot, ".brewing/bug-profiles");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${bugId}.yaml`);
  writeFileSync(outPath, renderProfileAsYaml(profile), "utf8");
  console.error(`Wrote ${outPath} (alpha.2a stub).`);
  console.error("Real agent + PR opening: alpha.2b.");
}

/**
 * Render a BugProfile as YAML. Hand-rolled because we don't want to
 * pull a YAML lib dep just for emission. The schema is small enough
 * that this is fine.
 */
export function renderProfileAsYaml(profile: BugProfile): string {
  const lines: string[] = [];
  lines.push(`$schema: ./bug-profile.schema.json`);
  lines.push(`schema_version: ${profile.schema_version}`);
  lines.push(`bug_id: ${profile.bug_id}`);
  lines.push(`title: ${yamlString(profile.title)}`);
  lines.push(`source_issue: "${profile.source_issue}"`);
  lines.push(`status: ${profile.status}`);
  lines.push(`investigated_by: ${profile.investigated_by}`);
  lines.push(`created_at: ${profile.created_at}`);
  lines.push("");
  lines.push("symptom:");
  for (const s of profile.symptom) lines.push(`  - ${yamlString(s)}`);
  lines.push("expected:");
  for (const s of profile.expected) lines.push(`  - ${yamlString(s)}`);
  lines.push("reproduction:");
  for (const s of profile.reproduction) lines.push(`  - ${yamlString(s)}`);
  lines.push("failure_locus:");
  lines.push(`  file: ${yamlString(profile.failure_locus.file)}`);
  if (profile.failure_locus.line !== undefined) {
    lines.push(`  line: ${profile.failure_locus.line}`);
  }
  if (profile.failure_locus.function !== undefined) {
    lines.push(`  function: ${yamlString(profile.failure_locus.function)}`);
  }
  lines.push(`  diagnosis: ${yamlMultiline(profile.failure_locus.diagnosis)}`);
  lines.push("regression_assertion:");
  for (const s of profile.regression_assertion) lines.push(`  - ${yamlString(s)}`);
  lines.push("fix_scope:");
  for (const s of profile.fix_scope) lines.push(`  - ${yamlString(s)}`);
  if (profile.related_specs && profile.related_specs.length > 0) {
    lines.push("related_specs:");
    for (const r of profile.related_specs) {
      lines.push(`  - id: ${yamlString(r.id)}`);
      lines.push(`    relationship: ${r.relationship}`);
      if (r.note) lines.push(`    note: ${yamlString(r.note)}`);
    }
  }
  return lines.join("\n") + "\n";
}

function yamlString(s: string): string {
  // Always quote — keeps things simple. Escape backslashes + quotes.
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function yamlMultiline(s: string): string {
  if (!s.includes("\n")) return yamlString(s);
  return "|\n    " + s.split("\n").map((l) => l.trimEnd()).join("\n    ");
}
