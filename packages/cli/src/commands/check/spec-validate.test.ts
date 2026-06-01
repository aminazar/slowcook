import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSpecValidateCheck } from "./spec-validate.js";

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), "sc-spec-validate-"));
}

function writeSpec(repoRoot: string, storyId: string, body: string): string {
  const dir = join(repoRoot, "specs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `story-${storyId}.yaml`);
  writeFileSync(path, body, "utf8");
  return path;
}

const MINIMAL_VALID = `\
story_id: "001"
title: "minimal spec"
status: active
created_at: "2026-06-01T00:00:00Z"
supersedes: []
superseded_by: null
actors:
  - name: patient
preconditions: []
invariants: []
acceptance_scenarios: []
non_goals: []
`;

describe("runSpecValidateCheck", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeRepo();
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("returns 0 findings + 0 files when no specs match", () => {
    const result = runSpecValidateCheck(repoRoot);
    expect(result.filesChecked).toBe(0);
    expect(result.totalFindings).toBe(0);
  });

  it("PASSes a minimal valid spec", () => {
    writeSpec(repoRoot, "001", MINIMAL_VALID);
    const result = runSpecValidateCheck(repoRoot);
    expect(result.filesChecked).toBe(1);
    expect(result.totalFindings).toBe(0);
    expect(result.hasParseErrors).toBe(false);
  });

  it("reports a parseError on malformed YAML", () => {
    writeSpec(repoRoot, "002", "this is: not[ valid {yaml");
    const result = runSpecValidateCheck(repoRoot);
    expect(result.filesChecked).toBe(1);
    expect(result.hasParseErrors).toBe(true);
    expect(result.perFile[0]!.parseError).toBeTruthy();
  });

  it("flags entity.field references that don't appear in the entity catalog", () => {
    const entityCatalogDir = join(
      repoRoot,
      ".brewing",
      "repo-knowledge",
      "auto"
    );
    mkdirSync(entityCatalogDir, { recursive: true });
    // Minimal catalog: User entity with fields firstName, lastName, email
    writeFileSync(
      join(entityCatalogDir, "backend-entities.md"),
      `## User\n\n- firstName: string\n- lastName: string\n- email: string\n`,
      "utf8"
    );

    writeSpec(
      repoRoot,
      "003",
      `\
story_id: "003"
title: "spec with hallucinated field"
status: active
created_at: "2026-06-01T00:00:00Z"
supersedes: []
superseded_by: null
actors:
  - name: patient
preconditions: []
invariants:
  - "Renders user.bogusField when present"
acceptance_scenarios: []
non_goals: []
`
    );
    const result = runSpecValidateCheck(repoRoot);
    expect(result.filesChecked).toBe(1);
    // The first occurrence of user.bogusField should produce one finding.
    expect(result.totalFindings).toBeGreaterThan(0);
    expect(result.perFile[0]!.findings.some((f) => /bogus/i.test(f.message))).toBe(true);
  });

  it("scopes to the given paths when explicit files are passed", () => {
    writeSpec(repoRoot, "010", MINIMAL_VALID);
    writeSpec(repoRoot, "011", "this is: not[ valid {yaml");
    // Only check 010 — 011's parse error should not surface.
    const result = runSpecValidateCheck(repoRoot, ["specs/story-010.yaml"]);
    expect(result.filesChecked).toBe(1);
    expect(result.hasParseErrors).toBe(false);
  });
});
