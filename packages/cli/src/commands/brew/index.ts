import { execSync } from "node:child_process";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { GitHubAdapter } from "@slowcook-ai/forge-github";
import {
  runBrew,
  readFrozenPaths,
  readStackConfig,
  loadSpec,
  type BrewContext,
} from "./agent.js";
import { haltReportToMarkdown } from "./halt.js";
import { requireApiKey, isClaudeCliBackend } from "../../lib/llm-runtime.js";
import { resolveModel, renderModelTable, assertModelPriced } from "../../lib/model-defaults.js";
import { isModelPriced } from "@slowcook-ai/llm-anthropic";

interface BrewArgs {
  storyId: string;
  repoRoot: string;
  owner?: string;
  repo?: string;
  budgetUsd: number;
  maxIterations: number;
  wallClockMs: number;
  model: string;
  baseBranch: string;
  /**
   * "auto" detects from spec + mockup-PR state. "plate" or "freehand"
   * force the mode.
   *
   * cli α.52 — renamed `legacy` → `freehand`. The old name signalled
   * "deprecated" on a tool that's only a few months old, which was
   * misleading: freehand is a first-class mode for stories that need
   * wide-scope edits (UI + data + migrations in one brew). The rename
   * has no back-compat alias — `--mode legacy` now errors with a
   * pointer to `--mode freehand`.
   */
  mode: "auto" | "plate" | "freehand";
  /**
   * 0.19.0-alpha.9 — pair-brew NavigatorHook injection.
   *
   * `undefined` = use the mode-aware default (true when resolved mode
   * is `freehand`, false when `plate`). The user can force either way
   * via `--with-navigator` / `--without-navigator`.
   *
   * cli α.52: freehand defaults navigator ON because wide-scope edits
   * across UI + data carry more drift risk; the navigator's job is to
   * catch shape-gaming + cross-story regressions before they checkpoint.
   * plate keeps it opt-in — plate's hardcoded allowed_paths is itself
   * a guardrail.
   */
  withNavigator: boolean | undefined;
  navigatorModel: string;
  /** dovizir §11 — consecutive no-edit iterations before halting. */
  stallIterations?: number;
  /** §13 — tool rounds per turn (default 12). */
  maxToolRounds?: number;
  /** #399 — failures on one target before a recovery context reset. */
  resetAfterFailures?: number;
  /** Multi-model: cheaper model for post-first-contact (emission) turns. */
  emitModel?: string;
  /** Dirty-tree guard override. */
  allowDirty?: boolean;
  /** Restore revert-on-no-progress (pre-0.30). */
  strictRevert?: boolean;
  /** R2 — run despite an unpriced model, accepting uncappable spend. */
  allowUnpriced?: boolean;
}

