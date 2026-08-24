/**
 * `slowcook vibe --spec <id>` — 0.15.0-α.1.
 *
 * Reads specs/story-<id>.yaml + brownfield extracts (.brewing/diagrams/)
 * + code-map summary, runs the vibe agent (single-shot LLM call),
 * writes the emitted mockup files to a `slowcook/mockup/story-<id>`
 * branch, opens a draft PR labeled `slowcook-mockup`.
 *
 * The PR is the PM-review surface: preview-deploy renders it, PM
 * comments / annotates / approves. Iteration is handled by the
 * `slowcook plate` command (α.3); vibe is single-shot.
 */

import { execSync } from "node:child_process";
import { createLlmClient } from "../refine/llm.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { GitHubAdapter } from "@slowcook-ai/forge-github";
import { runVibe, type VibeContext } from "./agent.js";
import { listActiveSpecs } from "../refine/spec-yaml.js";
import { compileLcrPlan, type PlanSpecInput, type LcrPlan } from "./lcr-plan.js";
import { compileDrizzleSchema, compileSqliteDdl, dbBootstrapTs } from "./schema-gen.js";
import { generateLcrApp, mockYaml } from "./app-gen.js";
import { loadMockShapeConfig } from "../../lib/mock-shape.js";
import { basename } from "node:path";
import { AnthropicClient, SEED_SYSTEM, ADAPTOR_SYSTEM, formatCostFooter } from "@slowcook-ai/llm-anthropic";
import { requireApiKey } from "../../lib/llm-runtime.js";
import { resolveModel } from "../../lib/model-defaults.js";

interface VibeArgs {
  specId: string;
  repoRoot: string;
  owner?: string;
  repo?: string;
  model: string;
  /** Skip git ops; just emit files locally. Useful for offline validation. */
  dryRun: boolean;
  baseBranch: string;
  asBuilt?: boolean;
  fromPath?: string;
  surface?: string;
}

