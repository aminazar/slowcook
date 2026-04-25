import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pickNextBugId,
  buildStubProfile,
  renderProfileAsYaml,
} from "./index.js";

function mkRepo(): string {
  return mkdtempSync(join(tmpdir(), "slowcook-investigate-"));
}

describe("pickNextBugId", () => {
  it("returns B-1 when .brewing/bug-profiles/ does not exist", () => {
    const repo = mkRepo();
    try {
      expect(pickNextBugId(repo)).toBe("B-1");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns B-1 when the directory exists but is empty", () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, ".brewing/bug-profiles"), { recursive: true });
      expect(pickNextBugId(repo)).toBe("B-1");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns max+1 from existing B-<n>.yaml files", () => {
    const repo = mkRepo();
    try {
      const dir = join(repo, ".brewing/bug-profiles");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "B-1.yaml"), "");
      writeFileSync(join(dir, "B-7.yaml"), "");
      writeFileSync(join(dir, "B-3.yaml"), "");
      expect(pickNextBugId(repo)).toBe("B-8");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("ignores non-matching files in the directory", () => {
    const repo = mkRepo();
    try {
      const dir = join(repo, ".brewing/bug-profiles");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "B-2.yaml"), "");
      writeFileSync(join(dir, "story-007.yaml"), "");
      writeFileSync(join(dir, "README.md"), "");
      expect(pickNextBugId(repo)).toBe("B-3");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("buildStubProfile + renderProfileAsYaml", () => {
  it("produces a valid profile that round-trips through YAML render + schema validation", () => {
    const profile = buildStubProfile({
      issueNumber: 135,
      issueTitle: "(issue #135)",
      bugId: "B-1",
      cliVersion: "0.13.0-alpha.2a",
      now: new Date("2026-04-25T22:30:00.000Z"),
    });
    expect(profile.schema_version).toBe(1);
    expect(profile.bug_id).toBe("B-1");
    expect(profile.source_issue).toBe("#135");
    expect(profile.status).toBe("investigated");
    expect(profile.investigated_by).toContain("alpha.2a-stub");
    expect(profile.created_at).toBe("2026-04-25T22:30:00.000Z");
  });

  it("renders a YAML document with the expected top-level keys", () => {
    const profile = buildStubProfile({
      issueNumber: 135,
      issueTitle: "test bug",
      bugId: "B-1",
      cliVersion: "0.13.0-alpha.2a",
      now: new Date("2026-04-25T22:30:00.000Z"),
    });
    const yaml = renderProfileAsYaml(profile);
    expect(yaml).toContain("$schema: ./bug-profile.schema.json");
    expect(yaml).toContain("schema_version: 1");
    expect(yaml).toContain("bug_id: B-1");
    expect(yaml).toContain('source_issue: "#135"');
    expect(yaml).toContain("symptom:");
    expect(yaml).toContain("failure_locus:");
    expect(yaml).toContain("regression_assertion:");
    expect(yaml).toContain("fix_scope:");
  });

  it("escapes quotes + backslashes in string values", () => {
    const profile = buildStubProfile({
      issueNumber: 135,
      issueTitle: 'has "quotes" and \\backslash',
      bugId: "B-1",
      cliVersion: "0.13.0",
      now: new Date(0),
    });
    const yaml = renderProfileAsYaml(profile);
    expect(yaml).toContain('title: "has \\"quotes\\" and \\\\backslash"');
  });
});
