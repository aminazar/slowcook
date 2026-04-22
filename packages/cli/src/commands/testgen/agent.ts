import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
  statSync,
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
import { readContextMd } from "../refine/context.js";
import { TESTGEN_SYSTEM } from "./prompts.js";

export const LABEL_TESTS_READY = "tests-ready";
export const LABEL_OVERRIDE_FREEZE = "override-freeze";

export const TESTS_INTEGRATION_DIR = "tests/integration";
export const MANIFESTS_DIR = ".brewing/manifests";
export const MOCK_HELPERS_DIR = "tests/helpers/mocks";

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
    const bundle = await generateTestBundle(spec, ctx, projectContext);
    const testPath = join(TESTS_INTEGRATION_DIR, `story-${spec.story_id}.test.ts`);

    // Tier-1 conformance gate: if the LLM slipped back to tier-0 habits
    // (inline vi.mock, fetch(), etc.), we refuse to ship the file. Halts
    // loudly here rather than quietly producing HTTP-loopback tests the
    // brewing loop can't ratchet against. The caller can re-run with a
    // different seed or hand-edit and re-run testgen.
    const violations = lintTierOneTest(testPath, bundle.testContent);
    if (violations.length > 0) {
      const details = violations
        .slice(0, 10)
        .map((v) => `  - line ${v.line}: \`${v.pattern}\` — ${v.reason}`)
        .join("\n");
      const more = violations.length > 10 ? `\n  - (+${violations.length - 10} more)` : "";
      throw new Error(
        `testgen output for story-${spec.story_id} violates tier-1 conventions (${violations.length} issue(s)):\n${details}${more}\n\n` +
          `The LLM emitted patterns banned by docs/plans/0.7-testgen-two-tier.md §4.1-§7.3. ` +
          `Re-run testgen with a different model/seed, or hand-edit the generated file to use project mock helpers.`
      );
    }

    // De-dupe stubs + helpers: skip anything whose target file exists and
    // isn't a @slowcook-stub (for stubs) or isn't empty (for helpers). This
    // lets testgen re-run safely without clobbering in-progress impls.
    const stubsToWrite = bundle.stubs.filter((s) =>
      shouldWriteStub(ctx.repoRoot, s.path)
    );
    const helpersToWrite = bundle.helpers.filter((h) =>
      shouldWriteHelper(ctx.repoRoot, h.path)
    );

    const manifestIds = extractTestIdsFromFile(testPath, bundle.testContent);
    const manifest = buildManifest({
      slowcookVersion: ctx.cliVersion,
      storyId: spec.story_id,
      tests: manifestIds.map((id) => ({ id, file: testPath })),
      suites: [{ suite: "backend", command: "npx vitest list", test_count: manifestIds.length }],
      now: ctx.now,
    });
    generated.push({
      spec,
      testPath,
      fileContents: bundle.testContent,
      manifest,
      stubs: stubsToWrite,
      helpers: helpersToWrite,
    });

    for (const superseded of spec.supersedes) {
      toRemove.push(superseded);
    }
  }

  // Apply to disk: write new, delete superseded
  for (const g of generated) {
    writeFileAt(ctx.repoRoot, g.testPath, g.fileContents);
    const manifestPath = join(MANIFESTS_DIR, `story-${g.spec.story_id}.json`);
    writeFileAt(ctx.repoRoot, manifestPath, JSON.stringify(g.manifest, null, 2) + "\n");
    for (const stub of g.stubs) {
      writeFileAt(ctx.repoRoot, stub.path, stub.contents);
    }
    for (const helper of g.helpers) {
      writeFileAt(ctx.repoRoot, helper.path, helper.contents);
    }
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
    for (const stub of g.stubs) await ctx.forge.git.stage(stub.path);
    for (const helper of g.helpers) await ctx.forge.git.stage(helper.path);
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

  // PR. `override-freeze` is ALWAYS applied: testgen is the one place
  // that legitimately adds files under `tests/` (and potentially removes
  // superseded ones), both of which are frozen-path operations by definition.
  // The reviewer still has to approve the PR; the label only tells the guard
  // to run in advisory mode.
  const labels = ["slowcook-tests", LABEL_OVERRIDE_FREEZE];

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
  stubs: Array<{ path: string; contents: string }>;
  helpers: Array<{ path: string; contents: string }>;
}

/**
 * Decide whether to write a stub file. Write when:
 *  - The target doesn't exist — most common case, new story.
 *  - The target exists but is itself a @slowcook-stub (marker on line 1).
 *    Lets testgen re-runs refresh stubs as spec evolves.
 * Skip when:
 *  - The target exists and has real implementation (no stub marker).
 *    Could be a brownfield consumer where the route already exists, or
 *    brewing has already replaced the stub body. Either way, don't clobber.
 */
