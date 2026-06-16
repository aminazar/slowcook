/**
 * GUCDI — `trace check` core (pure). The keystone lint that keeps the living,
 * bidirectional requirements spine coherent. It checks PROVENANCE-COMPLETENESS,
 * not requirement-coverage: every node must have an honest "why", from one of
 *   - requirement  — a PRD initiative (`prd_ref`) or a GitHub issue (`source_issue`)
 *   - convention   — a project-global standing doc (`conventions.md`)
 *   - craft        — a genuinely novel inline-tagged decision
 * A node with NONE of these is a true orphan → error. A craft-tagged node PASSES
 * (honest provenance) and is reported for PM ratification. This neither blocks
 * legitimate craft nor forces faking a requirement (the "block-or-lie" trap).
 *
 * It NEVER demands a PRD — brownfield specs trace via `source_issue`. Pure +
 * unit-tested; the IO (reading specs / PRD / scanning the LCR) is in ./index.ts.
 *
 * See docs/plans/gucdi-greenfield.md.
 */

export type LcrProvenance =
  | { kind: "story"; id: string }
  | { kind: "convention"; ref: string }
  | { kind: "craft"; rationale: string };

/** A spec, reduced to its requirement-provenance facts. */
export interface SpecNode {
  storyId: string;
  prdAnchor?: string;
  sourceIssue?: string;
}

/** An LCR file (mock component/page) + the provenance it declares in comments. */
export interface LcrNode {
  file: string;
  provenance: LcrProvenance[];
}

export type TraceCode =
  | "dangling-prd-ref" // spec cites a PRD anchor that doesn't exist
  | "orphan-spec" // spec has no requirement provenance at all
  | "orphan-lcr" // LCR file has no provenance comment (story/convention/craft)
  | "dangling-lcr-story"; // LCR file cites a story that doesn't exist

export interface TraceViolation {
  code: TraceCode;
  subject: string;
  detail: string;
}

export interface TraceResult {
  violations: TraceViolation[];
  /** Craft decisions (not in any requirement) — the PM-ratification report. */
  craft: { file: string; rationale: string }[];
  ok: boolean;
}

/**
 * Parse provenance comments from a source file. Recognised forms (case-insensitive
 * tag, anywhere in a comment):
 *   // @story story-007   (or  // story-007)
 *   // @convention <ref>
 *   // @craft <rationale>   (or  // craft: <rationale>)
 */
export function parseLcrProvenance(source: string): LcrProvenance[] {
  const out: LcrProvenance[] = [];
  for (const m of source.matchAll(/@?story[-\s]+(story-)?(\d+)/gi)) {
    out.push({ kind: "story", id: `story-${m[2]}` });
  }
  for (const m of source.matchAll(/@?convention[:\s]+([^\n*]+?)\s*(?:\*\/|$|\n)/gi)) {
    out.push({ kind: "convention", ref: m[1]!.trim() });
  }
  for (const m of source.matchAll(/@?craft[:\s]+([^\n*]+?)\s*(?:\*\/|$|\n)/gi)) {
    out.push({ kind: "craft", rationale: m[1]!.trim() });
  }
  return out;
}

/**
 * COVERAGE — the inverse of provenance. Provenance asks "does every surface
 * trace UP to a story?"; coverage asks "does every story trace DOWN to a
 * surface?". A story with zero LCR surfaces is either a real gap (a persona /
 * requirement the mock forgot to build) or a legitimately surface-less backend
 * story (DB schema, CI). The lint can't tell those apart on its own, so it
 * REPORTS uncovered stories and only FAILS when the caller opts in
 * (`--coverage`), or when a spec marks itself surface-bearing (future
 * `expects_surface`). This is the dogfood fix for "the mock covered only one
 * persona" — every story now gets checked for a home.
 */
export interface CoverageResult {
  /** story ids (story-NNN) that no LCR file references. */
  uncovered: string[];
  coveredCount: number;
  totalStories: number;
  ok: boolean;
}

export function checkCoverage(input: { specs: SpecNode[]; lcrNodes: LcrNode[] }): CoverageResult {
  const referenced = new Set<string>();
  for (const n of input.lcrNodes) {
    for (const p of n.provenance) {
      if (p.kind === "story") referenced.add(p.id);
    }
  }
  const uncovered: string[] = [];
  for (const s of input.specs) {
    const id = `story-${s.storyId}`;
    if (!referenced.has(id)) uncovered.push(id);
  }
  return {
    uncovered,
    coveredCount: input.specs.length - uncovered.length,
    totalStories: input.specs.length,
    ok: uncovered.length === 0,
  };
}

export function checkTrace(input: {
  specs: SpecNode[];
  /** PRD initiative anchors. Empty = no PRD (brownfield) → prd-ref checks skipped. */
  prdAnchors: string[];
  lcrNodes: LcrNode[];
}): TraceResult {
  const violations: TraceViolation[] = [];
  const anchors = new Set(input.prdAnchors);
  const storyIds = new Set(input.specs.map((s) => `story-${s.storyId}`));

  for (const s of input.specs) {
    if (s.prdAnchor) {
      // Only enforce when a PRD exists; a stray prd_ref with no PRD is its own (later) concern.
      if (anchors.size > 0 && !anchors.has(s.prdAnchor)) {
        violations.push({
          code: "dangling-prd-ref",
          subject: `story-${s.storyId}`,
          detail: `prd_ref anchor '${s.prdAnchor}' is not a PRD initiative`,
        });
      }
    } else if (!s.sourceIssue) {
      violations.push({
        code: "orphan-spec",
        subject: `story-${s.storyId}`,
        detail: "no requirement provenance (neither prd_ref nor source_issue)",
      });
    }
  }

  for (const n of input.lcrNodes) {
    if (n.provenance.length === 0) {
      violations.push({
        code: "orphan-lcr",
        subject: n.file,
        detail: "no provenance comment (@story / @convention / @craft)",
      });
      continue;
    }
    for (const p of n.provenance) {
      if (p.kind === "story" && storyIds.size > 0 && !storyIds.has(p.id)) {
        violations.push({
          code: "dangling-lcr-story",
          subject: n.file,
          detail: `cites ${p.id}, which has no spec`,
        });
      }
    }
  }

  const craft = input.lcrNodes.flatMap((n) =>
    n.provenance.filter((p): p is Extract<LcrProvenance, { kind: "craft" }> => p.kind === "craft").map((p) => ({ file: n.file, rationale: p.rationale })),
  );

  return { violations, craft, ok: violations.length === 0 };
}