function parseArgs(argv: string[]): VibeArgs {
  const args: VibeArgs = {
    specId: "",
    repoRoot: process.cwd(),
    model: resolveModel("vibe"),
    dryRun: false,
    baseBranch: "main",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--spec" && next) { args.specId = next; i++; }
    else if (a === "--as-built") { args.asBuilt = true; }
    else if (a === "--from" && next) { args.fromPath = next; i++; }
    else if (a === "--surface" && next) { args.surface = next; i++; }
    else if (a === "--cwd" && next) { args.repoRoot = next; i++; }
    else if (a === "--owner" && next) { args.owner = next; i++; }
    else if (a === "--repo" && next) { args.repo = next; i++; }
    else if (a === "--model" && next) { args.model = next; i++; }
    else if (a === "--base-branch" && next) { args.baseBranch = next; i++; }
    else if (a === "--dry-run") { args.dryRun = true; }
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  if (args.asBuilt) {
    if (!args.fromPath) {
      console.error("--as-built requires --from <production source path>.");
      process.exit(64);
    }
    return args;
  }
  if (!args.specId) {
    console.error("--spec <id> is required.");
    printHelp();
    process.exit(64);
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook vibe — design-first mockup generator (0.15 plate-pipeline α.1)

Reads a frozen spec YAML + brownfield extracts + code-map summary;
emits a runnable React mockup to a slowcook/mockup/story-<id> branch
and opens a draft PR. The mockup uses mock data via the data-layer
seam (src/lib/data/<domain>.{mock.ts,ts}); brew (--mode plate, later)
replaces the .ts stub with real fetches.

Usage:
  slowcook vibe --spec <id> [--cwd <path>] [--owner <login>] [--repo <name>]
                            [--model <id>] [--base-branch <name>] [--dry-run]

Options:
  --spec <id>         Story id (e.g. 017). REQUIRED.
  --cwd <path>        Repo root (default: cwd).
  --owner <login>     GitHub owner (default: detect from git remote).
  --repo <name>       GitHub repo (default: detect from git remote).
  --model <id>        Anthropic model (default: claude-opus-4-7).
  --base-branch <n>   Base branch for the PR (default: main).
  --dry-run           Skip git/PR ops; just emit files in-place.

Environment:
  Runs on SLOWCOOK_LLM=claude-cli (subscription) or ANTHROPIC_API_KEY.
  GITHUB_TOKEN        (required unless --dry-run) for opening the PR.
`);
}

/**
 * 0.16.0-α.4 — Lightweight check for spec UI-surface eligibility.
 * Looks for a non-empty top-level `ui_behavior:` block. The spec
 * convention since 0.11 has been: stories with UI carry `ui_behavior`
 * with at least one viewport entry (`desktop_light:`, `mobile_dark:`,
 * etc.); backend-only stories omit it entirely OR set it to an empty
 * mapping.
 *
 * Avoids pulling in a YAML parser for a regex sniff, but resilient to
 * indentation variations.
 *
 * Returns true when the spec's `ui_behavior:` block has at least one
 * indented child (any viewport entry). Returns false otherwise.
 */
function hasUiSurface(specYaml: string): boolean {
  const uiIdx = specYaml.search(/^ui_behavior\s*:\s*$/m);
  if (uiIdx < 0) {
    // Could be inline mapping `ui_behavior: { desktop: "..." }` — accept that too
    if (/^ui_behavior\s*:\s*\{[\s\S]*?[a-z]/m.test(specYaml)) return true;
    return false;
  }
  const tail = specYaml.slice(uiIdx).split("\n").slice(1); // lines after "ui_behavior:"
  for (const line of tail) {
    if (line.trim() === "") continue;
    // Stop at the next top-level key (zero indent + identifier + colon).
    if (/^[a-z_]/.test(line)) break;
    // Look for a child entry: indented + identifier + colon.
    if (/^\s+[a-z_][a-z0-9_]*\s*:/.test(line)) return true;
  }
  return false;
}

function detectOwnerRepo(cwd: string): { owner: string; repo: string } | null {
  try {
    const url = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (m && m[1] && m[2]) return { owner: m[1], repo: m[2] };
  } catch {
    /* not a git repo */
  }
  return null;
}

/**
 * Build the project-context blob fed to vibe's system prompt.
 *
 * Three sections, all optional:
 * 1. .brewing/diagrams/schema.mmd — brownfield ERD
 * 2. .brewing/diagrams/tokens.md — brownfield design tokens
 * 3. .brewing/code-map.md — components/pages/helpers inventory
 *
 * If a file is missing, the section is skipped silently. Vibe still
 * runs (with a "no project context" note) — but quality is much lower
 * without these. Workflow templates run `slowcook map generate
 * --emit-schema --emit-tokens` before vibe to ensure all three exist.
 */
function buildProjectContext(repoRoot: string): string {
  const sections: string[] = [];

  const schemaPath = join(repoRoot, ".brewing/diagrams/schema.mmd");
  if (existsSync(schemaPath)) {
    try {
      const c = readFileSync(schemaPath, "utf8").trim();
      sections.push(
        "## Existing schema (extracted from `supabase/migrations/*.sql`)\n\n```mermaid\n" +
          c +
          "\n```\n\nReuse entity names verbatim when adding new tables; foreign keys must reference these names exactly."
      );
    } catch {
      // ignore
    }
  }

  const tokensPath = join(repoRoot, ".brewing/diagrams/tokens.md");
  if (existsSync(tokensPath)) {
    try {
      const c = readFileSync(tokensPath, "utf8").trim();
      sections.push(
        "## Existing design tokens (extracted from `**/*.css`)\n\n" +
          c +
          "\n\nReuse these tokens by exact name (`bg-coral`, `var(--tint-celebrate)`); do NOT introduce new hex/rgb values." +
          "\nSTYLING CONTRACT: recurring patterns use the design system's classes (`.sc-*`/Tailwind utilities); inline `style` is for one-off GEOMETRY only (flex/grid, sizes, positions) — never color/background/border/font/shadow/radius. `slowcook check style-drift` enforces this."
      );
    } catch {
      // ignore
    }
  }

  const codeMapPath = join(repoRoot, ".brewing/code-map.md");
  if (existsSync(codeMapPath)) {
    try {
      const c = readFileSync(codeMapPath, "utf8").trim();
      sections.push(
        "## Production code-map (reference only — vibe writes into mock/, not src/)\n\n" +
          c +
          "\n\nThis is the production app's surface. Vibe doesn't touch it; brew copies your mock components there later via `slowcook port`. Useful as a vocabulary reference for what the production app already looks like."
      );
    } catch {
      // ignore
    }
  }

  // 0.16.0-α.4 — mock-app inventory. Lists scenarios already registered
  // + components already in mock/src/components/. Vibe MUST reuse these
  // before adding new ones.
  const mockInventory = buildMockInventory(repoRoot);
  if (mockInventory) {
    sections.push(mockInventory);
  }

  if (sections.length === 0) {
    return "_(No `.brewing/diagrams/`, `.brewing/code-map.md`, or `mock/` directory found. Vibe will run blind — strongly recommend running `slowcook map generate --emit-schema --emit-tokens` and `slowcook init mock` first.)_";
  }

  return sections.join("\n\n---\n\n");
}

/**
 * 0.16.0-α.4 — list what's already in the consumer's mock app so vibe
 * knows what to reuse vs add. Reads:
 *  - mock/scenarios/*.ts → registered story ids
 *  - mock/src/components/**\/*.tsx → existing components by relative path
 *  - mock/src/lib/scenario-registry.ts → currently registered list
 *
 * Returns a markdown section, or null when no mock/ directory exists.
 */
function buildMockInventory(repoRoot: string): string | null {
  const mockDir = join(repoRoot, "mock");
  if (!existsSync(mockDir)) {
    return "## Mock app status\n\n_No `mock/` directory found. The consumer hasn't run `slowcook init mock` yet. After that runs, vibe can extend the mock incrementally._";
  }

  const scenariosDir = join(repoRoot, "mock/scenarios");
  const componentsDir = join(repoRoot, "mock/src/components");

  const out: string[] = [];
  out.push("## Mock app inventory");
  out.push("");
  out.push("Vibe extends THIS app. Reuse what exists; add only what's missing.");
  out.push("");

  // Scenarios
  if (existsSync(scenariosDir)) {
    try {
      const files = require("node:fs").readdirSync(scenariosDir) as string[];
      const scenarioFiles = files.filter((f) => /^story-[\w-]+\.ts$/.test(f));
      if (scenarioFiles.length > 0) {
        out.push("### Scenarios already registered\n");
        for (const f of scenarioFiles.sort()) out.push(`- \`mock/scenarios/${f}\``);
      } else {
        out.push("### Scenarios already registered\n\n_(none yet — this would be the first)_");
      }
    } catch { /* skip */ }
  }
  out.push("");

  // Components
  if (existsSync(componentsDir)) {
    try {
      const files = walkComponents(componentsDir);
      if (files.length > 0) {
        out.push("### Components in `mock/src/components/`");
        out.push("");
        out.push("REUSE these by import path; only add a new file when none of these fit the spec's UI:");
        out.push("");
        for (const f of files.sort()) {
          const rel = f.slice(repoRoot.length + 1);
          out.push(`- \`${rel}\``);
        }
      } else {
        out.push("### Components in `mock/src/components/`\n\n_(none yet — first vibe run typically adds the foundational primitives the story needs)_");
      }
    } catch { /* skip */ }
  }

  return out.join("\n");
}

