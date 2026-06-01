/**
 * `slowcook stories status` pure helper — 0.19.5-α (sc#146 #6).
 *
 * Cross-references the consumer's `specs/_index.yaml` against PR/label
 * facts to produce a per-story stage table. Pure function — no fs, no
 * network. The CLI wrapper (`./index.ts`) gathers the inputs.
 *
 * Stage mapping (per slowcook conventions):
 *
 * | Stage   | Slowcook label evidence       |
 * |---------|-------------------------------|
 * | refine  | a `slowcook-spec` PR exists   |
 * | testgen | a `slowcook-tests` PR exists  |
 * | vibe    | a `slowcook-mockup` PR exists |
 * | brew    | a `slowcook-brew` PR exists   |
 * | chef    | a `slowcook-chef` PR exists   |
 *
 * Per-stage cell semantics:
 *
 * - `✓`  — a PR with the matching label exists AND is merged
 * - `→`  — a PR with the matching label exists AND is open
 * - `✗`  — a PR was opened but closed unmerged
 * - `—`  — no PR found for this stage
 *
 * For consumers running the local-pipeline pattern (see
 * `docs/local-pipeline-role.md`), the slowcook labels may not be
 * applied to human-driven PRs. In that case the helper falls back
 * to matching by PR-branch-name (`slowcook/<kind>/story-N` →
 * stage=<kind>).
 *
 * Gantt-style stage-by-stage output is parked for a follow-up
 * (sc#146 #6 acceptance: "Defer the Gantt-style output to a follow-up.
 * Just ship the underlying table first.").
 */

import type { SpecIndex, SpecIndexEntry } from "@slowcook-ai/core";

export type StoriesStatusCell = "merged" | "open" | "closed_unmerged" | "absent";

export interface StoriesStatusRow {
  storyId: string;
  title: string;
  status: SpecIndexEntry["status"];
  sourceIssue: string | undefined;
  /** Per-stage status. Stages: refine / testgen / vibe / brew / chef. */
  stages: Record<"refine" | "testgen" | "vibe" | "brew" | "chef", StoriesStatusCell>;
}

export interface PullRequestFact {
  number: number;
  title: string;
  /** Source-of-truth labels on the PR. */
  labels: string[];
  /** Branch name; used as the fallback signal when labels are absent. */
  headBranch: string;
  /** "open" | "closed". */
  state: "open" | "closed";
  /** True iff the PR is closed AND was merged. */
  merged: boolean;
}

const STAGE_LABEL_MAP: Record<
  "refine" | "testgen" | "vibe" | "brew" | "chef",
  string
> = {
  refine: "slowcook-spec",
  testgen: "slowcook-tests",
  vibe: "slowcook-mockup",
  brew: "slowcook-brew",
  chef: "slowcook-chef",
};

/**
 * Branch-name → stage map, used when labels are absent (the
 * local-pipeline pattern doesn't always apply labels to human PRs).
 *
 * `slowcook/<kind>/story-N` → kind.
 */
const BRANCH_KIND_TO_STAGE: Record<string, "refine" | "testgen" | "vibe" | "brew" | "chef"> = {
  spec: "refine",
  tests: "testgen",
  mockup: "vibe",
  brew: "brew",
  chef: "chef",
};

/**
 * Build the status table for every story in the index.
 *
 * @param specIndex - the parsed `specs/_index.yaml` content
 * @param pullRequests - all PRs in the repo (merged + open + closed-unmerged).
 *                       The CLI wrapper passes the union of label-matched
 *                       results; pass an empty array if GH access is
 *                       unavailable + the row will report all stages as
 *                       absent (still useful for spec-only summary).
 */
export function buildStoriesStatus(
  specIndex: SpecIndex,
  pullRequests: PullRequestFact[]
): StoriesStatusRow[] {
  const rows: StoriesStatusRow[] = [];
  const stories = specIndex.stories ?? {};
  for (const [storyId, entry] of Object.entries(stories)) {
    rows.push({
      storyId,
      title: entry.title,
      status: entry.status,
      sourceIssue: entry.source_issue,
      stages: {
        refine: stageStateForStory(storyId, "refine", pullRequests),
        testgen: stageStateForStory(storyId, "testgen", pullRequests),
        vibe: stageStateForStory(storyId, "vibe", pullRequests),
        brew: stageStateForStory(storyId, "brew", pullRequests),
        chef: stageStateForStory(storyId, "chef", pullRequests),
      },
    });
  }
  // Sort by story id ascending (lexicographic — works because ids are
  // zero-padded strings in the convention).
  rows.sort((a, b) => a.storyId.localeCompare(b.storyId));
  return rows;
}

