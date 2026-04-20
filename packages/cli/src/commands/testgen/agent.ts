import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import YAML from "yaml";
import type { ForgeAdapter, Spec } from "@slowcook-ai/core";
import type { LlmClient } from "../refine/llm.js";
import {
  buildManifest,
  type Manifest,
} from "@slowcook-ai/core";
import { readIndex, readSpec, SPECS_DIR } from "../refine/spec-yaml.js";
import { TESTGEN_SYSTEM } from "./prompts.js";

export const LABEL_TESTS_READY = "tests-ready";
export const LABEL_OVERRIDE_FREEZE = "override-freeze";

export const TESTS_INTEGRATION_DIR = "tests/integration";
export const MANIFESTS_DIR = ".brewing/manifests";

export interface TestgenContext {
  repoRoot: string;
  forge: ForgeAdapter;
  llm: LlmClient;
  model: string;
  cliVersion: string;
  baseBranch: string;
  /** When true, generate tests for every active spec that lacks them (CI path). */
  all: boolean;
  /** When set, generate tests for this spec ID only (ops path / re-runs). */
  specId: string | null;
  /** Idempotent base branch name. */
  branchName: string;
  /** Injectable now for tests. */
  now: Date;
}

export type TestgenOutcome =
  | { kind: "tests-emitted"; storyIds: string[]; prUrl: string; prNumber: number; removedStoryIds: string[] }
  | { kind: "nothing-to-generate"; reason: string }
  | { kind: "pr-creation-blocked"; storyIds: string[]; branchName: string };

/**
 * Main entry: for every spec in scope, if tests don't exist yet, generate them.
 * If the spec supersedes prior stories, remove the old tests + manifests for
 * those stories as part of the same PR (auto-applies `override-freeze` label,
 * citing the supersede chain in the PR body for auditability).
 */
export async function runTestgen(ctx: TestgenContext): Promise<TestgenOutcome> {
  const specs = collectTargetSpecs(ctx);
  if (specs.length === 0) {
    return { kind: "nothing-to-generate", reason: "no active specs without tests" };
  }

  // Produce per-spec artifacts in a scratch area; commit together at the end.
  const generated: GeneratedArtifact[] = [];
  const toRemove: string[] = [];

  for (const spec of specs) {
    const projectContext = buildProjectContext(ctx.repoRoot);
    const fileContents = await generateTestFile(spec, ctx, projectContext);
    const testPath = join(TESTS_INTEGRATION_DIR, `story-${spec.story_id}.test.ts`);
    const manifestIds = extractTestIdsFromFile(testPath, fileContents);
    const manifest = buildManifest({
      slowcookVersion: ctx.cliVersion,
      storyId: spec.story_id,
      tests: manifestIds.map((id) => ({ id, file: testPath })),
      suites: [{ suite: "backend", command: "npx vitest list", test_count: manifestIds.length }],
      now: ctx.now,
    });
    generated.push({ spec, testPath, fileContents, manifest });

    for (const superseded of spec.supersedes) {
      toRemove.push(superseded);
    }
  }

  // Apply to disk: write new, delete superseded
  for (const g of generated) {
    writeFileAt(ctx.repoRoot, g.testPath, g.fileContents);
    const manifestPath = join(MANIFESTS_DIR, `story-${g.spec.story_id}.json`);
    writeFileAt(ctx.repoRoot, manifestPath, JSON.stringify(g.manifest, null, 2) + "\n");
  }
  const actuallyRemoved: string[] = [];
  for (const id of toRemove) {
    const removed = removeIfExists(ctx.repoRoot, [
      join(TESTS_INTEGRATION_DIR, `story-${id}.test.ts`),
      join(MANIFESTS_DIR, `story-${id}.json`),
    ]);
    if (removed > 0) actuallyRemoved.push(id);
  }

  // Git: branch, stage, commit, push
  await ctx.forge.git.createBranch(ctx.branchName);
  for (const g of generated) {
    await ctx.forge.git.stage(g.testPath);
    await ctx.forge.git.stage(join(MANIFESTS_DIR, `story-${g.spec.story_id}.json`));
  }
  for (const id of actuallyRemoved) {
    await ctx.forge.git.stage(join(TESTS_INTEGRATION_DIR, `story-${id}.test.ts`));
    await ctx.forge.git.stage(join(MANIFESTS_DIR, `story-${id}.json`));
  }
  const storyIds = generated.map((g) => g.spec.story_id);
  await ctx.forge.git.commit(
    `slowcook: tests for ${storyIds.map((s) => `story-${s}`).join(", ")}` +
      (actuallyRemoved.length > 0
        ? `\n\nRemoves tests for superseded: ${actuallyRemoved.map((s) => `story-${s}`).join(", ")}`
        : "")
  );
  await ctx.forge.git.push(ctx.branchName);

  // PR
  const labels = ["slowcook-tests"];
  if (actuallyRemoved.length > 0) {
    labels.push(LABEL_OVERRIDE_FREEZE);
  }

  try {
    const pr = await ctx.forge.createPullRequest({
      title: `tests: ${storyIds.map((s) => `story-${s}`).join(", ")}`,
      body: buildPrBody({ generated, removedStoryIds: actuallyRemoved }),
      head: ctx.branchName,
      base: ctx.baseBranch,
      draft: true,
      labels,
    });
    return {
      kind: "tests-emitted",
      storyIds,
      prUrl: pr.url,
      prNumber: pr.number,
      removedStoryIds: actuallyRemoved,
    };
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 403) {
      return {
        kind: "pr-creation-blocked",
        storyIds,
        branchName: ctx.branchName,
      };
    }
    throw e;
  }
}