function walkComponents(dir: string, acc: string[] = []): string[] {
  const fs = require("node:fs") as typeof import("node:fs");
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const full = `${dir}/${name}`;
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      walkComponents(full, acc);
    } else if (/\.tsx?$/.test(name)) {
      acc.push(full);
    }
  }
  return acc;
}

export async function vibe(argv: string[], cliVersion: string): Promise<void> {
  // `slowcook vibe plan` — deterministic, no LLM. Compile all specs into the
  // whole-app LCR plan (data model + route/persona map + coverage). The spine
  // the schema/seed/surface generation passes hang off.
  if (argv[0] === "plan") return runPlan(argv.slice(1));
  // `slowcook vibe schema` — deterministic, no LLM. Generate the LCR data
  // adaptor's Drizzle schema from the plan's data model (the first gen pass).
  if (argv[0] === "schema") return runSchema(argv.slice(1));
  // `slowcook vibe seed` — the seed + adaptor pass. Deterministic runtime
  // (ddl.ts + db.ts: real in-browser SQLite) + LLM seed.ts (dense data) +
  // LLM queries.ts (the typed query adaptor / mock→prod swap seam).
  if (argv[0] === "seed") return runSeed(argv.slice(1));
  // `slowcook vibe app` — deterministic, no LLM. Scaffold the runnable, navigable
  // LCR app (Vite + router + persona shell + a stub page per route) from the plan,
  // and set review_mode: lcr. The LLM `vibe surfaces` pass fills the page bodies.
  if (argv[0] === "app") return runApp(argv.slice(1));
  // `slowcook vibe journeys` — the storyteller's contract. Deterministic
  // compile from a standing concept.yaml when present (machine-executability
  // gaps become backprop claims); LLM synthesis from specs otherwise.
  if (argv[0] === "journeys") { const { runJourneys } = await import("./journeys.js"); return runJourneys(argv.slice(1)); }
  // `slowcook vibe tell` — the STORYTELLER: walk journeys, build one
  // affordance at a time, seed data by walking (the five laws).
  // `vibe surfaces` is its alias so the ladder's language stays true.
  if (argv[0] === "tell" || argv[0] === "surfaces") { const { runTell } = await import("./tell.js"); return runTell(argv.slice(1)); }
  // `slowcook vibe check` — the MOCK-CHECKER: top-20% affordance replays ×3
  // generated worlds + the ux-optimising pass (fewer clicks · fold defaults).
  if (argv[0] === "check") { const { runCheck } = await import("./checker.js"); return runCheck(argv.slice(1)); }

  const args = parseArgs(argv);

  if (args.asBuilt) {
    // #263 — faithful mock of an EXISTING surface from its production source.
    const { collectAsBuiltInput, runAsBuiltVibe } = await import("./as-built.js");
    const { createLlmClient } = await import("../refine/llm.js");
    let llm;
    try { llm = await createLlmClient(); }
    catch (err) { console.error(`vibe --as-built: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); }
    const input = collectAsBuiltInput(args.repoRoot, args.fromPath!, args.surface);
    console.log(`vibe --as-built: transcribing ${input.fromPath}@${input.sha ?? "HEAD"} → mock/src/apps/${input.surface}/ (${input.sources.length} source file(s))…`);
    const result = await runAsBuiltVibe(llm, args.model === "claude-opus-4-7" ? "claude-opus-4-8" : args.model, input, { dryRun: args.dryRun });
    if (result.violations.length > 0) {
      console.error(`vibe --as-built: output rejected —`);
      for (const v of result.violations) console.error(`  · ${v}`);
      process.exit(1);
    }
    if (args.dryRun) { console.log(`(dry run) would write:\n  ${result.files.map((f) => f.path).join("\n  ")}`); return; }
    console.log(`Wrote ${result.written.length} file(s):\n  ${result.written.join("\n  ")}`);
    console.log(`Prod-first surface: mock edits here are PROPOSALS — record its parity-baseline entry with direction: prod-first.`);
    return;
  }

  const llm = await createLlmClient();

  // Spec must exist
  const specPath = join(args.repoRoot, "specs", `story-${args.specId}.yaml`);
  if (!existsSync(specPath)) {
    console.error(`Spec not found at ${specPath}. Did you pass the right --spec id?`);
    process.exit(2);
  }
  const specYaml = readFileSync(specPath, "utf8");

  // 0.16.0-α.4 — Eligibility gate. Vibe runs when the spec has a UI
  // surface (non-empty `ui_behavior` block). Backend-only specs skip
  // the mock track entirely; brew handles them as today. Soft-fail
  // (exit 0) so the calling workflow doesn't fail spuriously.
  if (!hasUiSurface(specYaml)) {
    console.log(
      `slowcook vibe · story-${args.specId}: spec has no \`ui_behavior\` block. This is a backend-only / non-UI story; skipping vibe.`
    );
    return;
  }

  const projectContext = buildProjectContext(args.repoRoot);

  // 0.19.0+ (sc#82) — read mock-shape config so the system prompt
  // routes path conventions / nav primitives / imports correctly.
  // Defaults to nextjs (legacy) for consumers without `.brewing/mock.yaml`.
  const { loadMockShapeConfig } = await import("../../lib/mock-shape.js");
  const mockShapeConfig = loadMockShapeConfig(args.repoRoot);

  console.log(
    `slowcook vibe · story-${args.specId} on ${args.repoRoot} (model: ${args.model}, shape: ${mockShapeConfig.shape}${args.dryRun ? ", dry-run" : ""})`
  );

  const ctx: VibeContext = {
    repoRoot: args.repoRoot,
    llm,
    model: args.model,
    storyId: args.specId,
    cliVersion,
    specYaml,
    projectContext,
    mockShape: mockShapeConfig.shape,
    mockRoot: mockShapeConfig.mock_root,
  };

  const result = await runVibe(ctx);

  if (result.kind === "format-failure") {
    console.error(
      `Vibe emitted no <file> blocks after ${result.rounds} round(s). Spend: $${result.spendUsd.toFixed(4)}.`
    );
    if (process.env["SLOWCOOK_DEBUG"]) {
      console.error("\n--- agent's final text ---\n");
      console.error(result.finalText);
    }
    process.exit(1);
  }

  if (result.kind === "build-failure") {
    console.error(
      `Vibe's mockup does NOT build after a repair round — refusing to open a broken PR. Spend: $${result.spendUsd.toFixed(4)}.\n\nBuild errors:\n${result.errors}`
    );
    process.exit(1);
  }

  console.log(
    `Vibe wrote ${result.writtenPaths.length} file(s) in ${result.rounds} round(s) (spend $${result.spendUsd.toFixed(4)}):`
  );
  for (const p of result.writtenPaths) console.log(`  ${p}`);
  if (result.changeRequests.length > 0) {
    console.log(
      `\nVibe surfaced ${result.changeRequests.length} component-change request(s) for plate to handle:`
    );
    for (const cr of result.changeRequests) {
      console.log(`  - ${cr.component} (${cr.path}): ${cr.rationale.slice(0, 100)}…`);
    }
  }

  if (args.dryRun) {
    console.log(`\n--dry-run: skipping git ops + PR opening. Files are emitted in-place at ${args.repoRoot}.`);
    return;
  }

  const githubToken = process.env["GITHUB_TOKEN"];
  if (!githubToken) {
    console.error("\nGITHUB_TOKEN environment variable is not set. Pass --dry-run to skip git/PR ops.");
    process.exit(2);
  }

  let owner = args.owner;
  let repo = args.repo;
  if (!owner || !repo) {
    const detected = detectOwnerRepo(args.repoRoot);
    if (!detected) {
      console.error("Could not detect owner/repo from git remote. Pass --owner and --repo explicitly.");
      process.exit(2);
    }
    owner = owner ?? detected.owner;
    repo = repo ?? detected.repo;
  }

  const forge = new GitHubAdapter({ owner, repo, token: githubToken });
  const branch = `slowcook/mockup/story-${args.specId}`;
  await forge.git.createBranch(branch);
  for (const p of result.writtenPaths) await forge.git.stage(p);
  await forge.git.commit(
    `vibe: mockup for story-${args.specId}\n\nGenerated by slowcook vibe@${cliVersion}.\n`
  );
  await forge.git.push(branch);

  // 0.16.0-α.23 — extract `source_issue` from the spec YAML so the
  // mockup PR includes a `Closes #N` reference. GitHub then auto-
  // hyperlinks the issue (bidirectional in the UI) and auto-closes
  // the issue when the PR merges.
  const sourceIssueNumber = parseSourceIssueNumber(specYaml);
  const issueRef = sourceIssueNumber !== null ? `#${sourceIssueNumber}` : null;

  try {
    const pr = await forge.createPullRequest({
      head: branch,
      base: args.baseBranch,
      title: issueRef
        ? `mockup: story-${args.specId} (${issueRef})`
        : `mockup: story-${args.specId}`,
      body: buildPrBody(args.specId, result.writtenPaths, result.changeRequests, result.spendUsd, cliVersion, issueRef),
      draft: true,
      labels: ["slowcook-mockup"],
    });
    console.log(`\nDraft PR opened: ${pr.url}`);
    console.log("Review the preview deploy; comment `/plate <prose>` to iterate.");
  } catch (e) {
    console.error(
      `Files committed + pushed to '${branch}', but PR creation failed: ${(e as Error).message}`
    );
    process.exit(2);
  }
}

/**
 * 0.16.0-α.23 — pluck `source_issue: "#N"` from the spec YAML. The
 * spec's `source_issue` field is set by refine when an issue → spec
 * is opened. Returns the numeric id (no `#` prefix), or null when
 * the spec has no source_issue (rare; manual specs).
 */
function parseSourceIssueNumber(specYaml: string): number | null {
  const m = specYaml.match(/^source_issue:\s*"?#?(\d+)"?\s*$/m);
  if (!m || !m[1]) return null;
  const n = parseInt(m[1], 10);
  return Number.isNaN(n) ? null : n;
}

function buildPrBody(
  specId: string,
  writtenPaths: string[],
  changeRequests: { component: string; path: string; rationale: string }[],
  spendUsd: number,
  cliVersion: string,
  /** GitHub issue ref like `#138`, or null if the spec has no source_issue. */
  issueRef: string | null
): string {
  const branch = `slowcook/mockup/story-${specId}`;
  const out: string[] = [];
  // 0.16.0-α.23 — `Closes #N` at the very top auto-links + auto-closes
  // the originating GitHub issue when this PR merges.
  if (issueRef) {
    out.push(`Closes ${issueRef}\n`);
  }
  out.push(
    `## Mockup scenario for story-${specId}` +
      (issueRef ? ` (originating issue: ${issueRef})` : "") +
      `\n\nGenerated by \`slowcook vibe@${cliVersion}\` (spend $${spendUsd.toFixed(4)}).`
  );
  out.push(
    `\nThis PR extends the mock app at \`mock/\` with a new scenario for story-${specId}. The mock is the **design contract** — vibe writes scenarios + (rarely) new components into it; brew copies its components into \`src/\` and wires real data after this PR + the recipe-tests PR both merge.`
  );
  out.push(`\n## Review the mockup`);
  out.push(
    `\nOnce \`slowcook preview deploy\` runs (0.16-α.5), the comment thread on this PR will get a live preview URL on the consumer's box. Until then, run locally:`
  );
  out.push(
    `\n\`\`\`bash\n` +
      `git fetch origin ${branch}\n` +
      `git checkout ${branch}\n` +
      `cd mock && npm install\n` +
      `npm run dev   # http://localhost:3100\n` +
      `\`\`\``
  );
  out.push(
    `\nOpen the scenario picker at the homepage, or deep-link directly: \`http://localhost:3100/?scenario=${specId}\`. Click through real interactions; the buttons mutate local React state — no real API calls. Comment \`/plate <prose>\` here when you want changes; plate amends the scenario or component(s) with minimum diff.`
  );
  out.push(`\n## Files emitted (${writtenPaths.length})\n`);
  for (const p of writtenPaths) out.push(`- \`${p}\``);
  if (changeRequests.length > 0) {
    out.push(`\n## Component-change requests (${changeRequests.length})\n`);
    out.push(
      `Vibe identified existing mock components that would benefit from a structural change (new prop, etc.) but did NOT modify them. PM reviews + plate applies on iteration.\n`
    );
    for (const cr of changeRequests) {
      out.push(`### \`${cr.component}\` — \`${cr.path}\`\n\n${cr.rationale}\n`);
    }
  }
  out.push(
    `\n---\nMerge this PR after PM approval. \`recipe\` (in parallel) writes tier-1 tests blind to the mock against the spec; \`slowcook port\` then deterministically copies new mock components into \`src/\`; \`brew --mode plate\` wires real data + API handlers + migrations to make tests green without touching UI.`
  );
  // 0.16.0-α.24 — emit a structured cost marker so on-mockup-approved
  // (and on-brew-merged) can roll up vibe's cost into the issue
  // bill. Plate already emits this shape; vibe was the missing half.
  out.push(
    `\n<!-- slowcook:cost agent=vibe usd=${spendUsd.toFixed(4)} model=claude-opus-4-7 cli=${cliVersion} -->`
  );
  return out.join("\n");
}

/**
 * `slowcook vibe plan` — compile all active specs into the whole-app LCR plan and
 * print it (data model + persona/route map + coverage). Writes the machine form
 * to `.brewing/lcr-plan.json` for the generation passes. Deterministic, no LLM.
 */
/** Compile the LCR plan from the repo's active specs (shared by plan + schema). */
export function loadPlan(cwd: string): LcrPlan | null {
  const specs = listActiveSpecs(cwd);
  if (specs.length === 0) return null;
  const planSpecs: PlanSpecInput[] = specs.map((s) => ({
    storyId: s.story_id,
    entities: (s.data_contract?.entities ?? []).map((e) => ({
      name: e.name,
      fields: (e.fields ?? []).map((f) => ({ name: f.name, type: f.type })),
      relations: e.relations,
    })),
    actors: (s.actors ?? []).map((a) => ({ name: a.name })),
    persona: s.persona,
    surfaces: s.surfaces,
    epic: s.epic ?? readableAnchor(s.prd_ref?.anchor),
    title: s.title,
    acceptanceScenarios: s.acceptance_scenarios,
  }));
  return compileLcrPlan(planSpecs);
}

/** Derive a readable Epic label from a PRD anchor slug when the spec has no
 *  explicit `epic` — strips the common heading prefixes and title-cases the rest.
 *  "surface-founder-onboarding" → "Founder Onboarding". Falls back to "General". */
function readableAnchor(anchor?: string): string {
  if (!anchor) return "General";
  const stripped = anchor.replace(/^(surfaces?|personas?|sections?|epic)-/i, "");
  const words = stripped.split(/[-_]+/).filter(Boolean);
  if (!words.length) return "General";
  return words.map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
}

async function runPlan(argv: string[]): Promise<void> {
  const cwd = resolve(argFlag(argv, "--cwd") ?? ".");
  const plan = loadPlan(cwd);
  if (!plan) {
    console.error("vibe plan: no active specs under specs/ — run `menu` first.");
    process.exit(1);
  }
  const specCount = plan.stories.length;

  const fieldCount = plan.entities.reduce((n, e) => n + e.fields.length, 0);
  console.log(`vibe plan — whole-app LCR from ${specCount} specs\n`);
  console.log(`  data model:  ${plan.entities.length} entities · ${fieldCount} fields · ${plan.conflicts.length} conflict(s)`);
  console.log(`  personas:    ${plan.personas.length}  (${plan.personas.map((p) => p.id).join(", ") || "—"})`);
  console.log(`  surfaces:    ${plan.surfaces.length} route(s) across ${new Set(plan.surfaces.map((s) => s.route)).size} unique path(s)`);
  console.log(`  coverage:    ${plan.stories.length - plan.uncoveredStories.length}/${plan.stories.length} stories contribute a surface`);

  if (plan.conflicts.length) {
    console.log(`\n  ⚠ data-model conflicts (same field, divergent types — resolve before schema-gen):`);
    for (const c of plan.conflicts) {
      const variants = c.types.map((t) => `${t.type} [${t.stories.map((s) => "story-" + s).join(",")}]`).join(" vs ");
      console.log(`    ✗ ${c.entity}.${c.field}: ${variants}`);
    }
  }

  console.log(`\n  entities:`);
  for (const e of plan.entities) {
    console.log(`    · ${e.name} (${e.fields.length} fields) ← ${e.fromStories.map((s) => "story-" + s).join(", ")}`);
  }

  if (plan.surfaces.length) {
    console.log(`\n  surfaces (persona → route):`);
    for (const s of plan.surfaces) console.log(`    · ${s.persona} → ${s.route}${s.home ? " [home]" : ""} (story-${s.storyId})`);
  }

  if (plan.uncoveredStories.length) {
    console.log(`\n  no surface declared (UI gap or backend-only): ${plan.uncoveredStories.map((s) => "story-" + s).join(", ")}`);
    if (plan.surfaces.length === 0) {
      console.log(`  → specs declare no surfaces yet. Re-run \`menu\` (emits persona + surfaces) so the route map populates.`);
    }
  }

  const outDir = resolve(cwd, ".brewing");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, "lcr-plan.json");
  writeFileSync(outFile, JSON.stringify(plan, null, 2) + "\n");
  console.log(`\n  → .brewing/lcr-plan.json (machine form for the schema/seed/surface passes)`);
}

