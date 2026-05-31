import {
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { execSync } from "node:child_process";
import { buildPlan, InitError, type FileAction, type FileReader } from "./plan.js";
import { getTsUiDevDependencies } from "@slowcook-ai/stack-ts";
import { refreshKnowledgeAuto, refreshKnowledgeMineHistory } from "../refresh-knowledge.js";
import { upsertAgentDocsCore } from "../upsert-agent-docs.js";

interface InitArgs {
  cwd: string;
  owner: string | undefined;
  force: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): InitArgs {
  const args: InitArgs = {
    cwd: process.cwd(),
    owner: undefined,
    force: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--cwd" && next) {
      args.cwd = resolve(next);
      i++;
    } else if (arg === "--owner" && next) {
      args.owner = next;
      i++;
    } else if (arg === "--force") {
      args.force = true;
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
slowcook init — scaffold slowcook configuration in a consumer project

Usage:
  slowcook init [options]

Options:
  --cwd <path>       Target project directory (default: current directory)
  --owner <handle>   CODEOWNERS handle/team, e.g. "@aminazar" or "@acme/frontend".
                     If omitted, slowcook tries to detect from \`git remote get-url origin\`;
                     falls back to "@TODO-OWNER" with a warning.
  --force            Overwrite existing slowcook files (default: skip existing)
  --dry-run          Print the plan without writing anything to disk
  --help, -h         Show this help

Writes:
  .brewing/frozen-paths.json
  .brewing/stack.json
  .brewing/README.md
  .brewing/manifests/.gitkeep
  .github/workflows/slowcook.yml
  CODEOWNERS (appends slowcook section if file exists)

Exit codes:
  0  success (or dry-run completed)
  2  script error (no package.json, vitest not detected, etc.)
`);
}

function makeReader(cwd: string): FileReader {
  return {
    exists: (p: string) => existsSync(resolveIn(cwd, p)),
    read: (p: string) => readFileSync(resolveIn(cwd, p), "utf8"),
  };
}

function resolveIn(cwd: string, path: string): string {
  if (isAbsolute(path)) return path;
  return resolve(cwd, path);
}

function detectOwnerFromGitRemote(cwd: string): string | null {
  try {
    const url = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // https://github.com/USER/REPO.git  |  git@github.com:USER/REPO.git
    const m =
      url.match(/github\.com[:/]([^/]+)\/[^/.]+(?:\.git)?$/) ??
      url.match(/gitlab\.com[:/]([^/]+)\/[^/.]+(?:\.git)?$/);
    if (m && m[1]) return `@${m[1]}`;
  } catch {
    // not a git repo, or no origin — fine, fall through
  }
  return null;
}

function formatAction(a: FileAction): string {
  switch (a.kind) {
    case "create":
      return `  CREATE      ${a.path}`;
    case "overwrite":
      return `  OVERWRITE   ${a.path}`;
    case "append":
      return `  APPEND      ${a.path}  (preserving existing content)`;
    case "skip-exists":
      return `  SKIP        ${a.path}  (${a.reason})`;
    case "conflict":
      return `  CONFLICT    ${a.path}  (${a.reason})`;
  }
}

function applyAction(cwd: string, a: FileAction): void {
  if (a.kind === "skip-exists" || a.kind === "conflict") return;
  const full = resolveIn(cwd, a.path);
  mkdirSync(dirname(full), { recursive: true });
  const contents =
    a.kind === "create" || a.kind === "overwrite" || a.kind === "append"
      ? a.contents
      : "";
  writeFileSync(full, contents, "utf8");
  // Git hooks (under .githooks/) must be executable or git silently
  // ignores them. Same goes for shell scripts under scripts/ that
  // agents are expected to invoke directly (e.g., agent-preflight.sh
  // from the 0.19.x agent-bootstrap layer).
  if (a.path.startsWith(".githooks/") || a.path.endsWith(".sh")) {
    chmodSync(full, 0o755);
  }
}

export async function init(argv: string[], cliVersion: string): Promise<void> {
  // 0.16.0-α.1 — `slowcook init mock` subcommand. Scaffolds the
  // consumer-side shell of the mock app (per docs/plans/0.16-mock-app.md);
  // imports its runtime from @slowcook-ai/mock-runtime.
  if (argv[0] === "mock") {
    const { initMock } = await import("./mock.js");
    return initMock(argv.slice(1), cliVersion);
  }

  // 0.18.0 — `slowcook init from-prod` builds a perfect mock by
  // mirroring the consumer's prod src/ tree into mock/ with fixture-
  // backed data wiring. No LLM; deterministic strategy-A/B/C2/D
  // dispatch per file. See docs/plans/0.17-brownfield-pipeline.md
  // §0.18.0.
  if (argv[0] === "from-prod") {
    const { initFromProd } = await import("./from-prod.js");
    return initFromProd(argv.slice(1), cliVersion);
  }

  // 0.18.0-α.6 — `slowcook init entities` extracts the consumer's
  // domain ERD from supabase/migrations and emits TypeScript interfaces
  // + zod schemas under src/lib/entities/. First step of the entity-
  // first foundation: agents downstream import canonical types instead
  // of inventing their own variants per story.
  if (argv[0] === "entities") {
    const { initEntities } = await import("./entities.js");
    return initEntities(argv.slice(1), cliVersion);
  }

  const args = parseArgs(argv);
  const reader = makeReader(args.cwd);

  let owner = args.owner;
  if (!owner) {
    const detected = detectOwnerFromGitRemote(args.cwd);
    if (detected) {
      owner = detected;
      console.log(`Detected CODEOWNERS handle from git remote: ${owner}`);
    } else {
      owner = "@TODO-OWNER";
      console.log(
        "::warning::Could not detect a CODEOWNERS handle from git remote. Using @TODO-OWNER as a placeholder — replace it after init."
      );
    }
  }

  let plan;
  try {
    plan = buildPlan(reader, {
      cwd: args.cwd,
      owner,
      force: args.force,
      cliVersion,
    });
  } catch (e) {
    if (e instanceof InitError) {
      console.error(`slowcook init: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }

  console.log(`Detected stack:`);
  console.log(`  language: ${plan.detected.language}`);
  console.log(`  vitest: ${plan.detected.hasVitest}`);
  console.log(`  playwright: ${plan.detected.hasPlaywright}`);
  console.log();

  if (plan.warnings.length > 0) {
    console.log("Warnings:");
    for (const w of plan.warnings) console.log(`  - ${w}`);
    console.log();
  }

  console.log(`Planned file actions (cwd: ${relative(process.cwd(), args.cwd) || "."}):`);
  for (const a of plan.actions) console.log(formatAction(a));
  console.log();

  if (args.dryRun) {
    console.log("Dry-run complete — no files written.");
    return;
  }

  for (const a of plan.actions) applyAction(args.cwd, a);

  const skippedCount = plan.actions.filter((a) => a.kind === "skip-exists").length;
  console.log(
    `slowcook init: ${plan.actions.length - skippedCount} file(s) written, ${skippedCount} skipped.`
  );

  // α.64 — knowledge-layer bedrock. Three best-effort calls; failure of
  // any one logs a warning but doesn't fail the whole init. All three
  // run on first init AND on re-init so consumers always end up with
  // a populated bedrock + the managed AGENTS.md block + a sane gitignore
  // for the layer.
  console.log();
  console.log("Building repo-knowledge bedrock:");
  try {
    const auto = refreshKnowledgeAuto(args.cwd);
    console.log(`  auto/    ${auto.built.length} digest(s) built (${auto.built.join(", ") || "—"})`);
  } catch (e) {
    console.log(`  auto/    skipped (${(e as Error).message.slice(0, 100)})`);
  }
  try {
    const history = refreshKnowledgeMineHistory(args.cwd);
    console.log(`  curated/ ${history.built.length} file(s) mined from ${history.commitsProcessed} commits`);
  } catch (e) {
    console.log(`  curated/ skipped (${(e as Error).message.slice(0, 100)})`);
  }
  try {
    const docs = upsertAgentDocsCore(args.cwd);
    const docPaths = docs.filesUpserted.map((f) => `${f.path} (${f.action})`).join(", ");
    console.log(`  agents:  ${docPaths || "(none)"}`);
    console.log(`  README:  ${docs.readme}`);
    console.log(`  ignore:  ${docs.gitignore}`);
  } catch (e) {
    console.log(`  agent-docs skipped (${(e as Error).message.slice(0, 100)})`);
  }
  console.log();
  console.log("Next steps:");
  console.log(
    `  1. Activate the slowcook pre-commit hook (one time, per clone):`
  );
  console.log(
    `       git config core.hooksPath .githooks`
  );
  console.log(
    `     Keeps .brewing/code-map.* fresh on every src/ commit so PRs don't fail map-check.`
  );
  console.log(
    `  2. Review .brewing/frozen-paths.json — add/remove directories to match your repo.`
  );
  if (owner === "@TODO-OWNER") {
    console.log(`  3. Replace @TODO-OWNER in CODEOWNERS with your GitHub handle/team.`);
  }
  console.log(
    `  ${owner === "@TODO-OWNER" ? "4." : "3."} Run \`slowcook manifest record\` once your test set is stable.`
  );
  console.log(
    `  ${owner === "@TODO-OWNER" ? "4." : "3."} Commit and open a PR; slowcook CI will run on it.`
  );

  // UI tier-1 helpers: slowcook can't patch package.json or vitest.config.ts
  // directly (consumer-owned files that may have custom edits), so surface
  // the required devDeps and vitest env hint as post-run instructions.
  const uiDeps = getTsUiDevDependencies();
  const depList = Object.entries(uiDeps)
    .map(([name, version]) => `${name}@${version}`)
    .join(" ");
  console.log();
  console.log("UI testing (tier-1, 0.7.5+):");
  console.log(`  • devDependencies (add to package.json, then \`npm install\`):`);
  console.log(`      npm install -D ${depList}`);
  console.log(`  • vitest.config.ts — add .tsx to the test include pattern AND`);
  console.log(`    enable the automatic JSX runtime (testgen-emitted .tsx test`);
  console.log(`    files never \`import React\`; without automatic runtime they`);
  console.log(`    all error with \`ReferenceError: React is not defined\`):`);
  console.log(`      test: {`);
  console.log(`        include: [`);
  console.log(`          "src/**/*.test.ts",`);
  console.log(`          "tests/integration/**/*.test.ts",`);
  console.log(`          "tests/integration/**/*.test.tsx",   // ← add this`);
  console.log(`          "tests/**/*.test.ts",`);
  console.log(`        ],`);
  console.log(`        // … your existing setupFiles stay unchanged`);
  console.log(`      },`);
  console.log(`      esbuild: { jsx: "automatic" },   // ← add this`);
  console.log(`  • Each .tsx UI test file must start with a jsdom pragma on line 1:`);
  console.log(`      // @vitest-environment jsdom`);
  console.log(`    Vitest 4 removed \`environmentMatchGlobs\`; the per-file pragma is the`);
  console.log(`    only supported mechanism. Handler .test.ts files stay on the default node env.`);
  console.log(`  • Helpers at tests/helpers/{render.tsx,mocks/fetch.ts,a11y.ts} are scaffolded`);
  console.log(`    with a \`@slowcook-one-time-scaffold\` marker; safe to customise, but note that`);
  console.log(`    \`slowcook init --force\` will overwrite them. Delete the marker to flag the file`);
  console.log(`    as consumer-owned if/when a future-proof guard lands.`);

  console.log();
  console.log("Agent onboarding (0.19.x+):");
  console.log(`  • \`scripts/agent-preflight.sh\` is the script your agents should run at`);
  console.log(`    session start. It checks they have ssh/git/gh/jq installed + are`);
  console.log(`    authenticated. Exit 1 = fail; agent should ask you to fix rather than`);
  console.log(`    self-heal.`);
  console.log(`  • \`ops/agent-bootstrap.md\` is YOUR runbook for onboarding a new agent`);
  console.log(`    (per-agent SSH keys, gh PAT, known_hosts). Agents do NOT consult this`);
  console.log(`    file — they're not provisioning anything. AGENTS.md is the agent's`);
  console.log(`    operating manual.`);
  console.log(`  • Per-project preflight checks (SSH key on disk for a remote dev box,`);
  console.log(`    env vars, etc.) go in \`scripts/agent-preflight.local.sh\` —`);
  console.log(`    gitignored sibling sourced by the generic script. Add the path to`);
  console.log(`    \`.gitignore\` so per-machine state stays out of the repo.`);
}
