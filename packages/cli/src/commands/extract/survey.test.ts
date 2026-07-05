// #262 tier 0 — deterministic survey over a real throwaway git repo.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSurvey, writeSurvey } from "./survey.js";
import { validateCitations, validateSections } from "./as-built.js";

let root: string;
const g = (args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sc-extract-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  mkdirSync(join(root, "specs"), { recursive: true });
  mkdirSync(join(root, ".brewing"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Acme\nThe product.");
  writeFileSync(join(root, "docs/ARCHITECTURE.md"), "# Architecture\nOld notes.");
  writeFileSync(join(root, ".brewing/brand.yaml"), "palette: coral\n");
  writeFileSync(join(root, "specs/story-001.yaml"), 'title: "First story"\n');
  writeFileSync(join(root, "specs/story-002.yaml"), 'title: "Second story"\n');
  writeFileSync(join(root, "specs/_index.yaml"), "stories:\n  - id: 1\n    status: active\n  - id: 2\n    status: superseded\n");
  g(["init", "-q"]);
  g(["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"]);
  // an OLD commit for the architecture doc (committer date is what %cI reads),
  // then a fresh one for the rest
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "feat: initial"], {
    cwd: root, stdio: "pipe", env: { ...process.env, GIT_COMMITTER_DATE: "2025-01-01T00:00:00Z", GIT_AUTHOR_DATE: "2025-01-01T00:00:00Z" },
  });
  writeFileSync(join(root, "README.md"), "# Acme\nThe product, updated.");
  g(["add", "-A"]);
  g(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "fix: readme refresh"]);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("extract --survey", () => {
  it("catalogs docs dated via git, aggregates story specs, reads commit evidence", () => {
    const out = runSurvey(root, new Date());
    const st = out.claims.map((c) => c.statement);
    // stale-honest dating: ARCHITECTURE.md was committed long ago
    expect(st.find((s) => s.includes("docs/ARCHITECTURE.md"))).toMatch(/months ago \(may be stale\)/);
    expect(st.find((s) => s.includes("README.md"))).toContain("recently updated");
    // brand yaml cataloged under brand
    expect(out.claims.find((c) => c.statement.includes(".brewing/brand.yaml"))!.area).toBe("brand");
    // ONE story aggregate with index statuses
    const story = st.find((s) => s.startsWith("Story history: 2 committed story specs"));
    expect(story).toContain("(1 active, 1 superseded per specs/_index.yaml)");
    expect(story).toContain("First story");
    // commit evidence present; gh gracefully skipped
    expect(st.some((s) => s.startsWith("Commit history: 2 commits"))).toBe(true);
    expect(out.skipped.some((s) => s.includes("issues/PRs"))).toBe(true);
    const file = writeSurvey(root, out);
    expect(file.endsWith(".brewing/extract-survey.json")).toBe(true);
  });
});

describe("as-built validators", () => {
  it("citation validator counts bullets and flags uncited ones outside the questions section", () => {
    const md = [
      "# acme — as-built", "",
      "## What the product is",
      "- Members share links, rationed weekly (src/lib/ration.ts:10-14)",
      "- Landing redirects authed users to /feed (src/app/(landing)/page.tsx:12)", // nested parens — real Next.js path
      "- Something asserted with no source at all",
      "## Map", "- Monorepo of three packages (pnpm-workspace.yaml)",
      "## Data model (as-built)", "- rewo_reactions is the primitive (supabase/migrations/00013.sql)",
      "## Honesty notes", "- Docs claim X but code does Y (docs/A.md, src/y.ts:9)",
      "## Founder questions (intake queue)",
      "1. Is the paid tier real?", "- follow-up bullet needs no citation here",
    ].join("\n");
    expect(validateSections(md)).toEqual([]);
    const r = validateCitations(md);
    expect(r.bullets).toBe(6);
    expect(r.uncited).toEqual(["- Something asserted with no source at all"]);
  });

  it("section validator names what's missing", () => {
    expect(validateSections("# x\n## Map\n")).toContain("## What the product is");
  });
});