/** Small flag reader for the plan subcommand. */
function argFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * `slowcook vibe schema` — generate the LCR data adaptor's Drizzle schema from the
 * plan's data model. Deterministic (the data_contract types map mechanically to
 * Drizzle columns); the seed + surfaces passes (LLM) build on it. Writes to the
 * mock's data-layer dir (default `mock/src/lib/schema.ts`).
 */
async function runSchema(argv: string[]): Promise<void> {
  const cwd = resolve(argFlag(argv, "--cwd") ?? ".");
  const plan = loadPlan(cwd);
  if (!plan) {
    console.error("vibe schema: no active specs under specs/ — run `menu` first.");
    process.exit(1);
  }
  if (plan.entities.length === 0) {
    console.error("vibe schema: the plan has no entities (specs carry no data_contract). Nothing to generate.");
    process.exit(1);
  }
  if (plan.conflicts.length > 0) {
    console.error(`vibe schema: ${plan.conflicts.length} data-model conflict(s) — resolve before schema-gen (run \`vibe plan\`):`);
    for (const c of plan.conflicts) {
      console.error(`    ✗ ${c.entity}.${c.field}: ${c.types.map((t) => t.type).join(" vs ")}`);
    }
    process.exit(1);
  }

  const schema = compileDrizzleSchema(plan.entities);

  const mock = loadMockShapeConfig(cwd);
  const rel = argFlag(argv, "--out") ?? join(mock.mock_root, "src/lib/schema.ts");
  const fieldCount = plan.entities.reduce((n, e) => n + e.fields.length, 0);

  if (argFlag(argv, "--stdout") !== undefined || argv.includes("--stdout")) {
    process.stdout.write(schema);
    return;
  }

  const outAbs = resolve(cwd, rel);
  mkdirSync(join(outAbs, ".."), { recursive: true });
  writeFileSync(outAbs, schema);
  console.log(`vibe schema — ${plan.entities.length} tables · ${fieldCount} columns → ${rel}`);
  console.log(`  deterministic (data_contract → Drizzle). Next: \`vibe seed\` (dense data) + surface passes.`);
}

