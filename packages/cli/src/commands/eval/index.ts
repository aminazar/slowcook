/**
 * `slowcook eval` — 0.19.0-α.17 (closes #19, partial).
 *
 * No-regression gate for prompt-changing PRs. Loads frozen fixtures
 * from `packages/cli/eval/fixtures/<id>/fixture.json`, calls the
 * relevant `build*Prompt(args)` function from `@slowcook-ai/llm-anthropic`,
 * and asserts the resulting prompt string contains all of the
 * fixture's `expected_prompt_includes` substrings and none of its
 * `expected_prompt_excludes` substrings.
 *
 * Why prompt-shape assertions instead of running the LLM against the
 * fixture: the regression class #19 names ("subtle prompt drift that
 * drops critical context") is structural. Asserting on construction
 * shape catches it deterministically without burning Anthropic credit
 * or introducing nondeterminism into CI. A future fixture-class can
 * layer LLM-output assertions on top once we have a recorded-replay
 * shape; today this gate is the cheap, fast, contract-grade floor.
 *
 * Discovery model: walks `packages/cli/eval/fixtures/<id>/` directly
 * by listing subdirectories with a `fixture.json` inside. No central
 * registry — each fixture is self-describing.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildChefPrompt,
  buildChefOrchestratePrompt,
  buildInvestigateUserPrompt,
  buildNavigatorPrompt,
  buildPlateAmendmentPrompt,
  buildSiftTurnPrompt,
  buildVibeUserPrompt,
  REFINEMENT_ANALYST_SYSTEM,
} from "@slowcook-ai/llm-anthropic";

export interface Fixture {
  id: string;
  agent: string;
  description: string;
  captured_from?: { pr?: number; date?: string; context?: string };
  input: Record<string, unknown>;
  expected_prompt_includes: string[];
  expected_prompt_excludes?: string[];
}

export interface FixtureResult {
  id: string;
  agent: string;
  status: "pass" | "fail" | "error";
  missingIncludes: string[];
  unexpectedExcludes: string[];
  errorMessage?: string;
}

/**
 * Map from `fixture.agent` → prompt-builder function. Each builder is
 * the canonical entrypoint that consumer agents call at runtime — so
 * a prompt regression that drops context will show up here.
 *
 * Plate's builder returns Array<...> rather than string; we render its
 * concatenated text for the substring check.
 */
const BUILDERS: Record<string, (args: unknown) => string> = {
  chef: (args) => buildChefPrompt(args as Parameters<typeof buildChefPrompt>[0]),
  "chef-orchestrate": (args) =>
    buildChefOrchestratePrompt(args as Parameters<typeof buildChefOrchestratePrompt>[0]),
  investigate: (args) =>
    buildInvestigateUserPrompt(args as Parameters<typeof buildInvestigateUserPrompt>[0]),
  navigator: (args) =>
    buildNavigatorPrompt(args as Parameters<typeof buildNavigatorPrompt>[0]),
  plate: (args) => {
    const blocks = buildPlateAmendmentPrompt(
      args as Parameters<typeof buildPlateAmendmentPrompt>[0],
    );
    return blocks
      .map((b: unknown) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object" && "text" in b) return String((b as { text: unknown }).text);
        return JSON.stringify(b);
      })
      .join("\n\n");
  },
  sift: (args) => buildSiftTurnPrompt(args as Parameters<typeof buildSiftTurnPrompt>[0]),
  vibe: (args) => buildVibeUserPrompt(args as Parameters<typeof buildVibeUserPrompt>[0]),
  refine: (args) => {
    // REFINEMENT_ANALYST_SYSTEM is the system prompt — the surface
    // where the PM-facing question-shape + decide-first rules live.
    // Eval fixtures assert on the system prompt's contents.
    const a = args as { checklist?: string; projectContext?: string };
    return REFINEMENT_ANALYST_SYSTEM(a.checklist ?? "", a.projectContext ?? "");
  },
};

interface EvalArgs {
  fixtureId?: string;
  all: boolean;
  list: boolean;
  fixturesDir?: string;
}

