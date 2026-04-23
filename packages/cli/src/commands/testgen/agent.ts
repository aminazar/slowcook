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
import { costMarker } from "../refine/llm.js";
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

/**
 * Which artifacts testgen should emit for a given spec. Computed per-spec
 * based on what already exists on disk + whether the spec has `ui_behavior`:
 *
 * - `"full"` — neither handler tests nor UI tests exist; emit both (plus
 *   any needed stubs + helpers).
 * - `"handler-only"` — spec has no `ui_behavior`; handler tests don't exist.
 *   Emit handler test + handler stubs + helpers. This is 0.7.0 behavior.
 * - `"ui-only"` — handler tests already exist; spec has `ui_behavior`; UI
 *   tests are missing. Emit ONLY UI test + UI stubs. Use-case: 0.7.5 adoption
 *   on a brownfield story where the backend was built before UI tests existed.
 *
 * Mode is inferred by `collectTargetSpecs`; the LLM is told which mode it's
 * in via the user message so it emits only what's needed.
 */
export type TestgenMode = "full" | "handler-only" | "ui-only";

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
  const targets = collectTargetSpecs(ctx);
  if (targets.length === 0) {
    return { kind: "nothing-to-generate", reason: "no active specs without tests" };
  }

  // Produce per-spec artifacts in a scratch area; commit together at the end.
  const generated: GeneratedArtifact[] = [];
  const toRemove: string[] = [];
  // Cost accumulator — keyed by spec so per-issue comments can carry the
  // cost for THAT spec, not the whole multi-spec run.
  const costsPerSpec = new Map<string, { usd: number; tokensIn: number; tokensOut: number; cacheRead: number; cacheCreate: number; model: string }>();

  for (const { spec, mode } of targets) {
    const projectContext = buildProjectContext(ctx.repoRoot);
    const bundle = await generateTestBundle(spec, ctx, projectContext, mode);
    costsPerSpec.set(spec.story_id, {
      usd: bundle.costUsd,
      tokensIn: bundle.usage.inputTokens,
      tokensOut: bundle.usage.outputTokens,
      cacheRead: bundle.usage.cacheReadTokens,
      cacheCreate: bundle.usage.cacheCreateTokens,
      model: bundle.model,
    });
    const testPath = handlerTestPathFor(spec.story_id);
    const uiTestPath = uiTestPathFor(spec.story_id);

    // Tier-1 conformance gate for handler tests (run only when mode emits one).
    // Halts loudly if the LLM slipped back to tier-0 habits (inline vi.mock,
    // fetch(), etc.) rather than quietly producing HTTP-loopback tests the
    // brewing loop can't ratchet against.
    if (mode !== "ui-only" && bundle.testContent) {
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
    const uiStubsToWrite = bundle.uiStubs.filter((s) =>
      shouldWriteStub(ctx.repoRoot, s.path)
    );

    // Manifest: combine handler + UI test IDs. When mode is "ui-only" the
    // handler manifest already exists on disk — for simplicity we still
    // rewrite it here with the combined shape, preserving the handler IDs
    // by re-extracting from the existing file.
    const handlerIds =
      mode === "ui-only"
        ? extractTestIdsFromExistingFile(ctx.repoRoot, testPath)
        : extractTestIdsFromFile(testPath, bundle.testContent);
    const uiIds =
      mode !== "handler-only" && bundle.uiTestContent
        ? extractTestIdsFromFile(uiTestPath, bundle.uiTestContent)
        : [];
    const manifestTests = [
      ...handlerIds.map((id) => ({ id, file: testPath })),
      ...uiIds.map((id) => ({ id, file: uiTestPath })),
    ];
    const manifest = buildManifest({
      slowcookVersion: ctx.cliVersion,
      storyId: spec.story_id,
      tests: manifestTests,
      suites: [
        { suite: "backend", command: "npx vitest list", test_count: manifestTests.length },
      ],
      now: ctx.now,
    });
    generated.push({
      spec,
      mode,
      testPath: mode === "ui-only" ? "" : testPath,
      fileContents: mode === "ui-only" ? "" : bundle.testContent,
      manifest,
      stubs: stubsToWrite,
      helpers: helpersToWrite,
      uiTestPath: mode === "handler-only" ? "" : uiTestPath,
      uiFileContents: mode === "handler-only" ? "" : bundle.uiTestContent,
      uiStubs: uiStubsToWrite,
    });

    for (const superseded of spec.supersedes) {
      toRemove.push(superseded);
    }
  }

  // Apply to disk: write new, delete superseded
  for (const g of generated) {
    if (g.testPath && g.fileContents) {
      writeFileAt(ctx.repoRoot, g.testPath, g.fileContents);
    }
    const manifestPath = join(MANIFESTS_DIR, `story-${g.spec.story_id}.json`);
    writeFileAt(ctx.repoRoot, manifestPath, JSON.stringify(g.manifest, null, 2) + "\n");
    for (const stub of g.stubs) {
      writeFileAt(ctx.repoRoot, stub.path, stub.contents);
    }
    for (const helper of g.helpers) {
      writeFileAt(ctx.repoRoot, helper.path, helper.contents);
    }
    if (g.uiTestPath && g.uiFileContents) {
      writeFileAt(ctx.repoRoot, g.uiTestPath, g.uiFileContents);
    }
    for (const stub of g.uiStubs) {
      writeFileAt(ctx.repoRoot, stub.path, stub.contents);
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
    if (g.testPath) await ctx.forge.git.stage(g.testPath);
    await ctx.forge.git.stage(join(MANIFESTS_DIR, `story-${g.spec.story_id}.json`));
    for (const stub of g.stubs) await ctx.forge.git.stage(stub.path);
    for (const helper of g.helpers) await ctx.forge.git.stage(helper.path);
    if (g.uiTestPath) await ctx.forge.git.stage(g.uiTestPath);
    for (const stub of g.uiStubs) await ctx.forge.git.stage(stub.path);
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
    // Post one audit-trail comment per spec's source_issue so the issue
    // thread tells the whole pipeline story (refine posted earlier; brew
    // posts next). Best-effort — don't fail the testgen run on a bad
    // comment post.
    for (const g of generated) {
      const src = g.spec.source_issue?.match(/^#?(\d+)$/)?.[1];
      if (!src) continue;
      const testCount = g.manifest.tests.length;
      const fileParts: string[] = [];
      if (g.testPath) fileParts.push(`\`${g.testPath}\``);
      if (g.uiTestPath) fileParts.push(`\`${g.uiTestPath}\``);
      const modeNote =
        g.mode === "ui-only"
          ? " *(UI tests only — handler tests already merged)*"
          : g.mode === "full"
          ? " *(handler + UI tests)*"
          : "";
      const cost = costsPerSpec.get(g.spec.story_id);
      const marker = cost
        ? "\n\n" +
          costMarker({
            agent: "testgen",
            usd: cost.usd,
            tokensIn: cost.tokensIn,
            tokensOut: cost.tokensOut,
            cacheRead: cost.cacheRead,
            cacheCreate: cost.cacheCreate,
            model: cost.model,
          })
        : "";
      const body =
        `### slowcook · tests opened\n\n` +
        `[PR #${pr.number}](${pr.url}) — \`story-${g.spec.story_id}\`, ${testCount} test(s) in ${fileParts.join(" + ")}${modeNote}.` +
        (cost ? ` Testgen cost: $${cost.usd.toFixed(4)}.` : "") +
        `\n\nReview the test shape + stubs, merge when ready. Merge triggers \`slowcook-brew-auto\`.\n\n` +
        `---\n*Generated by \`slowcook testgen\`.*` +
        marker;
      try {
        await ctx.forge.createIssueComment(parseInt(src, 10), body);
      } catch {
        /* best effort — audit trail is nice-to-have */
      }
    }
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
  mode: TestgenMode;
  /** Handler test file path — empty string when mode is "ui-only" */
  testPath: string;
  /** Handler test file contents — empty string when mode is "ui-only" */
  fileContents: string;
  manifest: Manifest;
  stubs: Array<{ path: string; contents: string }>;
  helpers: Array<{ path: string; contents: string }>;
  /** UI test file path — empty string when mode is "handler-only" */
  uiTestPath: string;
  /** UI test file contents — empty string when mode is "handler-only" */
  uiFileContents: string;
  uiStubs: Array<{ path: string; contents: string }>;
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

export interface TargetSpec {
  spec: Spec;
  mode: TestgenMode;
}

function handlerTestPathFor(storyId: string): string {
  return join(TESTS_INTEGRATION_DIR, `story-${storyId}.test.ts`);
}

function uiTestPathFor(storyId: string): string {
  return join(TESTS_INTEGRATION_DIR, `story-${storyId}-ui.test.tsx`);
}

function specHasUiBehavior(spec: Spec): boolean {
  return !!spec.ui_behavior && Object.keys(spec.ui_behavior).length > 0;
}

function collectTargetSpecs(ctx: TestgenContext): TargetSpec[] {
  const index = readIndex(ctx.repoRoot);
  const all = Object.entries(index.stories)
    .filter(([, entry]) => entry.status === "active")
    .map(([id]) => id);

  const targetIds = ctx.specId ? [ctx.specId] : all;
  const targets: TargetSpec[] = [];

  for (const id of targetIds) {
    const handlerTestAbs = join(ctx.repoRoot, handlerTestPathFor(id));
    const uiTestAbs = join(ctx.repoRoot, uiTestPathFor(id));
    const handlerExists = existsSync(handlerTestAbs);
    const uiExists = existsSync(uiTestAbs);

    let spec: Spec;
    try {
      spec = readSpec(ctx.repoRoot, id);
    } catch {
      // spec file missing despite being in index — skip
      continue;
    }

    const hasUi = specHasUiBehavior(spec);
    const needsHandler = !handlerExists;
    const needsUi = hasUi && !uiExists;

    if (!needsHandler && !needsUi) {
      // Already has everything — skip unless explicit --spec requests it
      if (!ctx.specId) continue;
      // With --spec, we still skip if nothing's missing; there's nothing to do.
      continue;
    }

    const mode: TestgenMode =
      needsHandler && needsUi ? "full" :
      needsHandler ? "handler-only" :
      "ui-only";

    targets.push({ spec, mode });
  }
  return targets;
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

  // List existing React components + client-side pages so the LLM knows
  // NOT to emit a <ui_stub> block for a component that already exists.
  // Components live at src/components/**; client pages live at
  // src/app/**/page.tsx (or layout.tsx, though we don't usually brew layouts).
  const componentsDir = join(repoRoot, "src", "components");
  const pagesUnderApp = existsSync(appDir) ? listReactComponents(appDir) : [];
  const libComponents = existsSync(componentsDir) ? listReactComponents(componentsDir) : [];
  const allComponents = [...libComponents, ...pagesUnderApp].sort();
  if (allComponents.length > 0) {
    bits.push(
      `\n### Existing React component / page files (tsx)\n\nThese already exist — do NOT emit a \`<ui_stub>\` block for any of them. If a UI test imports one of these, assume it's real code and skip stub generation.`
    );
    for (const c of allComponents.slice(0, 50)) bits.push(`- \`${c}\``);
    if (allComponents.length > 50) bits.push(`- … (${allComponents.length - 50} more)`);
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
/**
 * Walk a React directory and return every `.tsx` file's repo-relative
 * path. Used to surface existing components + client pages so testgen
 * doesn't emit <ui_stub> blocks for files that already have real
 * implementations.
 */
function listReactComponents(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(d, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile() && name.endsWith(".tsx") && !name.endsWith(".test.tsx")) {
        const srcIdx = full.indexOf("src/");
        const rel = srcIdx >= 0 ? full.slice(srcIdx) : full;
        out.push(rel);
      }
    }
  };
  walk(dir);
  return out;
}

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
  /** Handler test file content. Empty string when mode is `"ui-only"`. */
  testContent: string;
  stubs: Array<{ path: string; contents: string }>;
  helpers: Array<{ path: string; contents: string }>;
  /** UI component test file content (tier-1 UI). Empty string when mode is `"handler-only"`. */
  uiTestContent: string;
  /** UI component stubs — React/TSX files under src/components/ or src/app/**\/*.tsx. */
  uiStubs: Array<{ path: string; contents: string }>;
}

async function generateTestBundle(
  spec: Spec,
  ctx: TestgenContext,
  projectContext: string,
  mode: TestgenMode
): Promise<TestgenBundle & { costUsd: number; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number }; model: string }> {
  const systemPrompt = TESTGEN_SYSTEM(projectContext);

  const modeInstruction: Record<TestgenMode, string> = {
    "full":
      "Generate BOTH the handler tier-1 test bundle (`<test_file>` + any `<stub>` + any `<helper>`) AND the UI tier-1 bundle (`<ui_test_file>` + any `<ui_stub>`). This story has both API and UI scope.",
    "handler-only":
      "Generate the handler tier-1 test bundle (`<test_file>` + any `<stub>` + any `<helper>`). This story has no `ui_behavior`, so do NOT emit `<ui_test_file>` or `<ui_stub>` blocks.",
    "ui-only":
      "Handler tests already exist for this story. Emit ONLY the UI tier-1 bundle: `<ui_test_file>` + any `<ui_stub>` blocks needed to make the UI tests collect. Do NOT emit `<test_file>`, `<stub>`, or `<helper>` blocks — those artifacts are already on disk and should not be regenerated.",
  };

  const userMessage =
    `${modeInstruction[mode]}\n\n` +
    `Here is the spec YAML:\n\n\`\`\`yaml\n${YAML.stringify(spec)}\n\`\`\``;

  const raw = await ctx.llm.complete({
    system: systemPrompt,
    cacheSystem: true,
    model: ctx.model,
    messages: [{ role: "user", content: userMessage }],
    maxTokens: 16384,
  });

  const bundle = parseTestgenBundle(raw.text, spec.story_id, mode);
  return {
    ...bundle,
    costUsd: raw.costUsd,
    usage: raw.usage,
    model: raw.model,
  };
}

/**
 * Parse XML-tagged multi-artifact output into a TestgenBundle.
 *
 * Accepted shape (from the prompt):
 *   <test_file>...</test_file>                    — required unless mode="ui-only"
 *   <stub path="src/app/api/foo/route.ts">...</stub>         (zero or more)
 *   <helper path="tests/helpers/mocks/bar.ts">...</helper>   (zero or more)
 *   <ui_test_file>...</ui_test_file>              — required when mode="ui-only" or "full" with UI
 *   <ui_stub path="src/components/foo.tsx">...</ui_stub>     (zero or more)
 *
 * Mode semantics (0.7.7+):
 * - `"handler-only"` — `<test_file>` required; `<ui_test_file>` ignored if present.
 * - `"ui-only"` — `<ui_test_file>` required; `<test_file>` ignored if present.
 * - `"full"` — both `<test_file>` required AND `<ui_test_file>` required.
 *
 * Tolerant of code-fenced output: if the LLM wraps the whole thing in
 * ```, we strip it. If a block's contents are themselves code-fenced,
 * we strip those too — tier-1 test / helper / stub / UI files are raw TS/TSX.
 */
export function parseTestgenBundle(
  raw: string,
  storyId: string,
  mode: TestgenMode = "handler-only"
): TestgenBundle {
  const trimmed = raw.trim();
  // Strip outer code fence if the LLM wrapped everything
  const outerFenceMatch = trimmed.match(/^```[a-z]*\s*\n([\s\S]*)\n```$/);
  const body = outerFenceMatch && outerFenceMatch[1] ? outerFenceMatch[1] : trimmed;

  const handlerRequired = mode !== "ui-only";
  const uiRequired = mode !== "handler-only";

  const testMatch = body.match(/<test_file>([\s\S]*?)<\/test_file>/);
  if (handlerRequired && (!testMatch || !testMatch[1])) {
    throw new Error(
      `testgen: LLM output for story-${storyId} missing a <test_file> block (mode=${mode}). ` +
        `Got ${body.length} chars starting with: ${body.slice(0, 120)}...`
    );
  }
  const testContent = testMatch && testMatch[1] ? stripInnerFence(testMatch[1]) : "";

  const uiTestMatch = body.match(/<ui_test_file>([\s\S]*?)<\/ui_test_file>/);
  if (uiRequired && (!uiTestMatch || !uiTestMatch[1])) {
    throw new Error(
      `testgen: LLM output for story-${storyId} missing a <ui_test_file> block (mode=${mode}). ` +
        `Got ${body.length} chars starting with: ${body.slice(0, 120)}...`
    );
  }
  const uiTestContent =
    uiTestMatch && uiTestMatch[1] ? stripInnerFence(uiTestMatch[1]) : "";

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

  const uiStubs: Array<{ path: string; contents: string }> = [];
  const uiStubRe = /<ui_stub\s+path="([^"]+)">([\s\S]*?)<\/ui_stub>/g;
  while ((m = uiStubRe.exec(body)) !== null) {
    const p = m[1] ?? "";
    const c = m[2] ?? "";
    if (p && c.trim()) uiStubs.push({ path: p, contents: stripInnerFence(c) });
  }

  return { testContent, stubs, helpers, uiTestContent, uiStubs };
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
/**
 * Read an existing test file from disk and extract its test IDs. Thin
 * wrapper around extractTestIdsFromFile for the "ui-only" code path where
 * the handler test already exists and we need its IDs to preserve in the
 * rewritten combined manifest.
 */
export function extractTestIdsFromExistingFile(
  repoRoot: string,
  filePath: string
): string[] {
  const abs = join(repoRoot, filePath);
  if (!existsSync(abs)) return [];
  try {
    const source = readFileSync(abs, "utf8");
    return extractTestIdsFromFile(filePath, source);
  } catch {
    return [];
  }
}

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
    const parts: string[] = [];
    if (g.testPath) parts.push(`\`${g.testPath}\``);
    if (g.uiTestPath) parts.push(`\`${g.uiTestPath}\``);
    const modeTag = g.mode === "ui-only" ? " *(ui-only mode — handler tests already present)*" : g.mode === "full" ? " *(handler + UI)*" : "";
    sections.push(
      `- \`story-${g.spec.story_id}\` — *${g.spec.title}* — ${manifestCount} test(s) in ${parts.join(" + ")}${modeTag}`
    );
  }

  const allUiStubs = args.generated.flatMap((g) => g.uiStubs);
  if (allUiStubs.length > 0) {
    sections.push("");
    sections.push("## Generated UI stubs (React components / pages)");
    sections.push(
      "Minimal placeholder components so tier-1 UI tests can collect. Each carries an \`@slowcook-stub\` marker on line 1. **Brewing will replace these bodies** with the real component implementation. Reviewer check: correct file path + default export present + \`@slowcook-stub\` marker intact. Signature-wrong = PR-wrong — flag it now."
    );
    for (const s of allUiStubs) {
      sections.push(`- \`${s.path}\``);
    }
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