function stageStateForStory(
  storyId: string,
  stage: "refine" | "testgen" | "vibe" | "brew" | "chef",
  prs: PullRequestFact[]
): StoriesStatusCell {
  const label = STAGE_LABEL_MAP[stage];
  // Story id appears in PR title (slowcook bot convention) OR in branch
  // name (slowcook/<kind>/story-N pattern).
  const storyTitleRe = new RegExp(`\\bstory-${escapeRegex(storyId)}\\b`);
  const storyBranchRe = new RegExp(`/story-${escapeRegex(storyId)}(?:-|$|/)`);
  const matches = prs.filter((pr) => {
    const titleMatches = storyTitleRe.test(pr.title);
    const branchMatches = storyBranchRe.test(pr.headBranch);
    if (!titleMatches && !branchMatches) return false;
    // Stage match: label OR branch-kind fallback.
    if (pr.labels.includes(label)) return true;
    // Fallback: branch shaped slowcook/<kind>/story-N — derive stage.
    const branchKind = pr.headBranch.match(/^slowcook\/([a-z]+)\//)?.[1];
    if (branchKind && BRANCH_KIND_TO_STAGE[branchKind] === stage) return true;
    return false;
  });
  if (matches.length === 0) return "absent";
  if (matches.some((m) => m.merged)) return "merged";
  if (matches.some((m) => m.state === "open")) return "open";
  return "closed_unmerged";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Render a status row set as an ASCII-art table. Used by the CLI
 * wrapper's stdout. Pure function — no colour codes, no terminal
 * width detection.
 */
export function renderStoriesStatusTable(rows: StoriesStatusRow[]): string {
  if (rows.length === 0) return "(no stories in specs/_index.yaml)\n";
  const cellGlyph: Record<StoriesStatusCell, string> = {
    merged: "✓",
    open: "→",
    closed_unmerged: "✗",
    absent: "—",
  };
  // Column widths (story id, title — truncate title at 50 chars).
  const storyW = Math.max(5, ...rows.map((r) => r.storyId.length));
  const titleW = Math.min(
    50,
    Math.max(5, ...rows.map((r) => Math.min(50, r.title.length)))
  );
  const stageW = 8; // "testgen" is widest header (7 chars) — add 1 for spacing
  const sep = (w: number) => "─".repeat(w);
  const header =
    pad("Story", storyW) +
    "  " +
    pad("Title", titleW) +
    "  " +
    "refine".padEnd(stageW) +
    "testgen".padEnd(stageW) +
    "vibe".padEnd(stageW) +
    "brew".padEnd(stageW) +
    "chef".padEnd(stageW);
  const divider =
    sep(storyW) +
    "  " +
    sep(titleW) +
    "  " +
    sep(stageW - 1) + " " +
    sep(stageW - 1) + " " +
    sep(stageW - 1) + " " +
    sep(stageW - 1) + " " +
    sep(stageW - 1);
  const lines = [header, divider];
  for (const row of rows) {
    const truncatedTitle =
      row.title.length > titleW ? row.title.slice(0, titleW - 1) + "…" : row.title;
    lines.push(
      pad(row.storyId, storyW) +
        "  " +
        pad(truncatedTitle, titleW) +
        "  " +
        cellGlyph[row.stages.refine].padEnd(stageW) +
        cellGlyph[row.stages.testgen].padEnd(stageW) +
        cellGlyph[row.stages.vibe].padEnd(stageW) +
        cellGlyph[row.stages.brew].padEnd(stageW) +
        cellGlyph[row.stages.chef].padEnd(stageW)
    );
  }
  lines.push("");
  lines.push("Legend: ✓ merged · → open · ✗ closed-unmerged · — absent");
  return lines.join("\n") + "\n";
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}