/** Compact behavioural digest of the specs for the seed/adaptor prompts:
 *  persona, surfaces+states, invariants, acceptance scenarios. */
export function buildSpecsDigest(cwd: string): string {
  const out: string[] = [];
  for (const s of listActiveSpecs(cwd)) {
    const lines: string[] = [`### story-${s.story_id} — ${s.title}`];
    if (s.persona) lines.push(`persona: ${s.persona.id}${s.persona.chrome ? ` (${s.persona.chrome})` : ""}`);
    if (s.surfaces?.length) {
      lines.push("surfaces:");
      for (const su of s.surfaces) lines.push(`  - ${su.route}${su.home ? " [home]" : ""}${su.states?.length ? ` — states: ${su.states.join(", ")}` : ""}`);
    }
    if (s.invariants?.length) lines.push("invariants:\n" + s.invariants.map((i) => `  - ${i}`).join("\n"));
    if (s.api_contract?.length) lines.push("api_contract:\n" + s.api_contract.map((a) => `  - ${JSON.stringify(a)}`).join("\n"));
    if (s.acceptance_scenarios?.length) lines.push("scenarios:\n" + s.acceptance_scenarios.map((a) => `  - ${a}`).join("\n"));
    out.push(lines.join("\n"));
  }
  return out.join("\n\n");
}

