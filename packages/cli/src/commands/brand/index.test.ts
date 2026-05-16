import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBrandConfig, buildProjectContext } from "./index.js";

function makeRepo(): string {
  return mkdtempSync(join(tmpdir(), "brand-test-"));
}

describe("brand config loader", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });

  it("returns null when .brewing/brand.yaml absent", () => {
    expect(loadBrandConfig(repo)).toBe(null);
  });

  it("parses a valid config", () => {
    mkdirSync(join(repo, ".brewing"), { recursive: true });
    writeFileSync(
      join(repo, ".brewing", "brand.yaml"),
      `schema_version: 1
name: Delgoosh
description: Mental-health platform for Persian speakers.
palette_hint: soft teals + warm corals
languages: [fa, en]
colors:
  primary: '#3BAFA0'
  accent: '#E8A07A'
`,
      "utf8",
    );
    const cfg = loadBrandConfig(repo);
    expect(cfg).not.toBe(null);
    expect(cfg!.name).toBe("Delgoosh");
    expect(cfg!.colors?.primary).toBe("#3BAFA0");
    expect(cfg!.languages).toEqual(["fa", "en"]);
  });

  it("rejects malformed hex codes", () => {
    mkdirSync(join(repo, ".brewing"), { recursive: true });
    writeFileSync(
      join(repo, ".brewing", "brand.yaml"),
      `schema_version: 1
name: X
description: Y
colors:
  primary: red
`,
      "utf8",
    );
    expect(() => loadBrandConfig(repo)).toThrow();
  });

  it("rejects missing schema_version", () => {
    mkdirSync(join(repo, ".brewing"), { recursive: true });
    writeFileSync(join(repo, ".brewing", "brand.yaml"), `name: X\ndescription: Y\n`, "utf8");
    expect(() => loadBrandConfig(repo)).toThrow();
  });

  it("defaults languages to [en] when omitted", () => {
    mkdirSync(join(repo, ".brewing"), { recursive: true });
    writeFileSync(
      join(repo, ".brewing", "brand.yaml"),
      `schema_version: 1\nname: X\ndescription: Y\n`,
      "utf8",
    );
    expect(loadBrandConfig(repo)?.languages).toEqual(["en"]);
  });
});

describe("buildProjectContext", () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });

  function args(overrides: Partial<{ briefInline: string }> = {}) {
    return {
      cwd: repo,
      refresh: false,
      dryRun: false,
      briefInline: overrides.briefInline,
      model: "claude-opus-4-7",
    } as const;
  }

  it("uses --brief when provided", () => {
    const out = buildProjectContext(repo, args({ briefInline: "Inline brief here" }));
    expect(out).toContain("Inline brief here");
    expect(out).toContain("Brand brief");
  });

  it("uses .brewing/brand.yaml when no inline brief", () => {
    mkdirSync(join(repo, ".brewing"), { recursive: true });
    writeFileSync(
      join(repo, ".brewing", "brand.yaml"),
      `schema_version: 1
name: Delgoosh
description: Mental-health platform.
palette_hint: soft teals + warm corals
languages: [fa, en]
`,
      "utf8",
    );
    const out = buildProjectContext(repo, args());
    expect(out).toContain("**Name:** Delgoosh");
    expect(out).toContain("Mental-health platform");
    expect(out).toContain("soft teals + warm corals");
    expect(out).toContain("**Languages:** fa, en");
  });

  it("emits explicit-colours block when colors set", () => {
    mkdirSync(join(repo, ".brewing"), { recursive: true });
    writeFileSync(
      join(repo, ".brewing", "brand.yaml"),
      `schema_version: 1
name: X
description: Y
colors:
  primary: '#3BAFA0'
  accent: '#E8A07A'
`,
      "utf8",
    );
    const out = buildProjectContext(repo, args());
    expect(out).toContain("Explicit colours");
    expect(out).toContain("primary: #3BAFA0");
    expect(out).toContain("accent:  #E8A07A");
  });

  it("falls back to CLAUDE.md when no brand.yaml", () => {
    writeFileSync(join(repo, "CLAUDE.md"), "# My Project\n\nMental health app.", "utf8");
    const out = buildProjectContext(repo, args());
    expect(out).toContain("best-effort context");
    expect(out).toContain("Mental health app");
  });

  it("falls back to README.md when no brand.yaml and no CLAUDE.md", () => {
    writeFileSync(join(repo, "README.md"), "# README\n\nFintech platform.", "utf8");
    const out = buildProjectContext(repo, args());
    expect(out).toContain("Fintech platform");
  });

  it("emits a 'no brief found' note when nothing exists", () => {
    const out = buildProjectContext(repo, args());
    expect(out).toContain("No brand brief found");
  });
});
