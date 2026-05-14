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
import { onMockupApproved } from "./commands/on-mockup-approved/index.js";
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
import { plate } from "./commands/plate/index.js";
import { port } from "./commands/port/index.js";
import { preview } from "./commands/preview/index.js";
import { check } from "./commands/check/index.js";
import { recon } from "./commands/recon/index.js";
import { runMock } from "./commands/run-mock/index.js";
import { dispatch } from "./commands/dispatch/index.js";
import { fixtures } from "./commands/fixtures/index.js";
import { evalCmd } from "./commands/eval/index.js";
import { devEnv } from "./commands/dev-env/index.js";

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
  slowcook plate --pr <number> [--cwd <path>] [--owner <login>] [--repo <name>] [--review-comment-id <id>]
  slowcook port --story <id> [--cwd <path>] [--dry-run] [--force]
  slowcook preview (deploy|teardown) --pr <number> [--ssh-key <path>] [--cwd <path>]
  slowcook check mock-isolation [--cwd <path>]
  slowcook run-mock <story-id> [--no-poll] [--poll-seconds <n>] [--branch <ref>]
  slowcook dispatch <step> [inputs...]
  slowcook fixtures check [--max-age-days <n>] [--story <id>]
  slowcook eval (--all | --fixture <id> | --list) [--fixtures-dir <path>]
  slowcook dev-env (push|switch|up|sync|reset) [--story <id>] [--branch <name>]
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
  chef               (alpha.5c) PR-CI failure classifier — dispatches retry / escalate based on check status.
  chef-drift         (0.18.0-α.9 L1) Surgical drift-fixer. Triggered by mock-isolation / recon / brew / navigator halts.
  chef-orchestrate   (0.19.0-α.2 L3) Pipeline orchestrator. Decides redispatch_brew / rebase / escalate / close on a halted PR.
  refactor           (0.19.0-α.7) Rank refactor proposals by benefit/cost. Reads .brewing/refactor/proposals.json.
  garnish            (0.19.0-α.15) Local commit-gate for human tweaks on agent work. Runs tests, commits with learning-signal trailers.
  catchup            Detect + run pipeline steps that should have triggered but didn't.
  brew               Ratcheted implementation loop: flip red tests to green for one story.
  map                Generate / check the repo-wide code map (APIs, pages, components, helpers, types).
  extract            Brownfield extracts (schema.mmd, tokens.md) for refine/investigate context. Fast, no node_modules.
  vibe               (0.15-α.1) Design-first mockup generator. Reads spec + brownfield + code-map; emits runnable React mockup to slowcook/mockup/story-N PR.
  plate              (0.15-α.3) Mockup amendment agent. Triggered by /plate PR comments on slowcook-mockup PRs; force-pushes amendments.
  port               (0.16-α.8) Deterministic mock/ → src/ copy. Walks mock/src/, applies useScenarioFixture → useDataDomain rewrite, prepends provenance header. Pre-brew CI step.
  preview            (0.16-α.5) SSH preview deploy. \`deploy --pr N\`: build + run the mock app on the consumer's box; post URL to PR. \`teardown --pr N\`: stop + remove.
  check              (0.16-α.13) Static structural checks. \`check mock-isolation\` verifies every import in mock/ stays inside mock/ (catches vibe-prompt slippage that breaks the mock-vs-prod separation rule).
  recon              (0.17.6+) Pre-brew structural divergence check. Compares story tests against mock + src/, surfaces missing components / testid gaps / brownfield rename hazards. Runs in slowcook-brew-auto.yml before brew dispatch.
  run-mock           (0.16-α.17) One-command mock launch + auto-pull. \`run-mock <story>\`: checkout mockup branch, npm install in mock/, run next dev with overlay env vars, poll origin every 15s + git pull --ff-only on plate amendments.
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
    case "on-mockup-approved":
      // 0.16.0-α.23 — fires from the slowcook-mockup-approved.yml
      // workflow on label-add. Posts a cost-rollup audit comment on
      // the source issue (looked up via spec.source_issue).
      await onMockupApproved(args.slice(1));
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
      // 0.18.0-α.8 prototype — `brew --pair-sim` invokes the local
      // pair-brew simulator (driver + navigator) instead of the
      // production brew loop. Local-only; needs ANTHROPIC_API_KEY.
      if (args.slice(1).includes("--pair-sim")) {
        const { pairSim } = await import("./commands/brew/pair-sim.js");
        await pairSim(args.slice(1).filter((a) => a !== "--pair-sim"), VERSION);
        return;
      }
      await brew(args.slice(1), VERSION);
      return;
    case "chef-drift":
      // 0.18.0-α.9 L1 — chef as drift-fixer / micromanager finisher.
      // Consumes a failure trigger (mock-isolation, recon escalation,
      // brew halt class, navigator halt class) + emits surgical edits
      // or PM escalations across the in-flight artifacts. Frozen
      // surface: never edits tests/, vitest.config.*, .brewing/auto-gen/.
      // Sibling to existing `slowcook chef --pr` (PR-CI-failure handler).
      {
        const { chefDrift } = await import("./commands/chef/drift-fix.js");
        await chefDrift(args.slice(1), VERSION);
        return;
      }
    case "chef-orchestrate":
      // 0.19.0-α.2 L3 — chef as pipeline orchestrator. Reads the chef-
      // drift ledger + PR state + spec + open PRs and decides between
      // redispatch_brew / rebase / escalate / close. Sibling to chef-
      // drift; runs AFTER chef-drift halts. α.0 implements escalate +
      // close end-to-end; redispatch + rebase persist the verdict for
      // a follow-up workflow step to act on.
      {
        const { chefOrchestrate } = await import("./commands/chef/orchestrate.js");
        await chefOrchestrate(args.slice(1), VERSION);
        return;
      }
    case "map":
      await map(args.slice(1), VERSION);
      return;
    case "extract":
      // 0.13.5+ — focused brownfield extraction (schema + tokens). Designed
      // for refine / investigate workflows that want project-awareness
      // context without paying for `map generate`'s full ts-morph scan.
      await extract(args.slice(1), VERSION);
      return;
    case "refactor":
      // 0.19.0-α.7 — refactor command (#64). Reads candidate refactor
      // proposals from .brewing/refactor/proposals.json, filters by
      // --scope patterns, ranks by benefit/cost. α.7 ships
      // ranking + reporting only; LLM-backed proposal generation +
      // auto-application land in later alphas.
      {
        const { refactor } = await import("./commands/refactor/index.js");
        await refactor(args.slice(1), VERSION);
        return;
      }
    case "docs":
      // 0.19.0-α.13 — `slowcook docs <topic>` prints bundled docs.
      // Useful when an agent / maintainer is on a fresh box without a
      // cloned slowcook repo. Topics: reporting, agents, read-only.
      {
        const { docs } = await import("./commands/docs/index.js");
        await docs(args.slice(1), VERSION);
        return;
      }
    case "garnish":
      // 0.19.0-α.15 — local commit-gate for human (or other-agent)
      // tweaks layered on top of an agent's work. Detects uncommitted
      // changes, runs scoped tests, commits with Tweaks-output-of:
      // trailers marking each agent-authored file the tweak touched.
      // A future `slowcook reflect` mines these trailers for learning
      // signal (eval-set fixtures, prompt-amendment candidates).
      {
        const { garnish } = await import("./commands/garnish/index.js");
        await garnish(args.slice(1), VERSION);
        return;
      }
    case "vibe":
      // 0.15.0-α.1 — design-first mockup generator (plate-pipeline α.1).
      // Reads spec + brownfield extracts + code-map; emits a runnable
      // React mockup to slowcook/mockup/story-N branch + PR.
      await vibe(args.slice(1), VERSION);
      return;
    case "plate":
      // 0.15.0-α.3 — mockup amendment agent. Triggered by `/plate`
      // PR comments on a slowcook-mockup PR; reads PM feedback +
      // amends mockup files; force-pushes the same branch.
      await plate(args.slice(1), VERSION);
      return;
    case "port":
      // 0.16.0-α.8 — deterministic copy of mock/src/* → src/*.
      // No LLM; same input → same output; auditable diff. Runs as a
      // CI step before brew so brew's allowed-paths can shrink.
      await port(args.slice(1), VERSION);
      return;
    case "preview":
      // 0.16.0-α.5 — SSH preview deploy. Reads .brewing/preview.yaml,
      // builds the consumer's mock app on their box, runs the docker
      // container, posts the URL to the PR. teardown undoes it.
      await preview(args.slice(1), VERSION);
      return;
    case "check":
      // 0.16.0-α.13 — static structural checks. mock-isolation
      // verifies vibe + plate keep mock/ self-contained.
      await check(args.slice(1), VERSION);
      return;
    case "recon":
      // 0.17.6 — pre-brew structural divergence check. Runs after
      // both mockup PR + tests PR are merged; catches residual
      // vibe ⇄ testgen divergence before brew burns tokens.
      await recon(args.slice(1), VERSION);
      return;
    case "run-mock":
      // 0.16.0-α.17 — one-command mock launch + auto-pull on plate
      // amendments. Wraps git fetch/checkout + npm install + next dev
      // + a 15s poll loop that pulls when origin moves.
      await runMock(args.slice(1), VERSION);
      return;
    case "dispatch":
      await dispatch(args.slice(1));
      return;
    case "fixtures":
      await fixtures(args.slice(1));
      return;
    case "eval":
      // 0.19.0-α.17 (closes #19 partially) — prompt-regression gate.
      // Loads frozen fixtures + replays each agent's prompt builder +
      // asserts substring contracts. CI workflow guards prompt-PRs
      // against silent context drops.
      await evalCmd(args.slice(1));
      return;
    case "dev-env":
      // 0.19.0-α.21 (dev-env Phase 2) — long-lived preview env on
      // a shared branch. push/switch implemented; up/sync/reset stub
      // print canonical shell-outs for now.
      await devEnv(args.slice(1));
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
