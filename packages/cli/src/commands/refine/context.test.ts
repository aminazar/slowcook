import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProjectContext, readBrownfieldExtracts, readPrdAnchors } from "./context.js";

function mkRepo(): string {
  return mkdtempSync(join(tmpdir(), "slowcook-refine-context-"));
}

describe("buildProjectContext", () => {
  it("falls back to a no-context note when nothing is present", () => {
    const repo = mkRepo();
    try {
      const out = buildProjectContext(repo);
      expect(out).toContain("Project overview");
      expect(out).toContain("No `.brewing/context.md` present");
      expect(out).not.toContain("Brownfield project awareness");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("includes context.md verbatim when present", () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, ".brewing"), { recursive: true });
      writeFileSync(
        join(repo, ".brewing/context.md"),
        "# Rewo\n\nA social link-sharing platform.\n",
        "utf8"
      );
      const out = buildProjectContext(repo);
      expect(out).toContain("Project overview");
      expect(out).toContain("A social link-sharing platform.");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("appends brownfield extracts when schema.mmd / tokens.md exist", () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, ".brewing/diagrams"), { recursive: true });
      writeFileSync(
        join(repo, ".brewing/diagrams/schema.mmd"),
        "erDiagram\n  PROFILES { uuid id }\n  REWOS { uuid id }\n",
        "utf8"
      );
      writeFileSync(
        join(repo, ".brewing/diagrams/tokens.md"),
        "# Design tokens\n\n| Token | Value |\n| --- | --- |\n| `--coral` | `#FF6B6B` |\n",
        "utf8"
      );
      const out = buildProjectContext(repo);
      expect(out).toContain("Brownfield project awareness");
      expect(out).toContain("Existing schema");
      expect(out).toContain("PROFILES");
      expect(out).toContain("Existing design tokens");
      expect(out).toContain("--coral");
      // Schema is wrapped in a ```mermaid fence so PR rendering picks it up.
      expect(out).toMatch(/```mermaid[\s\S]+erDiagram/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("readBrownfieldExtracts", () => {
  it("returns null when no extracts exist", () => {
    const repo = mkRepo();
    try {
      expect(readBrownfieldExtracts(repo)).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("includes only the extracts that exist (schema only)", () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, ".brewing/diagrams"), { recursive: true });
      writeFileSync(
        join(repo, ".brewing/diagrams/schema.mmd"),
        "erDiagram\n  PROFILES {}\n",
        "utf8"
      );
      const out = readBrownfieldExtracts(repo)!;
      expect(out).toContain("Existing schema");
      expect(out).not.toContain("Existing design tokens");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("includes only the extracts that exist (tokens only)", () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, ".brewing/diagrams"), { recursive: true });
      writeFileSync(
        join(repo, ".brewing/diagrams/tokens.md"),
        "tokens go here",
        "utf8"
      );
      const out = readBrownfieldExtracts(repo)!;
      expect(out).toContain("Existing design tokens");
      expect(out).not.toContain("Existing schema");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("readPrdAnchors", () => {
  it("extracts {#anchor} markers; empty without a PRD", () => {
    const root = mkdtempSync(join(tmpdir(), "ctx-prd-"));
    try {
      mkdirSync(join(root, "docs"), { recursive: true });
      writeFileSync(join(root, "docs", "PRD.md"), "# P {#prd}\n## 7.1 {#surface-onboarding}\n");
      expect(readPrdAnchors(root)).toEqual(["prd", "surface-onboarding"]);
      expect(readPrdAnchors(mkdtempSync(join(tmpdir(), "ctx-none-")))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
