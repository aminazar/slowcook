import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherPatternIndex, renderPatternIndexBlock } from "./patterns.js";

function mkRepo(): string {
  return mkdtempSync(join(tmpdir(), "slowcook-patterns-"));
}

function writePattern(repo: string, slug: string, body: string): void {
  const dir = join(repo, ".brewing/patterns");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), body, "utf8");
}

describe("gatherPatternIndex", () => {
  it("returns [] when .brewing/patterns/ does not exist", () => {
    const repo = mkRepo();
    try {
      expect(gatherPatternIndex(repo)).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("returns [] when the directory exists but contains no .md files", () => {
    const repo = mkRepo();
    try {
      mkdirSync(join(repo, ".brewing/patterns"), { recursive: true });
      writeFileSync(join(repo, ".brewing/patterns/.gitkeep"), "");
      expect(gatherPatternIndex(repo)).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("extracts title (first H1) and summary (first blockquote) per file", () => {
    const repo = mkRepo();
    try {
      writePattern(
        repo,
        "cursor-pagination",
        `# Cursor pagination\n\n> One-line: paginate with (created_at, id) cursor.\n\n## When to use\n...\n`
      );
      writePattern(
        repo,
        "supabase-handler",
        `# Supabase handler\n\n> Standard handler shape with auth + RLS.\n`
      );
      const idx = gatherPatternIndex(repo);
      expect(idx).toHaveLength(2);
      // Sorted by filename slug.
      expect(idx[0]).toMatchObject({
        slug: "cursor-pagination",
        title: "Cursor pagination",
        summary: "One-line: paginate with (created_at, id) cursor.",
        path: ".brewing/patterns/cursor-pagination.md",
      });
      expect(idx[1]).toMatchObject({
        slug: "supabase-handler",
        title: "Supabase handler",
        summary: "Standard handler shape with auth + RLS.",
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("falls back to slug as title when no H1 is present", () => {
    const repo = mkRepo();
    try {
      writePattern(repo, "no-title", "Just some text without a heading.\n");
      const idx = gatherPatternIndex(repo);
      expect(idx[0]?.title).toBe("no-title");
      expect(idx[0]?.summary).toBeNull();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("ignores non-.md files in the patterns dir", () => {
    const repo = mkRepo();
    try {
      writePattern(repo, "real", "# Real\n\n> A real pattern.\n");
      writeFileSync(join(repo, ".brewing/patterns/notes.txt"), "# Not a pattern");
      const idx = gatherPatternIndex(repo);
      expect(idx.map((p) => p.slug)).toEqual(["real"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("renderPatternIndexBlock", () => {
  it("returns empty string when patterns is empty", () => {
    expect(renderPatternIndexBlock([])).toBe("");
  });

  it("renders the index as markdown bullets with title + summary + path", () => {
    const md = renderPatternIndexBlock([
      {
        slug: "cursor-pagination",
        title: "Cursor pagination",
        summary: "Use (created_at, id) cursor",
        path: ".brewing/patterns/cursor-pagination.md",
      },
      {
        slug: "no-summary",
        title: "Bare pattern",
        summary: null,
        path: ".brewing/patterns/no-summary.md",
      },
    ]);
    expect(md).toContain("### Project patterns");
    expect(md).toContain(
      "- **Cursor pagination** (`.brewing/patterns/cursor-pagination.md`) — Use (created_at, id) cursor"
    );
    // No-summary pattern: no trailing dash + summary.
    expect(md).toContain("- **Bare pattern** (`.brewing/patterns/no-summary.md`)");
    expect(md).not.toContain("Bare pattern** (`.brewing/patterns/no-summary.md`) —");
    // Tells the agent to read on-demand.
    expect(md).toContain("read_file('.brewing/patterns/<name>.md')");
  });
});