function parseArgs(argv: string[]): EvalArgs {
  const args: EvalArgs = { all: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--fixture" && next) {
      args.fixtureId = next;
      i++;
    } else if (a === "--all") {
      args.all = true;
    } else if (a === "--list") {
      args.list = true;
    } else if (a === "--fixtures-dir" && next) {
      args.fixturesDir = next;
      i++;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook eval — prompt-regression gate

Loads frozen fixtures from packages/cli/eval/fixtures/<id>/fixture.json
and asserts the agent's prompt-builder output contains all expected
substrings (and none of the excluded ones).

Usage:
  slowcook eval --fixture <id>           Run one fixture by id.
  slowcook eval --all                    Run every discovered fixture.
  slowcook eval --list                   List fixture ids + descriptions.

Options:
  --fixtures-dir <path>  Override the default fixtures location
                         (mostly for tests / local experiments).

Exit code:
  0  all targeted fixtures passed
  1  at least one fixture failed or errored
  64 usage error
`);
}

/**
 * Resolve the default fixtures directory. Walks up from the CLI's
 * compiled location to find the `packages/cli/eval/fixtures/` tree.
 * In tests + local dev the caller passes `--fixtures-dir` directly.
 */
export function defaultFixturesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here is .../packages/cli/dist/commands/eval — climb out to packages/cli/.
  return join(here, "..", "..", "..", "eval", "fixtures");
}

export function listFixtureIds(fixturesDir: string): string[] {
  if (!existsSync(fixturesDir)) return [];
  return readdirSync(fixturesDir)
    .filter((name) => {
      const path = join(fixturesDir, name);
      if (!statSync(path).isDirectory()) return false;
      return existsSync(join(path, "fixture.json"));
    })
    .sort();
}

export function loadFixture(fixturesDir: string, id: string): Fixture {
  const path = join(fixturesDir, id, "fixture.json");
  if (!existsSync(path)) {
    throw new Error(`Fixture not found: ${id} (expected ${path})`);
  }
  const raw = readFileSync(path, "utf8");
  let parsed: Fixture;
  try {
    parsed = JSON.parse(raw) as Fixture;
  } catch (e) {
    throw new Error(`Fixture ${id} is not valid JSON: ${(e as Error).message}`);
  }
  validateFixture(parsed, id);
  return parsed;
}

function validateFixture(f: Fixture, idHint: string): void {
  if (!f.id) throw new Error(`Fixture ${idHint}: missing 'id'`);
  if (!f.agent) throw new Error(`Fixture ${f.id}: missing 'agent'`);
  if (!(f.agent in BUILDERS)) {
    throw new Error(
      `Fixture ${f.id}: unknown agent '${f.agent}'. Known: ${Object.keys(BUILDERS).sort().join(", ")}`,
    );
  }
  if (!f.input || typeof f.input !== "object") {
    throw new Error(`Fixture ${f.id}: missing 'input' object`);
  }
  if (!Array.isArray(f.expected_prompt_includes)) {
    throw new Error(`Fixture ${f.id}: 'expected_prompt_includes' must be an array of strings`);
  }
  if (f.expected_prompt_includes.length === 0) {
    throw new Error(
      `Fixture ${f.id}: 'expected_prompt_includes' is empty — a fixture must assert at least one substring`,
    );
  }
  if (f.expected_prompt_excludes && !Array.isArray(f.expected_prompt_excludes)) {
    throw new Error(`Fixture ${f.id}: 'expected_prompt_excludes' must be an array of strings if present`);
  }
}

export function runFixture(f: Fixture): FixtureResult {
  const builder = BUILDERS[f.agent];
  if (!builder) {
    return {
      id: f.id,
      agent: f.agent,
      status: "error",
      missingIncludes: [],
      unexpectedExcludes: [],
      errorMessage: `No builder registered for agent '${f.agent}'`,
    };
  }
  let prompt: string;
  try {
    prompt = builder(f.input);
  } catch (e) {
    return {
      id: f.id,
      agent: f.agent,
      status: "error",
      missingIncludes: [],
      unexpectedExcludes: [],
      errorMessage: `Prompt builder threw: ${(e as Error).message}`,
    };
  }
  const missing = f.expected_prompt_includes.filter((s) => !prompt.includes(s));
  const unexpected = (f.expected_prompt_excludes ?? []).filter((s) => prompt.includes(s));
  return {
    id: f.id,
    agent: f.agent,
    status: missing.length === 0 && unexpected.length === 0 ? "pass" : "fail",
    missingIncludes: missing,
    unexpectedExcludes: unexpected,
  };
}

function reportResult(r: FixtureResult): void {
  const icon = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "!";
  console.log(`${icon} [${r.agent}] ${r.id}`);
  if (r.status === "fail") {
    if (r.missingIncludes.length > 0) {
      console.log("  Missing required substrings:");
      for (const s of r.missingIncludes) console.log(`    - ${JSON.stringify(s)}`);
    }
    if (r.unexpectedExcludes.length > 0) {
      console.log("  Found forbidden substrings:");
      for (const s of r.unexpectedExcludes) console.log(`    - ${JSON.stringify(s)}`);
    }
  } else if (r.status === "error") {
    console.log(`  ${r.errorMessage}`);
  }
}

export async function evalCmd(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const fixturesDir = args.fixturesDir ?? defaultFixturesDir();

  if (!args.all && !args.fixtureId && !args.list) {
    console.error("slowcook eval: one of --all / --fixture / --list is required");
    printHelp();
    process.exit(64);
  }

  const allIds = listFixtureIds(fixturesDir);
  if (allIds.length === 0) {
    console.error(`No fixtures found under ${fixturesDir}`);
    process.exit(1);
  }

  if (args.list) {
    console.log(`Fixtures in ${fixturesDir}:`);
    for (const id of allIds) {
      const f = loadFixture(fixturesDir, id);
      console.log(`  ${id}  [${f.agent}]  ${f.description}`);
    }
    return;
  }

  const targets = args.all ? allIds : [args.fixtureId!];

  const results: FixtureResult[] = [];
  for (const id of targets) {
    let f: Fixture;
    try {
      f = loadFixture(fixturesDir, id);
    } catch (e) {
      results.push({
        id,
        agent: "?",
        status: "error",
        missingIncludes: [],
        unexpectedExcludes: [],
        errorMessage: (e as Error).message,
      });
      continue;
    }
    results.push(runFixture(f));
  }

  for (const r of results) reportResult(r);

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const errored = results.filter((r) => r.status === "error").length;
  console.log("");
  console.log(`Eval summary: ${passed} passed, ${failed} failed, ${errored} errored.`);

  if (failed > 0 || errored > 0) process.exit(1);
}