// ----------------- internals -----------------

interface GeneratedArtifact {
  spec: Spec;
  testPath: string;
  fileContents: string;
  manifest: Manifest;
}

function collectTargetSpecs(ctx: TestgenContext): Spec[] {
  const index = readIndex(ctx.repoRoot);
  const all = Object.entries(index.stories)
    .filter(([, entry]) => entry.status === "active")
    .map(([id]) => id);

  const targetIds = ctx.specId ? [ctx.specId] : all;
  const specs: Spec[] = [];

  for (const id of targetIds) {
    const testPath = join(ctx.repoRoot, TESTS_INTEGRATION_DIR, `story-${id}.test.ts`);
    if (existsSync(testPath) && !ctx.specId) continue; // skip specs already tested, unless explicit --spec
    try {
      specs.push(readSpec(ctx.repoRoot, id));
    } catch {
      // spec file missing despite being in index — skip
    }
  }
  return specs;
}

function buildProjectContext(repoRoot: string): string {
  const bits: string[] = [];

  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    bits.push(`package.json name: ${pkg.name}`);
    if (pkg.description) bits.push(`package.json description: ${pkg.description}`);
    if (pkg.scripts?.test) bits.push(`test script: ${pkg.scripts.test}`);
  } catch {
    /* ignore */
  }

  // Show up to 2 existing integration test files as style references
  const testsDir = join(repoRoot, TESTS_INTEGRATION_DIR);
  if (existsSync(testsDir)) {
    const existing = readdirSync(testsDir).filter((f) => f.endsWith(".test.ts")).slice(0, 2);
    for (const f of existing) {
      const p = join(testsDir, f);
      try {
        const content = readFileSync(p, "utf8");
        const excerpt = content.split("\n").slice(0, 40).join("\n");
        bits.push(`\n### Style reference: ${f} (first 40 lines)\n\n\`\`\`ts\n${excerpt}\n\`\`\``);
      } catch {
        /* ignore */
      }
    }
  } else {
    bits.push("No existing integration tests — this will be the first in the repo.");
  }

  return bits.join("\n");
}

async function generateTestFile(
  spec: Spec,
  ctx: TestgenContext,
  projectContext: string
): Promise<string> {
  const systemPrompt = TESTGEN_SYSTEM(projectContext);
  const userMessage = `Here is the spec YAML. Generate the Vitest integration test file:\n\n\`\`\`yaml\n${YAML.stringify(spec)}\n\`\`\``;

  const raw = await ctx.llm.complete({
    system: systemPrompt,
    cacheSystem: true,
    model: ctx.model,
    messages: [{ role: "user", content: userMessage }],
    maxTokens: 8192,
  });

  return stripCodeFence(raw);
}

function stripCodeFence(raw: string): string {
  const t = raw.trim();
  const fence = t.match(/^```(?:typescript|ts)?\s*\n([\s\S]*)\n```$/);
  if (fence && fence[1]) return fence[1];
  return t;
}

/**
 * Parse the emitted TS file and pull out test IDs in the format
 *   <file> > <describe-chain> > <test-name>
 * matching what `vitest list` would emit.
 *
 * This is a lightweight text-level extraction — we parse for `describe(` and
 * `it(` invocations and their string literal arguments, tracking nesting.
 * Robust against typical usage; falls back to a single synthetic entry if
 * nothing recognisable is found.
 */
