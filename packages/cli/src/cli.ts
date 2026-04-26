#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { guard } from "./commands/guard.js";
import { manifest } from "./commands/manifest.js";
import { init } from "./commands/init/index.js";
import { refine } from "./commands/refine/index.js";
import { onSpecMerged } from "./commands/on-spec-merged/index.js";
import { onTestsMerged } from "./commands/on-tests-merged/index.js";
import { onBrewMerged } from "./commands/on-brew-merged/index.js";
import { testgen } from "./commands/testgen/index.js";
import { investigate } from "./commands/investigate/index.js";
import { recipeRegression } from "./commands/recipe-regression/index.js";
import { sift } from "./commands/sift/index.js";
import { chef } from "./commands/chef/index.js";
import { catchup } from "./commands/catchup/index.js";
import { brew } from "./commands/brew/index.js";
import { map } from "./commands/map/index.js";
import { extract } from "./commands/extract/index.js";
import { vibe } from "./commands/vibe/index.js";
import { dispatch } from "./commands/dispatch/index.js";
import { fixtures } from "./commands/fixtures/index.js";

// Read VERSION from package.json at runtime so the CLI's self-reported
// version, the spec's `refined_by` field, and the init template's workflow
// pin all stay in lockstep with the package version. Prevents the silent
// drift seen in 0.4.0–0.4.4 (cli.ts stayed at 0.4.0 while package.json
// bumped through 0.4.4).
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(__dirname, "..", "package.json");
const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0-unknown";
  } catch {
    return "0.0.0-unknown";
  }
})();