/** Strip a leading/trailing markdown code fence if the model wrapped the file. */
function stripFence(s: string): string {
  return s.replace(/^\s*```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim() + "\n";
}

/**
 * `slowcook vibe seed` — the seed + adaptor pass. Deterministic runtime
 * (schema.ts + ddl.ts + db.ts = a real in-browser SQLite) + two LLM passes:
 * seed.ts (dense, state-covering data) and queries.ts (the typed query adaptor /
 * mock→prod swap seam). Writes into the mock's lib dir.
 */
async function runSeed(argv: string[]): Promise<void> {
  const cwd = resolve(argFlag(argv, "--cwd") ?? ".");
  const model = argFlag(argv, "--model") ?? "claude-opus-4-7";
  const dryRun = argv.includes("--dry-run");
  const plan = loadPlan(cwd);
  if (!plan) { console.error("vibe seed: no active specs — run `menu` first."); process.exit(1); }
  if (plan.entities.length === 0) { console.error("vibe seed: no entities in the plan (no data_contract)."); process.exit(1); }
  if (plan.conflicts.length > 0) {
    console.error(`vibe seed: ${plan.conflicts.length} data-model conflict(s) — resolve first (run \`vibe plan\`).`);
    process.exit(1);
  }

  const mock = loadMockShapeConfig(cwd);
  const libDir = resolve(cwd, mock.mock_root, "src/lib");
  mkdirSync(libDir, { recursive: true });

  // 1. Deterministic runtime: schema.ts, ddl.ts, db.ts.
  const schemaTs = compileDrizzleSchema(plan.entities);
  const ddl = compileSqliteDdl(plan.entities);
  const ddlTs = `// @convention LCR data adaptor DDL — generated by \`slowcook vibe seed\`.\n// CREATE TABLE for the in-browser SQLite; deterministic from the plan. Do not hand-edit.\nexport const DDL = \`\n${ddl.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\`;\n`;
  writeFileSync(join(libDir, "schema.ts"), schemaTs);
  writeFileSync(join(libDir, "ddl.ts"), ddlTs);
  writeFileSync(join(libDir, "db.ts"), dbBootstrapTs());
  // Worlds (storyteller stage): "empty" = schema only; "default" wraps the
  // LCR seed. Walk-produced snapshots land beside them.
  const worldsDir = join(libDir, "worlds");
  mkdirSync(worldsDir, { recursive: true });
  writeFileSync(join(worldsDir, "empty.ts"), `// @convention storyteller world — the nothing-state. Stories start here.\nimport type { DB } from "../db";\nexport async function seedWorld(_db: DB): Promise<void> { /* schema only */ }\n`);
  writeFileSync(join(worldsDir, "default.ts"), `// @convention storyteller world — the LCR default seed, world-shaped.\nimport type { DB } from "../db";\nimport { seed } from "../seed";\nexport async function seedWorld(db: DB): Promise<void> { await seed(db); }\n`);
  console.log(`vibe seed — wrote deterministic runtime: schema.ts · ddl.ts · db.ts · worlds/{empty,default}.ts (${plan.entities.length} tables, real sql.js)`);

  if (dryRun) { console.log("  [dry-run] skipping the LLM seed + adaptor passes."); return; }

  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) { console.error("vibe seed: ANTHROPIC_API_KEY not set (or pass --dry-run for the deterministic runtime only)."); process.exit(1); }

  const digest = buildSpecsDigest(cwd);
  const userCtx = `## Generated Drizzle schema (use these exact table vars + columns)\n\`\`\`ts\n${schemaTs}\n\`\`\`\n\n## Specs digest (personas · surfaces+states · invariants · scenarios)\n${digest}`;
  const llm = new AnthropicClient(apiKey);

  // 2. LLM: seed.ts (dense, state-covering, referentially-consistent).
  console.log(`  generating seed.ts (model ${model})…`);
  const seedRes = await llm.complete({ system: SEED_SYSTEM, model, maxTokens: 32000, stream: true, messages: [{ role: "user", content: userCtx + "\n\nWrite seed.ts now." }] });
  writeFileSync(join(libDir, "seed.ts"), stripFence(seedRes.text));

  // 3. LLM: queries.ts (the typed domain adaptor / swap seam).
  console.log(`  generating queries.ts…`);
  const qRes = await llm.complete({ system: ADAPTOR_SYSTEM, model, maxTokens: 32000, stream: true, messages: [{ role: "user", content: userCtx + "\n\nWrite queries.ts now." }] });
  writeFileSync(join(libDir, "queries.ts"), stripFence(qRes.text));

  const totalUsd = seedRes.costUsd + qRes.costUsd;
  console.log(`  wrote seed.ts + queries.ts`);
  console.log("\n" + formatCostFooter(totalUsd, []));
  console.log(`\n  data adaptor complete: ${mock.mock_root}/src/lib/{schema,ddl,db,seed,queries}.ts`);
  console.log(`  deps the mock needs: drizzle-orm, sql.js. Next: surface passes render via \`data\` from queries.ts.`);
}

