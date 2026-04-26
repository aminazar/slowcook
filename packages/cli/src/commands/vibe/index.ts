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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GitHubAdapter } from "@slowcook-ai/forge-github";
import { runVibe, type VibeContext } from "./agent.js";

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
 * Lightweight check for spec UI-surface eligibility. Looks for the
 * `proposals: ... fixtures: ... by_domain:` shape with at least one
 * domain entry. Avoids pulling in YAML parser for what's a regex
 * sniff — but resilient to indentation variations.
 *
 * Returns true if the spec has at least one domain under
 * `proposals.fixtures.by_domain`. Returns false otherwise (no fixtures
 * block, empty by_domain, or unparseable spec).
 */
function hasUiSurface(specYaml: string): boolean {
  // Anchor on the `proposals:` block at top-level (no leading
  // whitespace). Then look for `fixtures:` indented under it.
  const proposalsIdx = specYaml.search(/^proposals\s*:\s*$/m);
  if (proposalsIdx < 0) return false;
  const tail = specYaml.slice(proposalsIdx);
  // Match `  fixtures:` (any positive indent).
  const fixturesMatch = tail.match(/^(\s+)fixtures\s*:\s*$/m);
  if (!fixturesMatch) return false;
  const fixturesBlockStart = tail.indexOf(fixturesMatch[0]) + fixturesMatch[0].length;
  // Look for `by_domain:` deeper than fixtures' indent.
  const byDomainMatch = tail.slice(fixturesBlockStart).match(/^(\s+)by_domain\s*:\s*$/m);
  if (!byDomainMatch) return false;
  const byDomainIndentLen = byDomainMatch[1]!.length;
  // After by_domain:, expect at least one entry indented strictly
  // deeper. Match `^<indent_deeper><word>:` lines.
  const after = tail.slice(
    fixturesBlockStart + tail.slice(fixturesBlockStart).indexOf(byDomainMatch[0]) + byDomainMatch[0].length
  );
  const entryRe = new RegExp(
    `^( {${byDomainIndentLen + 1},}|\\t+)([a-z][a-z0-9_-]*)\\s*:\\s*$`,
    "m"
  );
  return entryRe.test(after);
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
        "## Code-map (existing components, pages, helpers)\n\n" +
          c +
          "\n\nReuse components by their import path verbatim. NEVER duplicate functionality of an existing component under a new name."
      );
    } catch {
      // ignore
    }
  }

  if (sections.length === 0) {
    return "_(No `.brewing/diagrams/` or `.brewing/code-map.md` extracts found. Vibe will run blind — strongly recommend running `slowcook map generate --emit-schema --emit-tokens` first.)_";
  }

  return sections.join("\n\n---\n\n");
}

export async function vibe(argv: string[], cliVersion: string): Promise<void> {
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

  // Eligibility gate: vibe only runs on UI stories (proposals.fixtures
  // populated). Backend-only specs skip the plate track entirely; the
  // existing brew handles them in legacy mode. Soft-fail (exit 0) so
  // the calling workflow doesn't fail spuriously.
  if (!hasUiSurface(specYaml)) {
    console.log(
      `slowcook vibe · story-${args.specId}: spec has no \`proposals.fixtures\` (or all seeds empty). This is a backend-only / non-UI story; skipping vibe.`
    );
    return;
  }

  const projectContext = buildProjectContext(args.repoRoot);

  console.log(
    `slowcook vibe · story-${args.specId} on ${args.repoRoot} (model: ${args.model}${args.dryRun ? ", dry-run" : ""})`
  );

  const ctx: VibeContext = {
    repoRoot: args.repoRoot,
    anthropicApiKey,
    model: args.model,
    storyId: args.specId,
    cliVersion,
    specYaml,
    projectContext,
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

  try {
    const pr = await forge.createPullRequest({
      head: branch,
      base: args.baseBranch,
      title: `mockup: story-${args.specId}`,
      body: buildPrBody(args.specId, result.writtenPaths, result.changeRequests, result.spendUsd, cliVersion),
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

function buildPrBody(
  specId: string,
  writtenPaths: string[],
  changeRequests: { component: string; path: string; rationale: string }[],
  spendUsd: number,
  cliVersion: string
): string {
  const branch = `slowcook/mockup/story-${specId}`;
  const out: string[] = [];
  out.push(
    `## Mockup for story-${specId}\n\nGenerated by \`slowcook vibe@${cliVersion}\` (spend $${spendUsd.toFixed(4)}).`
  );
  out.push(
    `\nThis is a runnable mockup with mock data. The PM reviews + comments \`/plate <prose>\` on this PR to iterate. Brew (\`--mode plate\`, after recipe writes tests against this branch's DOM) replaces \`src/lib/data/<domain>.ts\` stubs with real fetches and adds API handlers + migrations — UI files frozen.\n`
  );
  out.push(`\n## Review the mockup locally\n`);
  out.push(
    `\`\`\`bash\n` +
      `git fetch origin ${branch}\n` +
      `git checkout ${branch}\n` +
      `npm install   # or pnpm install\n` +
      `npm run dev   # http://localhost:3000\n` +
      `\`\`\``
  );
  out.push(
    `\nThe data layer is mock-only — no Supabase, no real API. Click through to test interactions; the buttons mutate local React state. Comment \`/plate <prose>\` here when you want changes; plate amends the mockup with minimum diff.`
  );
  out.push(`\n## Files emitted (${writtenPaths.length})\n`);
  for (const p of writtenPaths) out.push(`- \`${p}\``);
  if (changeRequests.length > 0) {
    out.push(`\n## Component-change requests (${changeRequests.length})\n`);
    out.push(
      `Vibe identified existing components that would benefit from a structural change (new prop, etc.) but did NOT modify them. PM reviews + plate applies on iteration.\n`
    );
    for (const cr of changeRequests) {
      out.push(`### \`${cr.component}\` — \`${cr.path}\`\n\n${cr.rationale}\n`);
    }
  }
  out.push(
    `\n---\nMerge this PR after PM approval to fire \`recipe\` (writes tests against this branch's DOM) → \`brew --mode plate\` (real data layer + API + migrations).`
  );
  return out.join("\n");
}
