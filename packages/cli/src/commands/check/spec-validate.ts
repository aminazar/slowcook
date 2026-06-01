/**
 * `slowcook check spec [file...]` — 0.19.4-α (sc#146 finding 2).
 *
 * Re-runs the spec content validators (the same ones refine/agent.ts
 * calls in-process at emit time) against one or more on-disk spec
 * files. Designed for CI to catch drift on PRs that AMEND a spec
 * post-merge — the in-process lint never fires on amendments because
 * those go straight to git, bypassing refine.
 *
 * Three validators wrap one CLI:
 *   - validateAndRepairSpec        — token truncation / shape repair
 *   - validateEntityFieldReferences — `entity.field` ↔ auto/backend-entities.md
 *   - validateComponentReuseShape   — components_to_reuse mock mentions spec fields
 *
 * If `auto/backend-entities.md` is absent the entity-field check is
 * skipped quietly (its `parseEntityCatalog` returns empty). Same for
 * the mock reader when the mock/ tree is missing.
 *
 * Exit codes:
 *   0  — no findings across all files
 *   1  — at least one finding (printed)
 *   2  — invocation error (unreadable file, parse failure, etc.)
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, basename } from "node:path";
import YAML from "yaml";
import { schemas } from "../refine/spec-yaml.js";
import {
  validateAndRepairSpec,
  validateEntityFieldReferences,
  validateComponentReuseShape,
  validateRouteCollisions,
  type SpecValidationFinding,
} from "../refine/spec-validate.js";
import type { Spec } from "@slowcook-ai/core";

export interface SpecCheckPerFileResult {
  file: string;
  storyId: string | null;
  findings: SpecValidationFinding[];
  /** Set when the file couldn't be parsed at all (Zod / YAML failure). */
  parseError?: string;
}

export interface SpecCheckResult {
  perFile: SpecCheckPerFileResult[];
  filesChecked: number;
  totalFindings: number;
  hasParseErrors: boolean;
}

/**
 * Run the check. If `specPaths` is given, validates exactly those
 * files (used by CI which passes the PR's changed-files list). If
 * empty/undefined, scans `specs/story-*.yaml`.
 */
export function runSpecValidateCheck(
  repoRoot: string,
  specPaths?: string[]
): SpecCheckResult {
  const targets =
    specPaths && specPaths.length > 0
      ? specPaths.map((p) => (resolve(repoRoot, p)))
      : discoverSpecs(repoRoot);

  const entityCatalogPath = join(
    repoRoot,
    ".brewing",
    "repo-knowledge",
    "auto",
    "backend-entities.md"
  );
  const entityCatalogMd = existsSync(entityCatalogPath)
    ? readFileSync(entityCatalogPath, "utf8")
    : "";

  const mockReader = makeMockReader(repoRoot);

  const perFile: SpecCheckPerFileResult[] = [];
  let totalFindings = 0;
  let hasParseErrors = false;

  for (const abs of targets) {
    const rel = relative(repoRoot, abs);
    const storyId = extractStoryId(rel);
    if (!existsSync(abs)) {
      perFile.push({
        file: rel,
        storyId,
        findings: [],
        parseError: "file not found",
      });
      hasParseErrors = true;
      continue;
    }
    let spec: Spec;
    try {
      const raw = YAML.parse(readFileSync(abs, "utf8"));
      const parsed = schemas.Spec.safeParse(raw);
      if (!parsed.success) {
        perFile.push({
          file: rel,
          storyId,
          findings: [],
          parseError: parsed.error.issues
            .map((i) => `${String(i.path.join("."))}: ${i.message}`)
            .join("; "),
        });
        hasParseErrors = true;
        continue;
      }
      spec = parsed.data as Spec;
    } catch (err) {
      perFile.push({
        file: rel,
        storyId,
        findings: [],
        parseError: err instanceof Error ? err.message : String(err),
      });
      hasParseErrors = true;
      continue;
    }

    const findings: SpecValidationFinding[] = [];
    findings.push(...validateAndRepairSpec(spec));
    if (entityCatalogMd) {
      findings.push(...validateEntityFieldReferences(spec, entityCatalogMd));
    }
    findings.push(...validateComponentReuseShape(spec, mockReader));
    // 0.19.4-α+ (sc#151 finding 3) — route-file collision check
    findings.push(
      ...validateRouteCollisions(spec, (relPath) =>
        existsSync(resolve(repoRoot, relPath))
      )
    );

    totalFindings += findings.length;
    perFile.push({ file: rel, storyId, findings });
  }

  return {
    perFile,
    filesChecked: targets.length,
    totalFindings,
    hasParseErrors,
  };
}