export function extractTestIdsFromFile(filePath: string, source: string): string[] {
  const ids: string[] = [];
  const stack: string[] = [];
  // Match describe("...", OR it("...", — minimal, single-quote-or-double-quote strings only
  const re = /\b(describe|it|test)\s*\(\s*(['"])((?:\\.|[^\\])*?)\2/g;
  // Track blocks by matching braces simply — naive but works for well-formed
  // source. We use line-by-line depth for describes because inferring block
  // close on a braces level requires a full parser.
  //
  // Simpler heuristic: treat each `describe(...)` as pushing onto the stack,
  // and assume it stays on the stack for everything until a balanced close.
  // For initial impl, we approximate by scanning in order and inserting
  // markers at `});` following each opening. For the shape Vitest produces,
  // this works in practice.
  //
  // To keep this minimal, use a pre-pass to find describe block ranges by
  // brace balancing, then walk the match list in order.

  const blocks = findDescribeBlocks(source);
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const kind = m[1];
    const name = m[3] ?? "";
    const idx = m.index;
    const describesHere = blocks
      .filter((b) => b.start <= idx && idx <= b.end)
      .map((b) => b.name);
    if (kind === "describe") {
      // describe itself contributes its name to the stack; skip adding it as a test id
      continue;
    }
    // it / test → build id
    const parts = [filePath, ...describesHere, name];
    ids.push(parts.join(" > "));
  }

  if (ids.length === 0) {
    ids.push(`${filePath} > (no tests parsed — review generated file)`);
  }
  // Deduplicate while preserving order
  return Array.from(new Set(ids));
}

function findDescribeBlocks(
  source: string
): Array<{ name: string; start: number; end: number }> {
  const blocks: Array<{ name: string; start: number; end: number }> = [];
  const describeRe = /\bdescribe\s*\(\s*(['"])((?:\\.|[^\\])*?)\1\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = describeRe.exec(source)) !== null) {
    const name = m[2] ?? "";
    // Find the opening `{` of the describe's callback body
    const open = source.indexOf("{", m.index);
    if (open === -1) continue;
    let depth = 1;
    let i = open + 1;
    while (i < source.length && depth > 0) {
      const c = source[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === "/" && source[i + 1] === "/") {
        // line comment — skip to EOL
        while (i < source.length && source[i] !== "\n") i++;
      } else if (c === "/" && source[i + 1] === "*") {
        // block comment
        i += 2;
        while (i < source.length - 1 && !(source[i] === "*" && source[i + 1] === "/")) i++;
        i += 2;
        continue;
      } else if (c === '"' || c === "'" || c === "`") {
        // skip string literal
        const quote = c;
        i++;
        while (i < source.length && source[i] !== quote) {
          if (source[i] === "\\") i++;
          i++;
        }
      }
      i++;
    }
    blocks.push({ name, start: m.index, end: i });
  }
  return blocks;
}

function writeFileAt(repoRoot: string, rel: string, content: string): void {
  const full = join(repoRoot, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function removeIfExists(repoRoot: string, rels: string[]): number {
  let count = 0;
  for (const rel of rels) {
    const full = join(repoRoot, rel);
    if (existsSync(full)) {
      rmSync(full);
      count++;
    }
  }
  return count;
}

function buildPrBody(args: {
  generated: GeneratedArtifact[];
  removedStoryIds: string[];
}): string {
  const sections: string[] = [];
  sections.push(
    `Generated Vitest integration tests for ${args.generated.length} spec(s), written by the slowcook testgen agent.`
  );
  sections.push("");
  sections.push("## Tests added");
  for (const g of args.generated) {
    const manifestCount = g.manifest.tests.length;
    sections.push(
      `- \`story-${g.spec.story_id}\` — *${g.spec.title}* — ${manifestCount} test(s) in \`${g.testPath}\``
    );
  }
  if (args.removedStoryIds.length > 0) {
    sections.push("");
    sections.push("## Tests removed (supersede chain)");
    sections.push(
      `The following stories are superseded by specs in this PR; their frozen tests were removed as part of the same change:`
    );
    for (const id of args.removedStoryIds) {
      sections.push(`- \`story-${id}\``);
    }
    sections.push("");
    sections.push(
      `Because this PR modifies frozen paths (removing old tests + manifests), the \`override-freeze\` label is applied automatically. Reviewer can audit the supersede chain via the \`supersedes\` field on each new spec.`
    );
  }
  sections.push("");
  sections.push("---");
  sections.push("*Generated by `slowcook testgen`.*");
  return sections.join("\n");
}