const USAGE = `
slowcook — TDD-first agentic development harness

Usage:
  slowcook init [--owner <handle>] [--force] [--dry-run] [--cwd <path>]
  slowcook guard --base <ref> --head <ref> [--override] [--config <path>]
  slowcook manifest record [--stack-config <path>] [--manifest <path>] [--story <id>]
  slowcook manifest verify [--stack-config <path>] [--manifest <path>] [--story <id>]
  slowcook refine --issue <number> [--cwd <path>] [--owner <login>] [--repo <name>]
  slowcook on-spec-merged --pr <number> [--cwd <path>]
  slowcook on-tests-merged --pr <number> [--cwd <path>]
  slowcook on-brew-merged --pr <number> [--cwd <path>]
  slowcook recipe [--spec <id>] [--all] [--cwd <path>]   (testgen — alias kept for 0.13.x)
  slowcook catchup [--dry-run] [--cwd <path>]
  slowcook brew --story <id> [--budget-usd <n>] [--max-iterations <n>] [--model <id>]
  slowcook map (generate|check) [--cwd <path>] [--out <path>] [--md <path>]
  slowcook extract [--schema] [--tokens] [--cwd <path>]
  slowcook vibe --spec <id> [--cwd <path>] [--owner <login>] [--repo <name>] [--dry-run]
  slowcook dispatch <step> [inputs...]
  slowcook fixtures check [--max-age-days <n>] [--story <id>]
  slowcook version
  slowcook help

Commands available in ${VERSION}:
  init               Scaffold slowcook configuration in a consumer project.
  guard              Check for frozen-path violations between two git refs.
  manifest           Record or verify the set of discoverable tests.
  refine             Drive a GitHub issue toward a frozen spec (refinement agent).
  on-spec-merged     Transition source-issue labels + post audit-trail comment after a spec PR merges.
  on-tests-merged    Post audit-trail comment after a tests PR merges.
  on-brew-merged     Post final "shipped" audit-trail comment after a brew PR merges.
  recipe             Generate Vitest tests from merged specs (a "recipe" — the test contract brew follows). Aliases: testgen.
  investigate        (alpha.2a, scaffold) Diagnose a bug from a GitHub issue and emit a bug-profile.
  sift               (alpha.4) Narrow red→green ratchet for a bug fix; bounded by bug-profile fix_scope.
  chef               (alpha.5c) Pipeline orchestrator — classify PR failure, dispatch retry / escalate.
  catchup            Detect + run pipeline steps that should have triggered but didn't.
  brew               Ratcheted implementation loop: flip red tests to green for one story.
  map                Generate / check the repo-wide code map (APIs, pages, components, helpers, types).
  extract            Brownfield extracts (schema.mmd, tokens.md) for refine/investigate context. Fast, no node_modules.
  vibe               (0.15-α.1) Design-first mockup generator. Reads spec + brownfield + code-map; emits runnable React mockup to slowcook/mockup/story-N PR.
  dispatch           Trigger a slowcook GitHub Actions workflow remotely (brew / testgen / refine).

Coming in later versions:
  review, dashboard

Docs: https://github.com/aminazar/slowcook
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "init":
      await init(args.slice(1), VERSION);
      return;
    case "guard":
      await guard(args.slice(1));
      return;
    case "manifest":
      await manifest(args.slice(1));
      return;
    case "refine":
      await refine(args.slice(1), VERSION);
      return;
    case "on-spec-merged":
      await onSpecMerged(args.slice(1));
      return;
    case "on-tests-merged":
      await onTestsMerged(args.slice(1));
      return;
    case "on-brew-merged":
      await onBrewMerged(args.slice(1));
      return;
    case "testgen":
    case "recipe":
      // 0.13.0-alpha.1 — `recipe` is the canonical name (kitchen
      // metaphor: refine, recipe, brew, sift, investigate, chef).
      // `testgen` keeps as a hidden alias for one minor version so
      // existing rewo workflow YAMLs (`slowcook testgen --spec …`)
      // don't break the moment 0.13.0 ships. Removed in 0.14.0.
      //
      // 0.13.0-alpha.3a — `--regression` mode: emit a regression
      // test from a bug-profile.yaml instead of an acceptance test
      // from a spec.yaml. Different input shape, different output
      // directory (tests/regression/), different agent path.
      if (args.slice(1).includes("--regression")) {
        await recipeRegression(args.slice(1), VERSION);
        return;
      }
      await testgen(args.slice(1), VERSION);
      return;
    case "investigate":
      // 0.13.0-alpha.2a — bug-flow analogue of refine. Scaffold only;
      // real LLM agent in alpha.2b. See docs/plans/0.13-bug-flow-and-chef.md.
      await investigate(args.slice(1), VERSION);
      return;
    case "sift":
      // 0.13.0-alpha.4 — bug-flow analogue of brew. Narrow red→green
      // ratchet bounded by the bug-profile's fix_scope. Default budget
      // $0.50 / 3 iterations; Sonnet model.
      await sift(args.slice(1), VERSION);
      return;
    case "chef":
      // 0.13.0-alpha.5c — pipeline orchestrator. Watches a single
      // slowcook-bot PR, classifies its failure mode, and acts (rebase
      // / dispatch retry / external-comment / escalate).
      await chef(args.slice(1), VERSION);
      return;
    case "catchup":
      await catchup(args.slice(1), VERSION);
      return;
    case "brew":
      await brew(args.slice(1), VERSION);
      return;
    case "map":
      await map(args.slice(1), VERSION);
      return;
    case "extract":
      // 0.13.5+ — focused brownfield extraction (schema + tokens). Designed
      // for refine / investigate workflows that want project-awareness
      // context without paying for `map generate`'s full ts-morph scan.
      await extract(args.slice(1), VERSION);
      return;
    case "vibe":
      // 0.15.0-α.1 — design-first mockup generator (plate-pipeline α.1).
      // Reads spec + brownfield extracts + code-map; emits a runnable
      // React mockup to slowcook/mockup/story-N branch + PR.
      await vibe(args.slice(1), VERSION);
      return;
    case "dispatch":
      await dispatch(args.slice(1));
      return;
    case "fixtures":
      await fixtures(args.slice(1));
      return;
    case "version":
    case "--version":
    case "-v":
      console.log(`slowcook ${VERSION}`);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    default:
      console.error(`Unknown command: ${command}\n${USAGE}`);
      process.exit(64); // EX_USAGE
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
