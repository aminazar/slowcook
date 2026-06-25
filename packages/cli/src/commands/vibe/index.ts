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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { GitHubAdapter } from "@slowcook-ai/forge-github";
import { runVibe, type VibeContext } from "./agent.js";
import { listActiveSpecs } from "../refine/spec-yaml.js";
import { compileLcrPlan, type PlanSpecInput } from "./lcr-plan.js";

interface VibeArgs {
  specId: string;
  repoRoot: string;
  owner?: string;
  repo?: string;
  model: string;
  /** Skip git ops; just emit files locally. Useful for offline validation. */
  dryRun: boolean;
  baseBranch: string;
}

function parseArgs(argv: string[]): VibeArgs {
  const args: VibeArgs = {
    specId: "",
    repoRoot: process.cwd(),
    model: "claude-opus-4-7",
    dryRun: false,
    baseBranch: "main",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--spec" && next) { args.specId = next; i++; }
    else if (a === "--cwd" && next) { args.repoRoot = next; i++; }
    else if (a === "--owner" && next) { args.owner = next; i++; }
    else if (a === "--repo" && next) { args.repo = next; i++; }
    else if (a === "--model" && next) { args.model = next; i++; }
    else if (a === "--base-branch" && next) { args.baseBranch = next; i++; }
    else if (a === "--dry-run") { args.dryRun = true; }
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
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
  ANTHROPIC_API_KEY   (required) Anthropic API key.
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
          "\n\nReuse these tokens by exact name (`bg-coral`, `var(--tint-celebrate)`); do NOT introduce new hex/rgb values."
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

  const args = parseArgs(argv);

  const anthropicApiKey = process.env["ANTHROPIC_API_KEY"];
  if (!anthropicApiKey) {
    console.error("ANTHROPIC_API_KEY environment variable is not set.");
    process.exit(2);
  }

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
    anthropicApiKey,
    model: args.model,
    storyId: args.specId,
    cliVersion,
    specYaml,
    projectContext,
    mockShape: mockShapeConfig.shape,
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
async function runPlan(argv: string[]): Promise<void> {
  const cwd = resolve(argFlag(argv, "--cwd") ?? ".");
  const specs = listActiveSpecs(cwd);
  if (specs.length === 0) {
    console.error("vibe plan: no active specs under specs/ — run `menu` first.");
    process.exit(1);
  }

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
  }));

  const plan = compileLcrPlan(planSpecs);

  const fieldCount = plan.entities.reduce((n, e) => n + e.fields.length, 0);
  console.log(`vibe plan — whole-app LCR from ${specs.length} specs\n`);
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