function shouldWriteStub(repoRoot: string, path: string): boolean {
  const full = join(repoRoot, path);
  if (!existsSync(full)) return true;
  try {
    const first = readFileSync(full, "utf8").split("\n")[0] ?? "";
    return first.includes("@slowcook-stub");
  } catch {
    return false;
  }
}

/**
 * Decide whether to write a helper file. Write when the target doesn't
 * exist. Never clobber an existing helper — the consumer may have
 * hand-customised it, and the generated version would lose those edits.
 * Operator can delete the file and re-run testgen to get a fresh
 * auto-generated helper.
 */
function shouldWriteHelper(repoRoot: string, path: string): boolean {
  return !existsSync(join(repoRoot, path));
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

export function buildProjectContext(repoRoot: string): string {
  const bits: string[] = [];

  // `.brewing/context.md` is the consumer's hand-authored brewing-context
  // doc — it describes project-specific testing conventions (which mocks
  // to use, tier-1 vs tier-2 layering, etc.) that testgen needs to
  // conform to. Refine already reads this file; testgen reading it too
  // is the 0.6.5 wiring called out in plans/0.7-testgen-two-tier.md §7.
  const contextMd = readContextMd(repoRoot);
  if (contextMd) {
    bits.push("### Project overview (from `.brewing/context.md`)\n");
    bits.push(contextMd.trim());
  }

  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    bits.push(`\n### package.json\n- name: ${pkg.name}`);
    if (pkg.description) bits.push(`- description: ${pkg.description}`);
    if (pkg.scripts?.test) bits.push(`- test script: ${pkg.scripts.test}`);
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
    bits.push("\nNo existing integration tests — this will be the first in the repo.");
  }

  // List existing API route files so the LLM knows NOT to emit a <stub>
  // block for them. (A route that already exists has a real impl; stubbing
  // over it would clobber production code. The consumer may also have
  // brownfield code that pre-existed slowcook adoption — listed here so
  // testgen respects what's there.)
  const appDir = join(repoRoot, "src", "app");
  if (existsSync(appDir)) {
    const routes = listAppRouterFiles(appDir).sort();
    if (routes.length > 0) {
      bits.push(
        `\n### Existing API route files (under src/app/)\n\nThese already exist — do NOT emit a \`<stub>\` block for any of them. If the test imports from one of these, assume the route file exists and skip stub generation.`
      );
      for (const r of routes.slice(0, 50)) bits.push(`- \`${r}\``);
      if (routes.length > 50) bits.push(`- … (${routes.length - 50} more)`);
    }
  }

  // List existing mock helpers so the LLM knows which to import. The
  // helper pattern is load-bearing for the future record-and-replay swap
  // (plans/0.7-testgen-two-tier.md §4.3). Helpers NOT listed here will
  // be auto-generated by testgen B2 as <helper> blocks.
  const helpersDir = join(repoRoot, MOCK_HELPERS_DIR);
  if (existsSync(helpersDir)) {
    const helpers = readdirSync(helpersDir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => !f.endsWith(".test.ts"));
    if (helpers.length > 0) {
      bits.push(
        `\n### Available mock helpers at \`${MOCK_HELPERS_DIR}/\`\n\nThe generated test MUST import from these. Do not write inline \`vi.mock\` — use these helpers instead.`
      );
      for (const f of helpers) {
        const p = join(helpersDir, f);
        try {
          const content = readFileSync(p, "utf8");
          // Trim to first ~50 lines so the prompt stays small
          const excerpt = content.split("\n").slice(0, 50).join("\n");
          bits.push(`\n#### \`${MOCK_HELPERS_DIR}/${f}\`\n\n\`\`\`ts\n${excerpt}\n\`\`\``);
        } catch {
          /* ignore */
        }
      }
    } else {
      bits.push(
        `\n### Mock helpers\n\nDirectory \`${MOCK_HELPERS_DIR}/\` exists but is empty. You will likely need to emit \`TODO(helper):\` comments for any service the handler consumes, so an operator can hand-author the helpers before brewing can run.`
      );
    }
  } else {
    bits.push(
      `\n### Mock helpers\n\nNo \`${MOCK_HELPERS_DIR}/\` directory yet — this project hasn't set up the helper pattern. Emit a \`<helper>\` block for each external dependency the handler calls, matching the helper-file shape in the system prompt. Also emit a \`<helper path="${MOCK_HELPERS_DIR}/index.ts">\` barrel re-exporting your new helpers.`
    );
  }

  return bits.join("\n");
}