function discoverSpecs(repoRoot: string): string[] {
  const specsDir = join(repoRoot, "specs");
  if (!existsSync(specsDir)) return [];
  return readdirSync(specsDir)
    .filter((f) => f.startsWith("story-") && f.endsWith(".yaml"))
    .map((f) => join(specsDir, f));
}

function extractStoryId(relPath: string): string | null {
  const m = basename(relPath).match(/^story-(.+)\.yaml$/);
  return m ? m[1]! : null;
}

function makeMockReader(repoRoot: string): (path: string) => string | null {
  return (path: string) => {
    const abs = resolve(repoRoot, path);
    if (!existsSync(abs)) return null;
    try {
      if (statSync(abs).isFile()) return readFileSync(abs, "utf8");
    } catch {
      return null;
    }
    return null;
  };
}

/** CLI wrapper. Wraps `runSpecValidateCheck`, prints, exits. */
export function runSpecValidateCli(argv: string[]): void {
  let cwd = process.cwd();
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--cwd" && argv[i + 1]) {
      cwd = argv[i + 1]!;
      i++;
      continue;
    }
    if (a === "--help" || a === "-h") {
      printHelp();
      return;
    }
    files.push(a);
  }
  const result = runSpecValidateCheck(cwd, files);
  if (result.filesChecked === 0) {
    console.log(
      `slowcook check spec: no spec files matched (expected specs/story-*.yaml or explicit paths).`
    );
    return;
  }

  let exitCode = 0;
  for (const f of result.perFile) {
    if (f.parseError) {
      console.error(`FAIL ${f.file} — parse error: ${f.parseError}`);
      exitCode = 2;
      continue;
    }
    if (f.findings.length === 0) {
      console.log(`PASS ${f.file}`);
      continue;
    }
    console.error(`FAIL ${f.file} — ${f.findings.length} finding(s):`);
    for (const finding of f.findings) {
      console.error(
        `  [${finding.action}] ${finding.path} — ${finding.message}`
      );
    }
    if (exitCode === 0) exitCode = 1;
  }
  console.error("");
  console.error(
    `slowcook check spec: ${result.totalFindings} finding(s) across ${result.filesChecked} file(s).`
  );
  if (exitCode !== 0) process.exit(exitCode);
}

function printHelp(): void {
  console.log(`
slowcook check spec — re-run spec content validators on PRs that touch specs/story-*.yaml

Usage:
  slowcook check spec [file...] [--cwd <path>]

Files default to specs/story-*.yaml when none are passed. CI workflows
should pass the PR's changed-files list so the check stays narrow.

Validators run:
  - validateAndRepairSpec        — token truncation / shape repair
  - validateEntityFieldReferences — entity.field references vs
                                    .brewing/repo-knowledge/auto/backend-entities.md
  - validateComponentReuseShape   — proposals.ui_layout.components_to_reuse
                                    mock-vs-spec field overlap

Auto-skips checks whose context is missing (no entity catalog → skip
entity-field check; no mock/ tree → skip reuse-shape check).

Exit codes:
  0  no findings
  1  at least one finding
  2  invocation error (parse failure, missing file)
`);
}
