// Pure planning logic for `slowcook init`. Takes a snapshot of the filesystem
// (via an injected reader), returns the planned actions. No I/O side effects
// here — all writes happen in the CLI wrapper so this is trivially testable.

import {
  frozenPathsJson,
  stackJson,
  brewingReadme,
  slowcookWorkflow,
  codeownersFullFile,
  codeownersSection,
  gitkeep,
  CLI_VERSION_FOR_TEMPLATES,
  SLOWCOOK_CODEOWNERS_MARKER_BEGIN,
  SLOWCOOK_CODEOWNERS_MARKER_END,
  type TemplateParams,
} from "./templates.js";

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
  manifestsGitkeep: ".brewing/manifests/.gitkeep",
  workflow: ".github/workflows/slowcook.yml",
  codeowners: "CODEOWNERS",
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
  addSimpleFile(actions, reader, options.force, TARGETS.stack, stackJson(tmplParams));

  // 3. .brewing/README.md
  addSimpleFile(actions, reader, options.force, TARGETS.brewingReadme, brewingReadme());

  // 4. .brewing/manifests/.gitkeep (only if we're creating the dir)
  if (!reader.exists(".brewing/manifests/")) {
    actions.push({ kind: "create", path: TARGETS.manifestsGitkeep, contents: gitkeep() });
  }

  // 5. .github/workflows/slowcook.yml
  addSimpleFile(
    actions,
    reader,
    options.force,
    TARGETS.workflow,
    slowcookWorkflow(cliVersion)
  );

  // 6. CODEOWNERS — special case (append if exists without our markers)
  actions.push(planCodeowners(reader, options, tmplParams));

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
