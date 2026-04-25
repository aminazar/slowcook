/**
 * `slowcook recipe --regression --bug B-<n>` — emits a regression
 * test from a bug-profile.
 *
 * **Status: alpha.3a**. Stub-only emitter: writes a deterministic
 * vitest skeleton at `tests/regression/B-<n>-<slug>.test.ts` that
 * asserts via `expect.fail()` so the test is red until sift replaces
 * the body with real assertions (alpha.4) or alpha.3b upgrades this
 * emitter to write real tests via an LLM agent.
 *
 * The skeleton structure is what sift expects to see:
 *  - one `describe` named for the bug id + title
 *  - one `it` per regression_assertion line
 *  - body of each `it` calls `expect.fail(...)` referencing the bug
 *    profile so the failure message points the operator at the right
 *    artefact when the test runs.
 *
 * Usage:
 *   slowcook recipe --regression --bug B-1 [--cwd <path>]
 *
 * Internally invoked from the CLI's `recipe`/`testgen` dispatch when
 * `--regression` is present (see cli.ts wiring).
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validateBugProfile, type BugProfile } from "../investigate/schema.js";
import { parseSimpleYaml } from "../investigate/agent.js";

export interface RecipeRegressionArgs {
  bugId: string; // "B-1"
  repoRoot: string;
  dryRun: boolean;
  /** alpha.3b: when true, route through the LLM emitter. Stub today. */
  useLlm: boolean;
}

export function parseRecipeRegressionArgs(argv: string[]): RecipeRegressionArgs {
  const args: RecipeRegressionArgs = {
    bugId: "",
    repoRoot: process.cwd(),
    dryRun: false,
    useLlm: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--bug" && next) {
      args.bugId = normaliseBugId(next);
      i++;
    } else if (arg === "--cwd" && next) {
      args.repoRoot = next;
      i++;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--llm") {
      args.useLlm = true;
    }
  }
  return args;
}

/**
 * Accept "1", "B-1", or "B1" and normalise to "B-<n>".
 */
export function normaliseBugId(raw: string): string {
  const m = raw.trim().match(/^B?-?(\d+)$/i);
  if (!m || !m[1]) return raw;
  return `B-${m[1]}`;
}

export async function recipeRegression(
  argv: string[],
  cliVersion: string
): Promise<void> {
  const args = parseRecipeRegressionArgs(argv);
  if (!args.bugId) {
    console.error("slowcook recipe --regression: --bug <id> is required");
    process.exit(64);
  }
  if (args.useLlm) {
    console.error(
      "slowcook recipe --regression --llm: alpha.3b not yet shipped; falling back to stub emitter."
    );
  }

  const profile = loadBugProfile(args.repoRoot, args.bugId);
  const file = renderRegressionStub(profile, cliVersion);

  if (args.dryRun) {
    console.log(file.contents);
    console.error(`\n(dry-run: would write ${file.path})`);
    return;
  }

  const fullPath = join(args.repoRoot, file.path);
  mkdirSync(join(args.repoRoot, "tests/regression"), { recursive: true });
  writeFileSync(fullPath, file.contents, "utf8");
  console.error(
    `Wrote ${file.path} (alpha.3a stub — uses expect.fail; sift / alpha.3b will replace with real assertions).`
  );
}

export function loadBugProfile(repoRoot: string, bugId: string): BugProfile {
  const path = join(repoRoot, ".brewing/bug-profiles", `${bugId}.yaml`);
  if (!existsSync(path)) {
    throw new Error(
      `bug profile not found: ${path}. Run 'slowcook investigate --issue <n>' first.`
    );
  }
  const raw = parseSimpleYaml(readFileSync(path, "utf8"));
  const validation = validateBugProfile(raw);
  if (!validation.ok) {
    throw new Error(
      `bug profile at ${path} is invalid:\n  ${validation.errors.join("\n  ")}`
    );
  }
  return validation.profile;
}

export interface RegressionFile {
  path: string;
  contents: string;
}

/**
 * Build the stub regression test for a bug profile. Deterministic —
 * same profile → same file. Sift overwrites with real assertions in
 * alpha.4; alpha.3b will replace this stub emitter with an LLM-written
 * real test.
 */
export function renderRegressionStub(
  profile: BugProfile,
  cliVersion: string
): RegressionFile {
  const slug = slugify(profile.title);
  const path = `tests/regression/${profile.bug_id}-${slug}.test.ts`;

  const lines: string[] = [];
  lines.push(`// slowcook ${cliVersion} regression test — ${profile.bug_id}`);
  lines.push(`//`);
  lines.push(`// Bug profile: .brewing/bug-profiles/${profile.bug_id}.yaml`);
  lines.push(`// Source issue: ${profile.source_issue}`);
  lines.push(`// Failure locus: ${profile.failure_locus.file}${profile.failure_locus.line ? `:${profile.failure_locus.line}` : ""}`);
  lines.push(`//`);
  lines.push(`// alpha.3a stub: each \`it\` block calls expect.fail(...) so the`);
  lines.push(`// test is red against current code. Sift (alpha.4) replaces the`);
  lines.push(`// body with real assertions that exercise the regression. Once`);
  lines.push(`// alpha.3b ships an LLM-backed emitter, this comment header goes`);
  lines.push(`// away and the body is real from the start.`);
  lines.push(``);
  lines.push(`import { describe, it, expect } from "vitest";`);
  lines.push(``);
  lines.push(`describe(${jsonString(`${profile.bug_id} regression — ${profile.title}`)}, () => {`);
  for (let i = 0; i < profile.regression_assertion.length; i++) {
    const assertion = profile.regression_assertion[i] ?? "";
    lines.push(`  it(${jsonString(assertion)}, () => {`);
    lines.push(`    // Diagnosis: ${oneLine(profile.failure_locus.diagnosis)}`);
    lines.push(`    // Expected: ${oneLine(profile.expected[0] ?? "(not specified)")}`);
    lines.push(`    // alpha.3a stub — sift / alpha.3b replaces this body.`);
    lines.push(`    expect.fail(${jsonString(`Regression test stub for ${profile.bug_id}. See .brewing/bug-profiles/${profile.bug_id}.yaml. Sift will replace this body once it lands.`)});`);
    lines.push(`  });`);
    if (i < profile.regression_assertion.length - 1) lines.push(``);
  }
  lines.push(`});`);
  lines.push(``);

  return { path, contents: lines.join("\n") };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function oneLine(s: string): string {
  return s.split("\n").join(" ").trim();
}

function jsonString(s: string): string {
  return JSON.stringify(s);
}