function parseArgs(argv: string[]): BrewArgs {
  const args: BrewArgs = {
    storyId: "",
    repoRoot: process.cwd(),
    budgetUsd: 10,
    maxIterations: 10,
    wallClockMs: 60 * 60 * 1000, // 1 hour
    model: resolveModel("brew"),
    baseBranch: "main",
    mode: "auto",
    withNavigator: undefined,
    navigatorModel: resolveModel("brew"),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--story" && next) { args.storyId = next; i++; }
    else if (arg === "--cwd" && next) { args.repoRoot = next; i++; }
    else if (arg === "--owner" && next) { args.owner = next; i++; }
    else if (arg === "--repo" && next) { args.repo = next; i++; }
    else if (arg === "--budget-usd" && next) { args.budgetUsd = parseFloat(next); i++; }
    else if (arg === "--max-iterations" && next) { args.maxIterations = parseInt(next, 10); i++; }
    else if (arg === "--wall-clock-minutes" && next) { args.wallClockMs = parseInt(next, 10) * 60 * 1000; i++; }
    else if (arg === "--model" && next) { args.model = next; i++; }
    else if (arg === "--base" && next) { args.baseBranch = next; i++; }
    else if (arg === "--mode" && next) {
      if (next === "legacy") {
        // cli α.52 — hard error, no silent alias. The old name was
        // misleading on a young tool. Point operators at the new name.
        console.error(
          `--mode legacy was renamed to --mode freehand in cli α.52. ` +
            `Re-dispatch with --mode freehand.`
        );
        process.exit(64);
      }
      if (next !== "auto" && next !== "plate" && next !== "freehand") {
        console.error(`--mode must be one of: auto, plate, freehand. Got: ${next}`);
        process.exit(64);
      }
      args.mode = next as "auto" | "plate" | "freehand";
      i++;
    }
    else if (arg === "--with-navigator") { args.withNavigator = true; }
    else if (arg === "--without-navigator") { args.withNavigator = false; }
    else if (arg === "--navigator-model" && next) { args.navigatorModel = next; i++; }
    else if (arg === "--allow-unpriced") { args.allowUnpriced = true; }
    else if (arg === "--stall-iterations" && next) { args.stallIterations = parseInt(next, 10); i++; }
    else if (arg === "--max-tool-rounds" && next) { args.maxToolRounds = parseInt(next, 10); i++; }
    else if (arg === "--reset-after-failures" && next) { args.resetAfterFailures = parseInt(next, 10); i++; }
    else if (arg === "--emit-model" && next) { args.emitModel = next; i++; }
    else if (arg === "--allow-dirty") { args.allowDirty = true; }
    else if (arg === "--strict-revert") { args.strictRevert = true; }
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (!args.storyId) {
    console.error("Missing required --story <id>");
    printHelp();
    process.exit(64);
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook brew — run the ratcheted implementation loop for one story

Reads the story's spec + test manifest, then iterates: agent proposes a
diff, slowcook runs tests, reverts regressions or no-progress turns,
commits only when a red test flips to green. Halts when budget or
iteration cap is hit, or when all story tests are green.

Usage:
  slowcook brew --story <id> [options]

Options:
  --story <id>               Story id to brew (required)
  --cwd <path>               Repo working directory (default: .)
  --owner <login>            Repo owner (default: from git remote)
  --repo <name>              Repo name (default: from git remote)
  --budget-usd <n>           Token-spend cap per story (default: 10)
  --max-iterations <n>       Iteration cap (default: 10)
  --wall-clock-minutes <n>   Wall-clock cap in minutes (default: 60)
  --model <id>               LLM model. Defaults to the brew stage model; SLOWCOOK_MODEL overrides every stage.
  --base <branch>            Base branch for PRs (default: main)
  --with-navigator           Force pair-brew on (overrides mode-aware default).
  --without-navigator        Force pair-brew off (overrides mode-aware default).
                             Default behavior (cli α.52): navigator ON when resolved mode is
                             freehand (wide-scope edits — drift risk justifies the navigator
                             cost), OFF when plate (plate's hardcoded allowed_paths is itself
                             a guardrail; navigator opt-in if needed).
                             Pair-brew: each iteration's would-be checkpoint passes through a
                             navigator review (design fidelity / responsive / cross-story risk
                             / etc.). On block, iter reverts + concerns fold into next iter's
                             prompt. Adds ~$0.01-0.05 per iter on top of driver spend.
  --navigator-model <id>     Navigator LLM model id. Defaults to the brew stage model.
  --emit-model <id>          Cheaper model for post-first-contact turns (the
                             mechanical emission that dominated cost). First
                             contact + post-reset turns use --model (plan).
  --allow-dirty              Skip the dirty-working-tree guard.
  --allow-unpriced           Run even though the model has no price. Spend is
                             recorded as unknown and USD budget caps cannot be
                             enforced. Off by default: an uncappable run is a
                             worse failure than a refused one.
  --max-tool-rounds <n>      Tool rounds per turn (default 12). Raise for large
                             specs where orientation alone needs more rounds; a
                             turn cut at this cap is reported as TRUNCATED and
                             never counted as an agent stall.
  --stall-iterations <n>     Consecutive no-edit iterations before halting.
                             Default: 2 when the agent makes no tool calls at
                             all, 5 when it is still reading (exploring a big
                             spec is work, not a stall).
  --help, -h                 Show this help

Environment:
  ANTHROPIC_API_KEY   (required)
  GITHUB_TOKEN        (required)

Exit codes:
  0   success (all story tests green, branch pushed)
  1   halted (budget, iterations, stagnation, wall-clock, etc.) — see halt report
  2   script error (missing env, bad args, etc.)
`);
}

/**
 * 0.15.0-α.4 — resolve brew's execution mode.
 *
 * `requested === "plate"` or `"freehand"` → return as-is.
 *
 * `requested === "auto"` → detect from spec + GitHub state:
 *   plate-mode requires BOTH (a) the spec has at least one populated
 *   `proposals.fixtures.by_domain.<domain>` entry (UI surface), AND (b)
 *   a slowcook-mockup PR for this story has been merged on the repo.
 *   If either condition is unmet → freehand.
 *
 * GitHub check uses `gh pr list` to look for closed PRs whose head
 * branch matches `slowcook/mockup/story-<id>`. Cheaper than fetching
 * a single PR by branch name (which 404s instead of returning empty).
 */
async function resolveBrewMode(args: {
  requested: "auto" | "plate" | "freehand";
  repoRoot: string;
  storyId: string;
  owner: string;
  repo: string;
  githubToken: string;
}): Promise<"plate" | "freehand"> {
  if (args.requested === "plate") return "plate";
  if (args.requested === "freehand") return "freehand";

  // auto path
  const specPath = join(args.repoRoot, "specs", `story-${args.storyId}.yaml`);
  let specYaml = "";
  try {
    specYaml = require("node:fs").readFileSync(specPath, "utf8") as string;
  } catch {
    return "freehand";
  }
  // Same hasUiSurface heuristic as the vibe command.
  const proposalsIdx = specYaml.search(/^proposals\s*:\s*$/m);
  if (proposalsIdx < 0) return "freehand";
  const tail = specYaml.slice(proposalsIdx);
  const fixturesMatch = tail.match(/^(\s+)fixtures\s*:\s*$/m);
  if (!fixturesMatch) return "freehand";
  const fixturesBlockStart =
    tail.indexOf(fixturesMatch[0]) + fixturesMatch[0].length;
  const byDomainMatch = tail
    .slice(fixturesBlockStart)
    .match(/^(\s+)by_domain\s*:\s*$/m);
  if (!byDomainMatch) return "freehand";
  const byDomainIndentLen = byDomainMatch[1]!.length;
  const after = tail.slice(
    fixturesBlockStart +
      tail.slice(fixturesBlockStart).indexOf(byDomainMatch[0]) +
      byDomainMatch[0].length
  );
  const entryRe = new RegExp(
    `^( {${byDomainIndentLen + 1},}|\\t+)([a-z][a-z0-9_-]*)\\s*:\\s*$`,
    "m"
  );
  if (!entryRe.test(after)) return "freehand";

  // Check for a merged slowcook-mockup PR.
  try {
    const branch = `slowcook/mockup/story-${args.storyId}`;
    const out = execSync(
      `gh pr list --state merged --head ${JSON.stringify(branch)} --json number --limit 1`,
      {
        cwd: args.repoRoot,
        encoding: "utf8",
        env: { ...process.env, GH_TOKEN: args.githubToken },
        stdio: ["ignore", "pipe", "ignore"],
      }
    ).trim();
    const arr = JSON.parse(out) as Array<{ number: number }>;
    if (arr.length === 0) {
      console.log(
        `(brew auto-detect: spec has fixtures but no merged slowcook-mockup PR for story-${args.storyId} found → freehand mode)`
      );
      return "freehand";
    }
    return "plate";
  } catch (e) {
    console.warn(
      `(brew auto-detect: gh pr list failed — ${(e as Error).message}; defaulting to freehand)`
    );
    return "freehand";
  }
}

function detectOwnerRepo(cwd: string): { owner: string; repo: string } | null {
  try {
    const url = execSync("git remote get-url origin", {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (m && m[1] && m[2]) return { owner: m[1], repo: m[2] };
  } catch { /* not a git repo */ }
  return null;
}

export async function brew(argv: string[], cliVersion: string): Promise<void> {
  const args = parseArgs(argv);
  console.log(renderModelTable([
    { stage: "brew", flag: argv.includes("--model") ? args.model : undefined },
  ]));
  // R2 — refuse before the first token when the model cannot be priced.
  assertModelPriced("brew", args.model, isModelPriced, { allowUnpriced: args.allowUnpriced });
  if (args.emitModel) assertModelPriced("brew", args.emitModel, isModelPriced, { allowUnpriced: args.allowUnpriced });

  // Dirty-tree guard (r4a dogfood — both forms hit live): brew's ratchet
  // reverts to git baselines, so pre-existing uncommitted/untracked changes
  // get counted as the agent's diff and then DESTROYED by the first revert.
  if (!args.allowDirty) {
    try {
      const dirty = execSync("git status --porcelain", { cwd: args.repoRoot, encoding: "utf8" })
        .split("\n")
        // brew's own state (halt reports, run logs, patches) lives under
        // .brewing/ and must not trip the guard that protects USER work.
        .filter((l) => l.trim() && !/\.brewing\//.test(l))
        .join("\n").trim();
      if (dirty) {
        console.error(
          `slowcook brew: the working tree has uncommitted or untracked changes — brew's revert machinery would count them as the agent's diff and destroy them on the first revert:\n` +
          dirty.split("\n").slice(0, 8).map((l) => `  ${l}`).join("\n") + (dirty.split("\n").length > 8 ? "\n  …" : "") + "\n" +
          `  Commit or stash first, or pass --allow-dirty to accept the risk.`
        );
        process.exit(78);
      }
    } catch { /* not a git repo — the snapshot machinery has its own story */ }
  }

  // Fails with the REAL cause when SLOWCOOK_LLM=claude-cli is set: brew needs
  // API tool-use, which the CLI backend cannot serve (dovizir handover §1).
  // #393 — SLOWCOOK_LLM=claude-cli drives brew through the local CLI on
  // subscription auth (tools over MCP). Dollars are still recorded at list
  // price; budgets and the ledger behave identically.
  const useCliBackend = isClaudeCliBackend();
  const anthropicKey = useCliBackend ? "(cli-backend)" : requireApiKey("brew");
  const githubToken = process.env["GITHUB_TOKEN"];
  if (!githubToken) {
    console.error("GITHUB_TOKEN environment variable is not set.");
    process.exit(2);
  }

  let owner = args.owner;
  let repo = args.repo;
  if (!owner || !repo) {
    const detected = detectOwnerRepo(args.repoRoot);
    if (!detected) {
      console.error("Could not detect owner/repo from git remote. Pass --owner and --repo.");
      process.exit(2);
    }
    owner = owner ?? detected.owner;
    repo = repo ?? detected.repo;
  }

  const spec = loadSpec(args.repoRoot, args.storyId);
  const stackConfig = readStackConfig(args.repoRoot);
  const frozenPaths = readFrozenPaths(args.repoRoot);

  // 0.15.0-α.4 — mode resolution. `auto` checks: does the spec have
  // `proposals.fixtures.by_domain.*` populated AND has a slowcook-mockup
  // PR for this story merged? If both yes → plate. Otherwise → freehand.
  // Force-modes (plate / freehand) skip the check.
  const resolvedMode = await resolveBrewMode({
    requested: args.mode,
    repoRoot: args.repoRoot,
    storyId: args.storyId,
    owner,
    repo,
    githubToken,
  });
  console.log(`brew mode: ${resolvedMode}${args.mode === "auto" ? " (auto-detected)" : ""}`);

  // 0.15.0-α.4 — plate-mode pulls the latest mockup files onto main BEFORE
  // brew starts, so the agent reads them as ground truth. The
  // slowcook-mockup PR is expected to be MERGED before brew fires.
  // We don't re-fetch here; the caller workflow pulls origin/main.

  // Allowed paths. In plate-mode, restrict to data-layer + API + migrations
  // + tests. Frozen-paths guard then physically rejects any UI edit.
  // In freehand mode, fall through to today's "wide allowed_paths" behavior.
  const allowedPaths: string[] = resolvedMode === "plate"
    ? [
        "src/lib/data/**",   // brew rewrites .ts stub; .mock.ts protected by extension check
        "src/app/api/**",
        "supabase/migrations/**",
        "tests/**",
      ]
    : [];

  const forge = new GitHubAdapter({ owner, repo, token: githubToken });
  const anthropic = new Anthropic({ apiKey: anthropicKey });

  const startedAt = new Date();
  const runTag = startedAt.toISOString().replace(/[:.]/g, "-");
  const branchName = `slowcook/brew/story-${args.storyId}-${startedAt.getTime()}`;
  const haltDir = join(args.repoRoot, ".brewing/halts");
  // Rolling per-iteration log. Operator can `ssh runner; tail -f` this
  // during long brews to see progress without waiting for CI log flush.
  const runLogPath = join(
    args.repoRoot,
    ".brewing/runs",
    `story-${args.storyId}-${runTag}`,
    "iterations.log"
  );

  // Create branch before starting
  execSync(`git -C "${args.repoRoot}" checkout -b ${branchName}`, { stdio: "inherit" });

  console.log(`\nslowcook brew · story-${args.storyId} on ${owner}/${repo}`);
  console.log(`  budget: $${args.budgetUsd.toFixed(2)} · iterations: ${args.maxIterations} · model: ${args.model}`);
  console.log(`  branch: ${branchName}`);
  console.log(`  run log: ${runLogPath}\n`);

  // Pair-brew NavigatorHook injection.
  //
  // cli α.52 — mode-aware default: navigator ON when resolved mode is
  // `freehand`, OFF when `plate`. Wide-scope freehand edits carry more
  // drift risk; plate's hardcoded allowed_paths is itself a guardrail.
  // Explicit `--with-navigator` / `--without-navigator` overrides.
  const effectiveWithNavigator: boolean =
    args.withNavigator !== undefined
      ? args.withNavigator
      : resolvedMode === "freehand";
  let navigatorHook: BrewContext["navigatorHook"] = undefined;
  if (effectiveWithNavigator) {
    const { createPairNavigatorHook } = await import("./pair-navigator.js");
    const { PRICING_PER_M_TOKENS } = await import("@slowcook-ai/llm-anthropic");
    const navPricing = PRICING_PER_M_TOKENS[args.navigatorModel] ?? { input: 3, output: 15 };
    navigatorHook = createPairNavigatorHook({
      anthropic,
      model: args.navigatorModel,
      pricingPerMTokens: navPricing,
      // Lean loader: fills in only what's cheap to derive from the
      // brew context. Spec yaml + cross-story file list are pulled
      // from disk; mock files are scoped to the story dir; storyTestIds
      // come from the spec's tier-1 entries when available.
      loadPromptContext: async () => {
        const { readFileSync, existsSync, readdirSync, statSync } = await import("node:fs");
        const { join } = await import("node:path");
        const mockFiles: Array<{ path: string; content: string }> = [];
        const mockDir = join(args.repoRoot, "mock/src/components");
        const walk = (dir: string): void => {
          if (!existsSync(dir)) return;
          for (const name of readdirSync(dir)) {
            const abs = join(dir, name);
            const st = statSync(abs);
            if (st.isDirectory()) walk(abs);
            else if (/\.tsx?$/.test(name)) {
              mockFiles.push({
                path: abs.replace(args.repoRoot + "/", ""),
                content: readFileSync(abs, "utf8").slice(0, 4000),
              });
            }
          }
        };
        walk(mockDir);
        const codeMapPath = join(args.repoRoot, ".brewing/code-map.md");
        const codeMapDigest = existsSync(codeMapPath)
          ? readFileSync(codeMapPath, "utf8").slice(0, 8000)
          : "";
        const specYamlPath = join(args.repoRoot, `specs/story-${args.storyId}.yaml`);
        const specYaml = existsSync(specYamlPath) ? readFileSync(specYamlPath, "utf8") : undefined;
        const apiContract = (spec as unknown as { api_contract?: Array<{ method: string; path: string; description?: string }> })
          .api_contract;
        // α.55 — give navigator a bounded list of source files that
        // exist right now so it can presence-check claims about absence
        // instead of hallucinating. Bounded to src/ + mock/src/ tsx/ts
        // files to keep the prompt reasonable.
        const knownSourceFiles: string[] = [];
        const collectKnown = (dir: string, rel: string): void => {
          if (!existsSync(dir)) return;
          for (const name of readdirSync(dir)) {
            const abs = join(dir, name);
            const r = rel ? `${rel}/${name}` : name;
            const st = statSync(abs);
            if (st.isDirectory()) {
              if (name === "node_modules" || name.startsWith(".")) continue;
              collectKnown(abs, r);
            } else if (/\.(tsx?|jsx?)$/.test(name)) {
              knownSourceFiles.push(r);
            }
          }
        };
        collectKnown(join(args.repoRoot, "src"), "src");
        collectKnown(join(args.repoRoot, "mock/src"), "mock/src");
        return {
          mockFiles,
          codeMapDigest,
          storyTestIds: [],
          apiContract,
          specYaml,
          knownSourceFiles,
        };
      },
    });
    const navReason =
      args.withNavigator === undefined
        ? `mode=${resolvedMode} default`
        : args.withNavigator === true
          ? "explicit --with-navigator"
          : "explicit --without-navigator (this branch shouldn't reach here)";
    console.log(`  navigator: enabled (${navReason}, model=${args.navigatorModel})`);
  }

  const ctx: BrewContext = {
    ...(args.stallIterations ? { stallIterations: args.stallIterations } : {}),
    ...(args.maxToolRounds ? { maxToolRounds: args.maxToolRounds } : {}),
    ...(args.resetAfterFailures ? { resetAfterFailures: args.resetAfterFailures } : {}),
    ...(args.emitModel ? { emitModel: args.emitModel } : {}),
    ...(useCliBackend ? { useCliBackend: true } : {}),
    ...(args.strictRevert ? { strictRevert: true } : {}),
    repoRoot: args.repoRoot,
    storyId: args.storyId,
    spec,
    stackConfig,
    forge,
    anthropic,
    model: args.model,
    budgetUsd: args.budgetUsd,
    maxIterations: args.maxIterations,
    wallClockMs: args.wallClockMs,
    now: () => new Date(),
    branchName,
    allowedPaths,
    frozenPaths,
    haltDir,
    runLogPath,
    cliVersion,
    mode: resolvedMode,
    navigatorHook,
  };

  try {
    const outcome = await runBrew(ctx);
    if (outcome.kind === "success") {
      console.log(
        `\n✓ All story tests green after ${outcome.iterations} iteration(s). ` +
        `${outcome.checkpoints} checkpoint(s), $${outcome.spendUsd.toFixed(2)} spent.`
      );
      console.log(`Branch pushed: ${branchName}`);
      process.exit(0);
    } else {
      console.log(`\n✗ Halted: ${outcome.report.halt_reason}`);
      console.log(haltReportToMarkdown(outcome.report));
      process.exit(1);
    }
  } catch (e) {
    console.error(`brew failed: ${(e as Error).message}`);
    if (process.env["SLOWCOOK_DEBUG"]) console.error(e);
    process.exit(2);
  }
}
