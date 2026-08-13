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
import { runRegressionRecipe } from "./agent.js";
import { resolveModel } from "../../lib/model-defaults.js";

export interface RecipeRegressionArgs {
  bugId: string; // "B-1"
  repoRoot: string;
  dryRun: boolean;
  /**
   * 0.13.0-alpha.3b: when true, route through the LLM-backed emitter
   * (real test, can be flipped green by sift). When false, fall back
   * to the deterministic alpha.3a stub (expect.fail body — only
   * useful for testing the file-system layout). Stub stays as the
   * default through 0.13.0 because LLM mode requires ANTHROPIC_API_KEY
   * + actually exercises the agent; CI / scripted runs that just
   * want a placeholder file don't want an LLM call.
   */
  useLlm: boolean;
  /** Anthropic model (LLM mode only). Default sonnet — single-shot
   *  regression test emission shouldn't need Opus. */
  model: string;
}

export function parseRecipeRegressionArgs(argv: string[]): RecipeRegressionArgs {
  const args: RecipeRegressionArgs = {
    bugId: "",
    repoRoot: process.cwd(),
    dryRun: false,
    useLlm: false,
    model: resolveModel("recipe"),
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
    } else if (arg === "--model" && next) {
      args.model = next;
      i++;
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

  const profile = loadBugProfile(args.repoRoot, args.bugId);
  const slug = slugFromTitle(profile.title);
  const relPath = `tests/regression/${profile.bug_id}-${slug}.test.ts`;

  let contents: string;
  if (args.useLlm) {
    const apiKey = process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) {
      console.error(
        "slowcook recipe --regression --llm: ANTHROPIC_API_KEY required (or omit --llm for the stub emitter)"
      );
      process.exit(78);
    }
    console.error(
      `slowcook recipe --regression (${cliVersion}) — LLM mode (model ${args.model}) for ${profile.bug_id}.`
    );
    const result = await runRegressionRecipe({
      repoRoot: args.repoRoot,
      anthropicApiKey: apiKey,
      model: args.model,
      bugProfile: profile,
      cliVersion,
    });
    console.error(
      `Agent done: ${result.rounds} round(s), $${result.spendUsd.toFixed(4)} spent.`
    );
    if (!result.emitted) {
      console.error(
        `slowcook recipe --regression: agent halted. ${result.haltReason ?? "(no reason)"}`
      );
      process.exit(1);
    }
    contents = result.testContents ?? "";
  } else {
    const file = renderRegressionStub(profile, cliVersion);
    contents = file.contents;
  }

  if (args.dryRun) {
    console.log(contents);
    console.error(`\n(dry-run: would write ${relPath})`);
    return;
  }

  const fullPath = join(args.repoRoot, relPath);
  mkdirSync(join(args.repoRoot, "tests/regression"), { recursive: true });
  writeFileSync(fullPath, contents, "utf8");
  console.error(
    `Wrote ${relPath}${args.useLlm ? " (LLM-emitted)" : " (alpha.3a stub — sift will replace expect.fail bodies)"}.`
  );
}

function slugFromTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
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
