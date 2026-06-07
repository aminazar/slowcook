import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReviewers, resolveRole } from "./reviewers.js";

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), "reviewers-test-"));
}

function writeReviewers(repo: string, body: string): void {
  mkdirSync(join(repo, ".brewing"), { recursive: true });
  writeFileSync(join(repo, ".brewing", "reviewers.yaml"), body, "utf8");
}

describe("loadReviewers", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });

  it("returns empty roster default when the file is absent", () => {
    const out = loadReviewers(repo);
    expect(out.schema_version).toBe(1);
    expect(out.roles).toEqual({});
  });

  it("parses a valid roster and lowercases handles", () => {
    writeReviewers(
      repo,
      `schema_version: 1
roles:
  pm: [AminAzar]
  designer: [Some-Designer]
  qa: [QA-Person, Another-QA]
`,
    );
    const out = loadReviewers(repo);
    expect(out.roles.pm).toEqual(["aminazar"]);
    expect(out.roles.designer).toEqual(["some-designer"]);
    expect(out.roles.qa).toEqual(["qa-person", "another-qa"]);
  });

  it("accepts a roster with no roles block (defaults to {})", () => {
    writeReviewers(repo, `schema_version: 1\n`);
    const out = loadReviewers(repo);
    expect(out.roles).toEqual({});
  });

  it("throws on schema violation (wrong schema_version)", () => {
    writeReviewers(repo, `schema_version: 2\nroles: {}\n`);
    expect(() => loadReviewers(repo)).toThrow(/reviewers\.yaml/);
  });

  it("throws on malformed yaml", () => {
    writeReviewers(repo, `schema_version: 1\nroles: [: : :\n`);
    expect(() => loadReviewers(repo)).toThrow();
  });
});

describe("resolveRole", () => {
  it("returns the configured (lowercased) handles for a role", () => {
    const cfg = { schema_version: 1 as const, roles: { qa: ["qa-person", "another-qa"] } };
    expect(resolveRole(cfg, "qa")).toEqual(["qa-person", "another-qa"]);
  });

  it("returns [] for an unknown / unset role", () => {
    const cfg = { schema_version: 1 as const, roles: { pm: ["aminazar"] } };
    expect(resolveRole(cfg, "designer")).toEqual([]);
  });

  it("returns [] for an empty roster", () => {
    expect(resolveRole({ schema_version: 1, roles: {} }, "pm")).toEqual([]);
  });
});
