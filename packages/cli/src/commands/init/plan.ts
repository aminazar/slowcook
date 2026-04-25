// Pure planning logic for `slowcook init`. Takes a snapshot of the filesystem
// (via an injected reader), returns the planned actions. No I/O side effects
// here — all writes happen in the CLI wrapper so this is trivially testable.

import {
  frozenPathsJson,
  brewingReadme,
  contextMdTemplate,
  patternsReadme,
  slowcookCliVersionFile,
  preCommitHook,
  codeownersFullFile,
  codeownersSection,
  gitkeep,
  gitignoreSection,
  CLI_VERSION_FOR_TEMPLATES,
  SLOWCOOK_CLI_VERSION_FILE,
  SLOWCOOK_CODEOWNERS_MARKER_BEGIN,
  SLOWCOOK_CODEOWNERS_MARKER_END,
  SLOWCOOK_GITIGNORE_MARKER_BEGIN,
  SLOWCOOK_GITIGNORE_MARKER_END,
  type TemplateParams,
} from "./templates.js";
import { getGitHubCiArtifacts } from "@slowcook-ai/forge-github";
import {
  getTsStackConfig,
  getTsUiTestingHelpers,
  getTsUiDevDependencies,
} from "@slowcook-ai/stack-ts";

export interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

export interface DetectedStack {
  language: "typescript";
  hasVitest: boolean;
  hasPlaywright: boolean;
}

/** Minimal filesystem reader so planning is pure. */
export interface FileReader {
  exists(path: string): boolean;
  read(path: string): string;
}

export interface PlanOptions {
  /** Consumer project root (where package.json lives). */
  cwd: string;
  /** CODEOWNERS handle/team (e.g., "@aminazar"). */
  owner: string;
  /** Overwrite existing files (default: skip-if-exists). */
  force: boolean;
  /** Version of the CLI invoking init; drives the CI workflow pin. */
  cliVersion?: string;
}

export type FileAction =
  | { kind: "create"; path: string; contents: string }
  | { kind: "skip-exists"; path: string; reason: string }
  | { kind: "overwrite"; path: string; contents: string }
  | { kind: "append"; path: string; contents: string; existingContents: string }
  | { kind: "conflict"; path: string; reason: string };

export interface Plan {
  detected: DetectedStack;
  actions: FileAction[];
  warnings: string[];
}

const TARGETS = {
  frozenPaths: ".brewing/frozen-paths.json",
  stack: ".brewing/stack.json",
  brewingReadme: ".brewing/README.md",
  contextMd: ".brewing/context.md",
  cliVersion: SLOWCOOK_CLI_VERSION_FILE,
  manifestsGitkeep: ".brewing/manifests/.gitkeep",
  patternsReadme: ".brewing/patterns/README.md",
  preCommitHook: ".githooks/pre-commit",
  codeowners: "CODEOWNERS",
  gitignore: ".gitignore",
  packageJson: "package.json",
};

export function detectStack(pkg: PackageJson): DetectedStack {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  return {
    language: "typescript",
    hasVitest: "vitest" in deps,
    hasPlaywright: "@playwright/test" in deps || "playwright" in deps,
  };
}

export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InitError";
  }
}