/**
 * Walk src/app/ and return every route file path (repo-relative) that
 * Next.js App Router treats as an endpoint. We surface these to the
 * testgen LLM so it doesn't emit a <stub> for a file that already
 * exists.
 */
function listAppRouterFiles(appDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile() && /^(route|page)\.(ts|tsx)$/.test(name)) {
        // Return repo-relative path. Parent dirs up to "src/app" are derivable
        // from appDir; we trim appDir and prefix "src/app".
        const rel = full.slice(full.indexOf("src/app"));
        out.push(rel);
      }
    }
  };
  walk(appDir);
  return out;
}

/**
 * Phase B2 (0.7.0) testgen output: one test file, zero-or-more route stubs,
 * zero-or-more mock helpers. The LLM emits these as XML-tagged blocks
 * (see TESTGEN_SYSTEM for the exact format); slowcook parses, de-duplicates
 * against existing files, and writes only what's new.
 */
export interface TestgenBundle {
  testContent: string;
  stubs: Array<{ path: string; contents: string }>;
  helpers: Array<{ path: string; contents: string }>;
}

async function generateTestBundle(
  spec: Spec,
  ctx: TestgenContext,
  projectContext: string
): Promise<TestgenBundle> {
  const systemPrompt = TESTGEN_SYSTEM(projectContext);
  const userMessage = `Here is the spec YAML. Generate the tier-1 test bundle (test file + any needed stubs + any needed helpers):\n\n\`\`\`yaml\n${YAML.stringify(spec)}\n\`\`\``;

  const raw = await ctx.llm.complete({
    system: systemPrompt,
    cacheSystem: true,
    model: ctx.model,
    messages: [{ role: "user", content: userMessage }],
    maxTokens: 16384,
  });

  return parseTestgenBundle(raw, spec.story_id);
}

/**
 * Parse XML-tagged multi-artifact output into a TestgenBundle.
 *
 * Accepted shape (from the prompt):
 *   <test_file>...</test_file>
 *   <stub path="src/app/api/foo/route.ts">...</stub>   (zero or more)
 *   <helper path="tests/helpers/mocks/bar.ts">...</helper>  (zero or more)
 *
 * Tolerant of code-fenced output: if the LLM wraps the whole thing in
 * ```, we strip it. If a block's contents are themselves code-fenced,
 * we strip those too — tier-1 test / helper / stub files are raw TS.
 *
 * Throws if `<test_file>` is missing or empty — that's the one mandatory
 * artifact.
 */
export function parseTestgenBundle(raw: string, storyId: string): TestgenBundle {
  const trimmed = raw.trim();
  // Strip outer code fence if the LLM wrapped everything
  const outerFenceMatch = trimmed.match(/^```[a-z]*\s*\n([\s\S]*)\n```$/);
  const body = outerFenceMatch && outerFenceMatch[1] ? outerFenceMatch[1] : trimmed;

  const testMatch = body.match(/<test_file>([\s\S]*?)<\/test_file>/);
  if (!testMatch || !testMatch[1]) {
    throw new Error(
      `testgen: LLM output for story-${storyId} missing a <test_file> block. ` +
        `Got ${body.length} chars starting with: ${body.slice(0, 120)}...`
    );
  }
  const testContent = stripInnerFence(testMatch[1]);

  const stubs: Array<{ path: string; contents: string }> = [];
  const stubRe = /<stub\s+path="([^"]+)">([\s\S]*?)<\/stub>/g;
  let m: RegExpExecArray | null;
  while ((m = stubRe.exec(body)) !== null) {
    const p = m[1] ?? "";
    const c = m[2] ?? "";
    if (p && c.trim()) stubs.push({ path: p, contents: stripInnerFence(c) });
  }

  const helpers: Array<{ path: string; contents: string }> = [];
  const helperRe = /<helper\s+path="([^"]+)">([\s\S]*?)<\/helper>/g;
  while ((m = helperRe.exec(body)) !== null) {
    const p = m[1] ?? "";
    const c = m[2] ?? "";
    if (p && c.trim()) helpers.push({ path: p, contents: stripInnerFence(c) });
  }

  return { testContent, stubs, helpers };
}

function stripInnerFence(raw: string): string {
  const t = raw.trim();
  const fence = t.match(/^```(?:typescript|ts|tsx)?\s*\n([\s\S]*)\n```$/);
  if (fence && fence[1]) return fence[1];
  return t + "\n"; // ensure trailing newline for file writes
}