/**
 * `slowcook vibe app` — scaffold the runnable, navigable whole-app LCR from the
 * plan: the Vite/Tailwind app + router (every surface reachable) + persona shell
 * + a stub page per route (sets the @story marker). Deterministic — the LLM
 * `vibe surfaces` pass fills page bodies. Also sets `.brewing/mock.yaml`
 * (review_mode: lcr). Does NOT overwrite the data adaptor (schema/ddl/db/seed/
 * queries) — run `vibe seed` first.
 */
async function runApp(argv: string[]): Promise<void> {
  const cwd = resolve(argFlag(argv, "--cwd") ?? ".");
  const plan = loadPlan(cwd);
  if (!plan) { console.error("vibe app: no active specs — run `menu` first."); process.exit(1); }
  if (plan.surfaces.length === 0) {
    console.error("vibe app: the plan has no surfaces — re-run `menu` so specs declare persona + surfaces.");
    process.exit(1);
  }
  const mock = loadMockShapeConfig(cwd);
  const mockRoot = resolve(cwd, mock.mock_root);
  const force = argv.includes("--force");

  const projectName = basename(cwd) || "app";
  const ownerRepo = detectOwnerRepo(cwd);
  const files = generateLcrApp(plan, { projectName, owner: ownerRepo?.owner, repo: ownerRepo?.repo });

  let wrote = 0;
  let skipped = 0;
  for (const f of files) {
    const abs = join(mockRoot, f.path);
    if (existsSync(abs) && !force) { skipped++; continue; }
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, f.content);
    wrote++;
  }

  // .brewing/mock.yaml — declare the LCR shape (idempotent unless --force).
  const mockYamlPath = resolve(cwd, ".brewing", "mock.yaml");
  if (!existsSync(mockYamlPath) || force) {
    mkdirSync(resolve(cwd, ".brewing"), { recursive: true });
    writeFileSync(mockYamlPath, mockYaml());
  }

  const routes = new Set(plan.surfaces.map((s) => s.route)).size;
  console.log(`vibe app — scaffolded the LCR: ${routes} route(s) · ${plan.personas.length} personas · ${wrote} file(s) written${skipped ? `, ${skipped} kept (use --force to overwrite)` : ""}`);
  console.log(`  review_mode: lcr set in .brewing/mock.yaml`);
  if (!existsSync(join(mockRoot, "src/lib/db.ts"))) {
    console.log(`  ⚠ no data adaptor yet — run \`slowcook vibe seed\` so pages can read real data.`);
  }
  console.log(`  next: \`cd ${mock.mock_root} && npm install && npm run dev\` to click through the skeleton; then \`slowcook vibe surfaces\` to fill the page bodies.`);
}
