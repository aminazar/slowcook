/**
 * `packages/cli/src/commands.manifest.ts`
 *
 * Single source of truth for slowcook's user-facing command surface.
 * Drives BOTH `slowcook help` output AND the auto-generated command
 * catalog in `packages/cli/README.md`.
 *
 * Adding a command: append an entry below. Update both `slowcook help`
 * AND README sync at the same time via the CI gate in
 * `.github/workflows/readme-help-sync.yml`.
 *
 * Removing a command: don't. Mark `status: "deprecated"` + keep the
 * entry for one release with a deprecation warning, then remove.
 * Backward compat is a public commitment.
 */

export type CommandStatus = "stable" | "alpha" | "experimental" | "deprecated";

export type CommandGroup =
  | "pipeline"      // refine → testgen → vibe → plate → recipe → brew → chef
  | "plumbing"      // init, refresh-knowledge, upsert-agent-docs, etc.
  | "checks"        // guard, manifest, check, recon
  | "knowledge"     // knowledge, cost log, stories
  | "ops"           // dev-env, serve, preview, run-mock, dispatch
  | "experimental"; // investigate, sift, garnish, refactor, etc.

export interface CommandEntry {
  /** Top-level subcommand name (e.g. "refine", "brew", "stories"). */
  name: string;
  /** One-line usage signature shown in `slowcook help`. */
  usage: string;
  /** One-sentence description. Avoid version stamps + sc# refs (those rot). */
  description: string;
  /** Grouping for README catalog rendering. */
  group: CommandGroup;
  /** Stability marker. Defaults to "stable" if omitted. */
  status?: CommandStatus;
  /** Aliases honored by the cli's switch (e.g. "testgen" → "recipe"). */
  aliases?: string[];
  /** Hide from `slowcook help` + README (still callable). Used for `version`, `help`. */
  hidden?: boolean;
}