/**
 * Tier-1 conformance lint. Run on every generated test file before commit.
 * Catches patterns the prompt forbids — inline `vi.mock`, `fetch(...)`,
 * HTTP-loopback mocking libraries, and skipped tests. These slip through
 * when the LLM reverts to habits from tier-0 (HTTP-loopback) examples.
 *
 * Returns an array of violations (file:line:pattern:reason); empty means
 * the file is conformant. Caller decides whether violations halt the run
 * or emit a warning — in 0.6.6 they halt, because a non-conformant tier-1
 * test file defeats the whole point of the redesign.
 *
 * Sanitisation: string literals and comments are blanked before scanning
 * (same approach as extractTestIdsFromFile) so \`"uses vi.mock style"\`
 * in a JSDoc or message string doesn't trip the lint.
 */
export interface TierOneViolation {
  line: number;
  pattern: string;
  reason: string;
}

/**
 * Two scan modes:
 * - \`code\`: run against sanitised source (comments + string-literal
 *   contents blanked). Right for call-site patterns like \`vi.mock(\` —
 *   we don't want to trip on the literal string "vi.mock" inside a
 *   docstring or error message.
 * - \`raw\`: run against the original source. Right for import-specifier
 *   patterns like \`from "msw"\`, which live IN string literals by
 *   definition. Scanning sanitised source would blank the specifier and
 *   produce a false negative.
 */