export function buildPlan(reader: FileReader, options: PlanOptions): Plan {
  if (!reader.exists(TARGETS.packageJson)) {
    throw new InitError(
      `No package.json found at ${options.cwd}. \`slowcook init\` expects to run in a TS/JS project root.`
    );
  }
  let pkg: PackageJson;
  try {
    pkg = JSON.parse(reader.read(TARGETS.packageJson));
  } catch (e) {
    throw new InitError(`package.json is not valid JSON: ${(e as Error).message}`);
  }

  const detected = detectStack(pkg);
  const warnings: string[] = [];
  const actions: FileAction[] = [];
  const cliVersion = options.cliVersion ?? CLI_VERSION_FOR_TEMPLATES;

  if (!detected.hasVitest) {
    throw new InitError(
      `No test runner detected. slowcook 0.3 requires Vitest (found in devDependencies). ` +
        `Install it with \`npm i -D vitest\` and re-run.`
    );
  }

  if (detected.hasPlaywright) {
    warnings.push(
      "Playwright detected. slowcook 0.3 doesn't yet implement Playwright discovery, " +
        "so the e2e suite is intentionally omitted from stack.json. Add it back when " +
        "playwright discovery ships in a later slowcook release."
    );
  }

  const tmplParams: TemplateParams = {
    owner: options.owner,
    hasPlaywright: detected.hasPlaywright,
  };

  // 1. .brewing/frozen-paths.json
  addSimpleFile(actions, reader, options.force, TARGETS.frozenPaths, frozenPathsJson());

  // 2. .brewing/stack.json
  addSimpleFile(
    actions,
    reader,
    options.force,
    TARGETS.stack,
    getTsStackConfig({ hasPlaywright: tmplParams.hasPlaywright })
  );

  // 3. .brewing/README.md
  addSimpleFile(actions, reader, options.force, TARGETS.brewingReadme, brewingReadme());

  // 3b. .brewing/context.md (project context for agents)
  addSimpleFile(actions, reader, options.force, TARGETS.contextMd, contextMdTemplate());

  // 3c. .brewing/slowcook-cli-version — single-source-of-truth pin file.
  // Workflows resolve $SLOWCOOK_CLI from this at run time, so bumping the
  // version is a one-file edit rather than N workflow sed-edits.
  addSimpleFile(
    actions,
    reader,
    options.force,
    TARGETS.cliVersion,
    slowcookCliVersionFile(cliVersion)
  );

  // 4. .brewing/manifests/.gitkeep (only if we're creating the dir)
  if (!reader.exists(".brewing/manifests/")) {
    actions.push({ kind: "create", path: TARGETS.manifestsGitkeep, contents: gitkeep() });
  }

  // 4b. .brewing/patterns/README.md (Phase 2C, 0.12.12+) — onboarding
  // doc for the team-authored patterns directory. brew loads the index
  // (title + summary per pattern) into its cached prefix, agent reads
  // bodies on-demand. Empty directory = empty index = no-op.
  addSimpleFile(
    actions,
    reader,
    options.force,
    TARGETS.patternsReadme,
    patternsReadme()
  );

  // 5. CI workflows are provided by the forge adapter. Today only GitHub
  // is wired; future forges (GitLab, Gitea) supply their own via a
  // similar static export. See packages/forge-github/src/templates.ts.
  for (const artifact of getGitHubCiArtifacts({ cliVersion })) {
    addSimpleFile(actions, reader, options.force, artifact.path, artifact.contents);
  }

  // 5d. Tier-1 UI testing helpers (0.7.5+). One-time-per-repo render /
  // fetch / a11y utilities that UI tests import. Each file has a
  // `@slowcook-one-time-scaffold` marker on line 1 — init --force
  // overwrites only when the marker is still present (preserves
  // consumer customisations). Consumer must add the devDependencies
  // listed in `getTsUiDevDependencies()` + route .tsx tests to jsdom
  // via vitest.config.ts `environmentMatchGlobs`; init prints both
  // as post-run instructions since slowcook doesn't own those files.
  for (const artifact of getTsUiTestingHelpers()) {
    addSimpleFile(actions, reader, options.force, artifact.path, artifact.contents);
  }

  // 5e. .githooks/pre-commit — forces code-map regen on src/ commits.
  // Activation per clone: `git config core.hooksPath .githooks`. Without
  // this hook, contributors hit the stale-map CI failure on every PR
  // that touches src/ and have to rebase-fixup. Generated file is
  // executable; init writes the mode below.
  addSimpleFile(
    actions,
    reader,
    options.force,
    TARGETS.preCommitHook,
    preCommitHook()
  );

  // 6. CODEOWNERS — special case (append if exists without our markers)
  actions.push(planCodeowners(reader, options, tmplParams));

  // 7. .gitignore — append slowcook's derived-data patterns (0.12.4+).
  // Same idempotent-marker pattern as CODEOWNERS so re-running init
  // doesn't trample consumer-added patterns elsewhere in the file.
  actions.push(planGitignore(reader, options));

  return { detected, actions, warnings };
}