export const COMMANDS: ReadonlyArray<CommandEntry> = [
  // --- Pipeline ---
  {
    name: "menu",
    usage: "slowcook menu [--prd <path>] [--cwd <dir>] [--model <id>] [--dry-run]",
    description: "GUCDI greenfield entry: decompose a PRD into a comprehensive, anchored, data-contracted story set under specs/.",
    group: "pipeline",
  },
  {
    name: "greenfield",
    usage: "slowcook greenfield status [--prd <path>] [--cwd <dir>]",
    description: "GUCDI scope-completeness dashboard: where the project is in PRD → stories → brand → LCR → trace, and the single next action.",
    group: "pipeline",
  },
  {
    name: "refine",
    usage: "slowcook refine --issue <number> [--cwd <path>] [--owner <login>] [--repo <name>]",
    description: "Drive a GitHub issue through a clarifying-question loop until a frozen spec PR is emitted.",
    group: "pipeline",
  },
  {
    name: "recipe",
    usage: "slowcook recipe [--spec <id>] [--all] [--cwd <path>]",
    description: "Generate Vitest tests from merged specs — the test contract brew follows.",
    group: "pipeline",
    aliases: ["testgen"],
  },
  {
    name: "vibe",
    usage: "slowcook vibe (plan | schema [--stdout] | seed [--dry-run] [--model <id>] | --spec <id> [--owner <login>] [--repo <name>] [--dry-run]) [--cwd <path>]",
    description: "Design-first mockup generator. `vibe plan` (deterministic): compile all specs into the whole-app LCR plan (unified data model + conflicts, persona/route map, coverage) → .brewing/lcr-plan.json. `vibe schema` (deterministic): @story-annotated Drizzle schema from the data model. `vibe seed` (deterministic runtime + LLM): writes schema/ddl/db (a real in-browser sql.js SQLite) + LLM seed.ts (dense, state-covering data) + queries.ts (typed query adaptor / mock→prod swap seam). `vibe --spec <id>` (legacy per-story): emit a React mockup PR.",
    group: "pipeline",
  },
  {
    name: "plate",
    usage: "slowcook plate --pr <number> [--cwd <path>] [--owner <login>] [--repo <name>] [--review-comment-id <id>]",
    description: "Mockup amendment agent. Triggered by /plate PR comments on slowcook-mockup PRs; force-pushes amendments.",
    group: "pipeline",
  },
  {
    name: "brew",
    usage: "slowcook brew --story <id> [--budget-usd <n>] [--max-iterations <n>] [--model <id>]",
    description: "Ratcheted implementation loop: iterate src/ until all of one story's tests are green.",
    group: "pipeline",
  },
  {
    name: "chef",
    usage: "slowcook chef --pr <number> [--cwd <path>]",
    description: "PR-CI failure classifier — dispatches retry / escalate based on check status.",
    group: "pipeline",
  },
  {
    name: "chef-drift",
    usage: "slowcook chef-drift [--pr <number>] [--story <id>] [--cwd <path>]",
    description: "Surgical drift-fixer. Triggered by mock-isolation / recon / brew / navigator halts.",
    group: "pipeline",
  },
  {
    name: "chef-orchestrate",
    usage: "slowcook chef-orchestrate --pr <number> --story <id> [--cwd <path>]",
    description: "Pipeline orchestrator. Decides redispatch_brew / rebase / escalate / close on a halted PR.",
    group: "pipeline",
  },

  // --- Plumbing ---
  {
    name: "init",
    usage: "slowcook init [--owner <handle>] [--force] [--dry-run] [--cwd <path>]",
    description: "Scaffold .brewing/, .github/workflows/slowcook-*, and CODEOWNERS in a consumer project.",
    group: "plumbing",
  },
  {
    name: "refresh-knowledge",
    usage: "slowcook refresh-knowledge [--cwd <path>] [--auto-only] [--curated-only]",
    description: "Rebuild .brewing/repo-knowledge/{auto,curated}/ — code-shape digests + git-history mining.",
    group: "plumbing",
  },
  {
    name: "upsert-agent-docs",
    usage: "slowcook upsert-agent-docs [--cwd <path>] [--dry-run]",
    description: "Write the managed slowcook block in the consumer's AGENTS.md (or create one).",
    group: "plumbing",
  },
  {
    name: "knowledge",
    usage: "slowcook knowledge add <topic> \"<entry>\" [--evidence-pr <n>] [--evidence-file <path>]",
    description: "Add a curated entry to .brewing/repo-knowledge/curated/.",
    group: "knowledge",
  },
  {
    name: "cost",
    usage: "slowcook cost log --story <id> --usd <n> --agent <name> [--apply-to-spec]",
    description: "Stamp a cost marker on a story for non-Actions agents (Claude Code, Cursor, manual runs).",
    group: "knowledge",
  },
  {
    name: "stories",
    usage: "slowcook stories status [--cwd <path>] [--owner <login>] [--repo <name>] [--json]",
    description: "Per-story pipeline-stage table (refine / testgen / vibe / brew / chef) from specs/_index.yaml + GitHub state.",
    group: "knowledge",
    status: "alpha",
  },

  // --- Checks ---
  {
    name: "guard",
    usage: "slowcook guard --base <ref> --head <ref> [--override] [--config <path>]",
    description: "Check for frozen-path violations between two git refs. CI step.",
    group: "checks",
  },
  {
    name: "manifest",
    usage: "slowcook manifest (record|verify) [--stack-config <path>] [--manifest <path>] [--story <id>]",
    description: "Record or verify the set of discoverable tests so agents can't silently exclude them.",
    group: "checks",
  },
  {
    name: "check",
    usage: "slowcook check (mock-isolation|spec) [file...] [--cwd <path>]",
    description: "Static structural checks. `check spec` re-runs spec validators on PR amendments; `check mock-isolation` enforces the mock-vs-prod boundary.",
    group: "checks",
  },
  {
    name: "recon",
    usage: "slowcook recon [--story <id>] [--cwd <path>] [--reuse-scan] [--stub-scan] [--exclude <glob>]",
    description: "Pre-brew structural divergence check. Surfaces missing components / testid gaps / brownfield rename hazards.",
    group: "checks",
  },
  {
    name: "trace",
    usage: "slowcook trace <check|stamp|impact> [--prd <path>] [--cwd <dir>] [--coverage] [--strict] [--since <ref>] [--anchors a,b]",
    description: "GUCDI traceability lint over the spine. check: provenance (forward — every spec/LCR node has a why; orphans/dangling fail), coverage (inverse — stories with no LCR surface; --coverage to fail), persona surfaces (declared routes resolve), and freshness (specs whose PRD section changed since stamping; --strict to fail). stamp: baseline each spec's PRD-anchor fingerprint (prd_ref.sha). impact: which stories a PRD change touches (--since <ref> diffs the PRD; or --anchors a,b). Brownfield-safe (never demands a PRD).",
    group: "checks",
  },
  {
    name: "reconcile",
    usage: "slowcook reconcile --story <id> [--prd <path>] [--cwd <dir>] [--apply] [--dry-run] [--model <id>]",
    description: "PRD↔spec interdependency (LLM). When a PRD section a spec anchors to has changed (see `trace impact`/`trace check`), propose a minimum-diff corrected spec: enumerate which invariants/scenarios/actors/api now contradict the PRD, and report one-hop cross-impact as notes. Propose-not-apply by default (writes specs/story-<id>.reconcile.yaml); --apply accepts it (schema-validated) and re-stamps freshness.",
    group: "checks",
  },
  {
    name: "eye",
    usage: "slowcook eye --reference <url> --candidate <url> [--story <id>] [--out <dir>] [--viewport <m>] [--scheme <s>] [--max-violations <n>] [--fail-on <axes>] [--watch [--interval <ms>] [--until-converged] [--max-passes <n>]]",
    description: "Fidelity eye (design #8). Renders mock + brewed URLs across the viewport×scheme matrix, grades visual drift, screenshots, exits 1 on drift.",
    group: "checks",
  },
  {
    name: "gate",
    usage: "slowcook gate check --stage <refine|plate|brew> --pr <n> [--repo <owner/name>]",
    description: "HITL review halt (design #9). Refuses to advance a stage until a human in the required role has approved on the PR; bot/agent reviews never satisfy it.",
    group: "checks",
  },
  {
    name: "map",
    usage: "slowcook map (generate|check) [--cwd <path>] [--out <path>] [--md <path>]",
    description: "Generate / check the repo-wide code map (APIs, pages, components, helpers, types).",
    group: "checks",
  },

  // --- Ops ---
  {
    name: "serve",
    usage: "slowcook serve <profile> (up|sync|down|logs|reset) [--branch <name>] [--scenario <name>] [--service <name>] [--follow] [--prune]",
    description: "Multi-mode dev / mock / staging on a shared box. `dev` bind-mounts source; `mock` runs vite-dev (auto-skip if no scripts.dev); `staging` is built-image with named-scenario seed reset.",
    group: "ops",
    status: "alpha",
  },
  {
    name: "dev-env",
    usage: "slowcook dev-env (push|switch|up|sync|reset) [--story <id>] [--branch <name>]",
    description: "Legacy alias for `slowcook serve dev`. Bind-mount source push + per-story preview switch. Kept for backward compat.",
    group: "ops",
    status: "deprecated",
  },
  {
    name: "preview",
    usage: "slowcook preview (deploy|teardown) --pr <number> [--ssh-key <path>] [--cwd <path>]",
    description: "SSH preview deploy. `deploy --pr N`: build + run the mock app on the consumer's box; post URL to PR.",
    group: "ops",
  },
  {
    name: "run-mock",
    usage: "slowcook run-mock <story-id> [--no-poll] [--poll-seconds <n>] [--branch <ref>]",
    description: "One-command mock launch + auto-pull. Polls origin + git pull --ff-only on plate amendments.",
    group: "ops",
  },
  {
    name: "dispatch",
    usage: "slowcook dispatch <step> [inputs...]",
    description: "Trigger a slowcook GitHub Actions workflow remotely (brew / testgen / refine).",
    group: "ops",
  },
  {
    name: "port",
    usage: "slowcook port --story <id> [--cwd <path>] [--dry-run] [--force]",
    description: "Deterministic mock/ → src/ copy. Pre-brew CI step; applies the useScenarioFixture → useDataDomain rewrite.",
    group: "ops",
  },

  // --- Lifecycle hooks (workflow-driven, not usually invoked by humans) ---
  {
    name: "on-spec-merged",
    usage: "slowcook on-spec-merged --pr <number> [--cwd <path>]",
    description: "Transition source-issue labels + post audit-trail comment after a spec PR merges.",
    group: "plumbing",
  },
  {
    name: "on-tests-merged",
    usage: "slowcook on-tests-merged --pr <number> [--cwd <path>]",
    description: "Post audit-trail comment after a tests PR merges.",
    group: "plumbing",
  },
  {
    name: "on-brew-merged",
    usage: "slowcook on-brew-merged --pr <number> [--cwd <path>]",
    description: "Post final \"shipped\" audit-trail comment after a brew PR merges. Warns when merge target isn't main.",
    group: "plumbing",
  },
  {
    name: "on-mockup-approved",
    usage: "slowcook on-mockup-approved --pr <number> [--cwd <path>]",
    description: "Hook fired when a mockup PR gets the slowcook-mockup-approved label.",
    group: "plumbing",
  },

  // --- Bug flow ---
  {
    name: "investigate",
    usage: "slowcook investigate --issue <number> [--cwd <path>]",
    description: "Diagnose a bug from a GitHub issue and emit a bug-profile.",
    group: "experimental",
    status: "alpha",
  },
  {
    name: "sift",
    usage: "slowcook sift --bug-profile <path> [--cwd <path>]",
    description: "Narrow red→green ratchet for a bug fix; bounded by bug-profile fix_scope.",
    group: "experimental",
    status: "alpha",
  },

  // --- Misc + experimental ---
  {
    name: "extract",
    usage: "slowcook extract [--schema] [--tokens] [--cwd <path>]",
    description: "Brownfield extracts (schema.mmd, tokens.md) for refine/investigate context. Fast, no node_modules.",
    group: "knowledge",
  },
  {
    name: "catchup",
    usage: "slowcook catchup [--dry-run] [--cwd <path>]",
    description: "Detect + run pipeline steps that should have triggered but didn't.",
    group: "plumbing",
  },
  {
    name: "refactor",
    usage: "slowcook refactor [--scope <name>] [--cwd <path>]",
    description: "Rank refactor proposals from .brewing/refactor/proposals.json by benefit/cost.",
    group: "experimental",
  },
  {
    name: "garnish",
    usage: "slowcook garnish [--cwd <path>]",
    description: "Local commit-gate for human tweaks on agent work. Runs tests, commits with learning-signal trailers.",
    group: "experimental",
  },
  {
    name: "budget",
    usage: "slowcook budget [show|set|rm] [--monthly <usd>] [--start-day <1-31>] [--story <usd>] [--cwd <path>]",
    description: "Manage the project monthly budget for the fuel gauge.",
    group: "plumbing",
  },
  {
    name: "brand",
    usage: "slowcook brand [--brief <prose>] [--refresh] [--dry-run] [--model <id>] [--cwd <path>]  ·  slowcook brand logo --in <svg|png> [--out <dir>] [--map #hex=token,...]",
    description: "Design-system foundation agent. Emits mock/src/design-system/{tokens.ts, css.ts} from a brand brief. `brand logo` tokenizes a supplied SVG / deterministically traces a PNG (vtracer/potrace — no LLM path-authoring).",
    group: "pipeline",
  },
  {
    name: "fixtures",
    usage: "slowcook fixtures check [--max-age-days <n>] [--story <id>]",
    description: "Sanity-check the test-fixture set against the spec.",
    group: "checks",
  },
  {
    name: "eval",
    usage: "slowcook eval (--all | --fixture <id> | --list) [--fixtures-dir <path>]",
    description: "Run the agent eval suite against committed fixtures.",
    group: "checks",
  },
  {
    name: "docs",
    usage: "slowcook docs [--cwd <path>]",
    description: "Docs generation helper.",
    group: "plumbing",
  },

  // --- Hidden built-ins ---
  { name: "version", usage: "slowcook version", description: "Print the CLI version.", group: "plumbing", hidden: true },
  { name: "help",    usage: "slowcook help [<command>]", description: "Show this help (or per-command usage).", group: "plumbing", hidden: true },
];

const NAME_OR_ALIAS_INDEX: Map<string, CommandEntry> = (() => {
  const m = new Map<string, CommandEntry>();
  for (const cmd of COMMANDS) {
    m.set(cmd.name, cmd);
    for (const alias of cmd.aliases ?? []) m.set(alias, cmd);
  }
  return m;
})();

export function findCommand(nameOrAlias: string): CommandEntry | undefined {
  return NAME_OR_ALIAS_INDEX.get(nameOrAlias);
}

export function visibleCommands(): CommandEntry[] {
  return COMMANDS.filter((c) => !c.hidden);
}