const TIER1_FORBIDDEN_PATTERNS: Array<{
  pattern: RegExp;
  label: string;
  reason: string;
  scan: "code" | "raw";
}> = [
  {
    // Bans the factory form: `vi.mock("path", () => ({...}))` — the
    // 2-arg variant where an inline fake is constructed. Allows the
    // 1-arg auto-mock form `vi.mock("path")` which is required to
    // replace the real module so helpers can inject a fake client.
    pattern: /\bvi\.mock\s*\(\s*['"][^'"]+['"]\s*,/g,
    label: "vi.mock(path, factory)",
    reason: "the 2-arg factory form constructs the fake inline. Use `vi.mock(path)` (auto-mock, no factory) to replace the module, then inject via `vi.mocked(fn).mockReturnValue(mockSupabase(...))`.",
    scan: "code",
  },
  {
    pattern: /\bvi\.fn\s*\(/g,
    label: "vi.fn(",
    reason: "helpers encapsulate fakes; tests supply intent, not function bodies. If a legitimate spy is needed (e.g. for a callback the code calls), move it into a helper.",
    scan: "code",
  },
  {
    pattern: /\bjest\.(mock|fn)\s*\(/g,
    label: "jest.mock/fn(",
    reason: "wrong framework (use Vitest), also banned for consistency",
    scan: "code",
  },
  {
    pattern: /\bfetch\s*\(/g,
    label: "fetch(",
    reason: "tier-1 tests run in-process — construct a Request and pass it to the handler, do not hit HTTP",
    scan: "code",
  },
  {
    pattern: /\b(test|it)\.(skip|todo)\s*\(/g,
    label: "test.skip/todo (or it.skip/todo)",
    reason: "skipped tests break the manifest; use TODO(spec) comments or drop the test entirely",
    scan: "code",
  },
  {
    pattern: /^\s*import\b[\s\S]*?from\s+['"](msw|nock|aws-sdk-client-mock|@mswjs\/[^'"]+)['"]/gm,
    label: "HTTP mock library import",
    reason: "tier-1 mocks go through project helpers, not HTTP-level libraries",
    scan: "raw",
  },
];

export function lintTierOneTest(filePath: string, source: string): TierOneViolation[] {
  void filePath;
  const sanitised = sanitiseForParsing(source);
  const violations: TierOneViolation[] = [];

  for (const { pattern, label, reason, scan } of TIER1_FORBIDDEN_PATTERNS) {
    const target = scan === "raw" ? source : sanitised;
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(target)) !== null) {
      const line = target.slice(0, m.index).split("\n").length;
      violations.push({ line, pattern: label, reason });
    }
  }
  return violations;
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
  // Strip comments and blank string-literal contents so commented-out or
  // string-embedded `describe`/`it` don't register. Offsets are preserved
  // so block ranges stay valid against the original source — we use the
  // original source only to re-extract real names at matched offsets.
  const sanitised = sanitiseForParsing(source);

  const ids: string[] = [];
  const re = /\b(describe|it|test)\s*\(\s*(['"])((?:\\.|[^\\])*?)\2/g;
  const blocks = findDescribeBlocks(source, sanitised);

  let m: RegExpExecArray | null;
  while ((m = re.exec(sanitised)) !== null) {
    const kind = m[1];
    const idx = m.index;
    const name = extractNameAtOffset(source, idx);
    if (name === null || kind === "describe") continue;
    const describesHere = blocks
      .filter((b) => b.start <= idx && idx <= b.end)
      .map((b) => b.name);
    const parts = [filePath, ...describesHere, name];
    ids.push(parts.join(" > "));
  }

  if (ids.length === 0) {
    ids.push(`${filePath} > (no tests parsed — review generated file)`);
  }
  return Array.from(new Set(ids));
}

function extractNameAtOffset(source: string, offset: number): string | null {
  const re = /\b(describe|it|test)\s*\(\s*(['"])((?:\\.|[^\\])*?)\2/;
  const m = re.exec(source.slice(offset, offset + 1000));
  return m?.[3] ?? null;
}

/**
 * Produce a version of the source where:
 *   - `//` and `/* ... *\/` comments are replaced with space of equal length
 *   - contents of string literals (single/double/template quotes) are replaced
 *     with non-`d`/`i`/`t` filler so the regex scan can't match inside them.
 * Offsets are preserved so block-range calculations stay valid against the
 * original source.
 */
function sanitiseForParsing(src: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      // line comment — blank out to EOL (keep the newline)
      while (i < src.length && src[i] !== "\n") {
        out.push(" ");
        i++;
      }
    } else if (c === "/" && next === "*") {
      // block comment — blank out to matching */
      out.push(" ", " ");
      i += 2;
      while (i < src.length - 1 && !(src[i] === "*" && src[i + 1] === "/")) {
        out.push(src[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < src.length - 1) {
        out.push(" ", " ");
        i += 2;
      }
    } else if (c === '"' || c === "'" || c === "`") {
      // string literal — keep quotes, blank contents (preserve newlines)
      out.push(c);
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < src.length) {
          out.push(" ", " ");
          i += 2;
        } else {
          out.push(src[i] === "\n" ? "\n" : " ");
          i++;
        }
      }
      if (i < src.length) {
        out.push(quote);
        i++;
      }
    } else {
      out.push(c as string);
      i++;
    }
  }
  return out.join("");
}

/**
 * Find `describe(...)` blocks in sanitised source (comments + string contents
 * blanked). Brace balancing is safe there — no braces inside strings or
 * comments to confuse it. Names are re-read from the ORIGINAL source at the
 * matched offset so the describe titles survive sanitisation.
 */
function findDescribeBlocks(
  source: string,
  sanitised: string
): Array<{ name: string; start: number; end: number }> {
  const blocks: Array<{ name: string; start: number; end: number }> = [];
  const describeRe = /\bdescribe\s*\(\s*(['"])((?:\\.|[^\\])*?)\1\s*,/g;
  let m: RegExpExecArray | null;
  while ((m = describeRe.exec(sanitised)) !== null) {
    const name = extractNameAtOffset(source, m.index) ?? "";
    const open = sanitised.indexOf("{", m.index);
    if (open === -1) continue;
    let depth = 1;
    let i = open + 1;
    while (i < sanitised.length && depth > 0) {
      if (sanitised[i] === "{") depth++;
      else if (sanitised[i] === "}") depth--;
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

  const allStubs = args.generated.flatMap((g) => g.stubs);
  if (allStubs.length > 0) {
    sections.push("");
    sections.push("## Generated stubs (route files)");
    sections.push(
      "Minimal throwing route files so tier-1 tests can collect. Each carries an \`@slowcook-stub\` marker on line 1. **Brewing will replace these bodies** with the real implementation across its iterations. Reviewer check: correct file path + export signature + \`@slowcook-stub\` marker present. If the signature is wrong the whole PR is wrong — flag it now."
    );
    for (const s of allStubs) {
      sections.push(`- \`${s.path}\``);
    }
  }

  const allHelpers = args.generated.flatMap((g) => g.helpers);
  if (allHelpers.length > 0) {
    sections.push("");
    sections.push("## Generated mock helpers");
    sections.push(
      "Signature-asserting fakes for external services the handlers consume. **Three load-bearing properties**: (1) calling the real module's exported function with wrong args throws loudly (catches the class of bug where tests pass via mock-arg-ignoring but production crashes); (2) every chained method pushes to \`client.calls\` so tests assert against that instead of poking \`vi.fn\` internals; (3) config is intent-level (\`user\`, \`tables\`) not implementation-level (\`return_value_for_from\`). Reviewer check: the \`realShaped*\` wrapper exists AND matches the real module's signature from \`src/\`."
    );
    for (const h of allHelpers) {
      sections.push(`- \`${h.path}\``);
    }
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