function addSimpleFile(
  actions: FileAction[],
  reader: FileReader,
  force: boolean,
  path: string,
  contents: string
): void {
  if (!reader.exists(path)) {
    actions.push({ kind: "create", path, contents });
    return;
  }
  const existing = reader.read(path);
  if (existing === contents) {
    actions.push({ kind: "skip-exists", path, reason: "file already matches template" });
    return;
  }
  if (force) {
    actions.push({ kind: "overwrite", path, contents });
    return;
  }
  actions.push({
    kind: "skip-exists",
    path,
    reason: "file exists and differs from template (use --force to overwrite)",
  });
}

function planCodeowners(
  reader: FileReader,
  options: PlanOptions,
  params: TemplateParams
): FileAction {
  const path = TARGETS.codeowners;
  if (!reader.exists(path)) {
    return { kind: "create", path, contents: codeownersFullFile(params) };
  }
  const existing = reader.read(path);
  if (
    existing.includes(SLOWCOOK_CODEOWNERS_MARKER_BEGIN) &&
    existing.includes(SLOWCOOK_CODEOWNERS_MARKER_END)
  ) {
    if (options.force) {
      // Replace the slowcook section inline
      const replaced = replaceCodeownersSection(existing, params);
      return { kind: "overwrite", path, contents: replaced };
    }
    return {
      kind: "skip-exists",
      path,
      reason: "slowcook section already present (use --force to regenerate)",
    };
  }
  // Existing CODEOWNERS without our markers → append
  const toAppend =
    (existing.endsWith("\n") ? existing : existing + "\n") +
    "\n" +
    codeownersSection(params);
  return {
    kind: "append",
    path,
    contents: toAppend,
    existingContents: existing,
  };
}

function replaceCodeownersSection(existing: string, params: TemplateParams): string {
  const begin = existing.indexOf(SLOWCOOK_CODEOWNERS_MARKER_BEGIN);
  const endMarkerStart = existing.indexOf(SLOWCOOK_CODEOWNERS_MARKER_END);
  if (begin === -1 || endMarkerStart === -1 || endMarkerStart < begin) {
    // Shouldn't happen if caller verified markers exist, but be defensive
    return existing + "\n" + codeownersSection(params);
  }
  const endMarkerEnd = endMarkerStart + SLOWCOOK_CODEOWNERS_MARKER_END.length;
  // Include the trailing newline if present
  const after =
    existing[endMarkerEnd] === "\n"
      ? existing.slice(endMarkerEnd + 1)
      : existing.slice(endMarkerEnd);
  return existing.slice(0, begin) + codeownersSection(params) + after;
}

/**
 * 0.12.4+ — plan the .gitignore action. Same shape as planCodeowners:
 * create-if-missing, append-with-markers if file exists without
 * markers, skip-or-replace (under --force) when our section is
 * already present.
 */
function planGitignore(reader: FileReader, options: PlanOptions): FileAction {
  const path = TARGETS.gitignore;
  if (!reader.exists(path)) {
    return { kind: "create", path, contents: gitignoreSection() };
  }
  const existing = reader.read(path);
  if (
    existing.includes(SLOWCOOK_GITIGNORE_MARKER_BEGIN) &&
    existing.includes(SLOWCOOK_GITIGNORE_MARKER_END)
  ) {
    if (options.force) {
      const replaced = replaceGitignoreSection(existing);
      return { kind: "overwrite", path, contents: replaced };
    }
    return {
      kind: "skip-exists",
      path,
      reason: "slowcook section already present in .gitignore (use --force to regenerate)",
    };
  }
  const toAppend =
    (existing.endsWith("\n") ? existing : existing + "\n") +
    "\n" +
    gitignoreSection();
  return {
    kind: "append",
    path,
    contents: toAppend,
    existingContents: existing,
  };
}

function replaceGitignoreSection(existing: string): string {
  const begin = existing.indexOf(SLOWCOOK_GITIGNORE_MARKER_BEGIN);
  const endMarkerStart = existing.indexOf(SLOWCOOK_GITIGNORE_MARKER_END);
  if (begin === -1 || endMarkerStart === -1 || endMarkerStart < begin) {
    return existing + "\n" + gitignoreSection();
  }
  const endMarkerEnd = endMarkerStart + SLOWCOOK_GITIGNORE_MARKER_END.length;
  const after =
    existing[endMarkerEnd] === "\n"
      ? existing.slice(endMarkerEnd + 1)
      : existing.slice(endMarkerEnd);
  return existing.slice(0, begin) + gitignoreSection() + after;
}
