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
import { refreshKnowledge } from "./commands/refresh-knowledge.js";
import { upsertAgentDocs } from "./commands/upsert-agent-docs.js";
import { knowledgeAdd } from "./commands/knowledge-add.js";
import { stories } from "./commands/stories/index.js";
import { costLog } from "./commands/cost-log.js";
import { evalCmd } from "./commands/eval/index.js";
import { devEnv } from "./commands/dev-env/index.js";
import { serve } from "./commands/serve/index.js";
import { budget } from "./commands/budget/index.js";
import { brand } from "./commands/brand/index.js";
import { eye } from "./commands/eye/index.js";
import { gate } from "./commands/gate/index.js";
import { menu } from "./commands/menu/index.js";
import { trace } from "./commands/trace/index.js";
import { greenfield } from "./commands/greenfield/index.js";
import { renderHelp, renderCommandHelp, renderReadmeBlock } from "./help.js";

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

// Help text is rendered from `commands.manifest.ts` via `./help.ts`.
// The previous monolithic USAGE template drifted from the actual command
// surface (refresh-knowledge, upsert-agent-docs, knowledge, cost, etc.
// were callable but unlisted). The manifest fixes that — one entry per
// callable command, validated by a CI gate against this switch statement.

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
    case "refresh-knowledge":
      await refreshKnowledge(args.slice(1));
      return;
    case "upsert-agent-docs":
      await upsertAgentDocs(args.slice(1));
      return;
    case "knowledge": {
      // `slowcook knowledge add <agent> "<claim>" [...]`
      const sub = args[1];
      if (sub === "add") { await knowledgeAdd(args.slice(2)); return; }
      if (sub === "--help" || sub === "-h" || sub === "help") {
        console.log(renderCommandHelp("knowledge"));
        return;
      }
      console.error(`unknown knowledge subcommand: ${sub ?? "(none)"}. try \`slowcook knowledge add --help\``);
      process.exit(64);
    }
    case "stories": {
      // `slowcook stories status [...]` — 0.19.5-α (sc#146 #6)
      // Per-story pipeline-stage table. See packages/cli/src/commands/stories/.
      await stories(args.slice(1));
      return;
    }
    case "cost": {
      // `slowcook cost log --story <id> --usd <n> --agent <name> [...]`
      // 0.19.x+ — explicit logging primitive for non-Actions agents
      // (Claude Code sessions, Managed Agents, etc.) so their LLM spend
      // lands in the canonical cost sidecar alongside in-process agent
      // entries. See packages/cli/src/commands/cost-log.ts.
      const sub = args[1];
      if (sub === "log") { await costLog(args.slice(2)); return; }
      if (sub === "--help" || sub === "-h" || sub === "help") {
        console.log(renderCommandHelp("cost"));
        return;
      }
      console.error(`unknown cost subcommand: ${sub ?? "(none)"}. try \`slowcook cost log --help\``);
      process.exit(64);
    }
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
    case "menu":
      // GUCDI — decompose a PRD into a comprehensive, anchored, data-contracted
      // story set under specs/. The greenfield entry point.
      await menu(args.slice(1), VERSION);
      return;
    case "trace":
      // GUCDI — provenance-completeness lint over the spine (the keystone):
      // every node has a why ∈ {requirement|convention|craft}; orphans fail.
      await trace(args.slice(1), VERSION);
      return;
    case "greenfield":
      // GUCDI — scope-completeness dashboard: PRD → stories → brand → LCR →
      // trace, and the single next action.
      await greenfield(args.slice(1), VERSION);
      return;
    case "eye":
      // design #8 — render reference (mock) + candidate (brewed) URLs across
      // the viewport×scheme matrix, grade fidelity, screenshot, exit 1 on drift.
      await eye(args.slice(1), VERSION);
      return;
    case "gate":
      // design #9 — HITL halt: refuse to advance a stage until a human in the
      // required role has approved on the PR (agent-unforgeable).
      await gate(args.slice(1), VERSION);
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
      // print canonical shell-outs for now. Still callable for
      // backward compat; `slowcook serve dev <verb>` is the 0.20+
      // recommended path (design #5, Phase 1).
      await devEnv(args.slice(1));
      return;
    case "serve":
      // 0.20 design #5 Phase 1. `slowcook serve <profile> <verb>`.
      // Reads .brewing/serve.yaml or legacy .brewing/dev-env.yaml.
      // Profile `dev` implemented end-to-end; `mock` / `staging`
      // stubs print Phase 2/3 notices.
      await serve(args.slice(1));
      return;
    case "budget":
      // 0.19.0-α.35 (sc#66 follow-up) — manage .brewing/budget.yaml.
      // No args = show current config + month-to-date spend. `set
      // --monthly N` writes; `rm` deletes (disables the fuel gauge).
      await budget(args.slice(1));
      return;
    case "brand":
      // 0.19.0-α.40 (sc#82 Phase 4) — design-system foundation agent.
      // Runs once per consumer (or on --refresh) to populate
      // mock/src/design-system/{tokens.ts, css.ts} from a brand brief.
      // Vibe/plate/brew inherit these tokens; no more shadcn-default
      // drift when the consumer has a real brand.
      await brand(args.slice(1), VERSION);
      return;
    case "version":
    case "--version":
    case "-v":
      console.log(`slowcook ${VERSION}`);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h": {
      const rest = args.slice(1);
      // `slowcook help --markdown-readme` — emits the markdown catalog
      // for `scripts/sync-readme-help.sh` to splice into the README.
      if (rest[0] === "--markdown-readme") {
        process.stdout.write(renderReadmeBlock());
        return;
      }
      // `slowcook help <cmd>` — per-command usage.
      if (rest[0] && !rest[0].startsWith("-")) {
        const block = renderCommandHelp(rest[0]);
        if (block) {
          console.log(block);
          return;
        }
        console.error(`Unknown command: ${rest[0]}\n${renderHelp(VERSION)}`);
        process.exit(64);
      }
      console.log(renderHelp(VERSION));
      return;
    }
    default:
      console.error(`Unknown command: ${command}\n${renderHelp(VERSION)}`);
      process.exit(64); // EX_USAGE
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
