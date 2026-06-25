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

// ── Persona/surface trace (0.21.x) — the SAME forward+inverse rules, applied to
//    the persona surfaces. A spec's `surfaces[].route` is a PROMISE that the mock
//    exposes that route; the lint checks each promise resolves to a real router
//    path (forward), and that a declared persona actually has a resolvable home
//    (so a persona can't be all-dangling). This is the persona analogue of
//    dangling-lcr-story + coverage. ─────────────────────────────────────────────
export interface SpecSurface { storyId: string; persona: string; route: string; home?: boolean }

/** A concrete surface route is satisfied by a router path when every segment
 *  matches — a param segment (`:slug`) matches anything. e.g. `/u/:handle`
 *  satisfies `/u/you`. */
export function routeSatisfies(routerPath: string, surfaceRoute: string): boolean {
  const a = routerPath.split("/").filter(Boolean);
  const b = surfaceRoute.split("/").filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg.startsWith(":") || seg === b[i]);
}

export interface SurfaceResult {
  /** declared surfaces whose route resolves to no real router path. */
  dangling: SpecSurface[];
  /** personas whose declared home route doesn't resolve (an unreachable persona). */
  unreachablePersonas: string[];
  surfaceCount: number;
  ok: boolean;
}

export function checkSurfaces(input: { surfaces: SpecSurface[]; routes: string[] }): SurfaceResult {
  const resolves = (route: string) => input.routes.some((r) => routeSatisfies(r, route));
  const dangling = input.surfaces.filter((s) => !resolves(s.route));
  const homeByPersona = new Map<string, boolean>();
  for (const s of input.surfaces) {
    if (s.home) homeByPersona.set(s.persona, resolves(s.route) || homeByPersona.get(s.persona) === true);
  }
  const unreachablePersonas = [...homeByPersona.entries()].filter(([, ok]) => !ok).map(([p]) => p);
  return { dangling, unreachablePersonas, surfaceCount: input.surfaces.length, ok: dangling.length === 0 && unreachablePersonas.length === 0 };
}

// ── PRD↔spec interdependency (0.21.x) — the deterministic floor under the
//    conversational PRD/stories review. Every spec already anchors to a PRD
//    section (`prd_ref.anchor`); we fingerprint that section's body so a PRD
//    edit becomes *detectable* (staleness) and *attributable* (impact). No LLM:
//    this tells you WHICH stories a PRD change touches; reconcile narrows to HOW.
//    See docs/plans/prd-stories-interdependency.md. ────────────────────────────

/** Normalise an anchor body so cosmetic reflow (trailing ws, blank-line runs)
 *  doesn't churn the fingerprint — only semantic edits move it. */
export function normalizeAnchorBody(body: string): string {
  return body
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Dependency-free FNV-1a (64-bit) content hash → 16-hex. Not cryptographic;
 *  it only needs to answer "did this PRD section change?". Pure + deterministic
 *  across environments (no node:crypto, keeping this module IO-free). */
export function contentHash(s: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

/** Fingerprint of a PRD anchor's body (normalised). */
export function anchorHash(body: string): string {
  return contentHash(normalizeAnchorBody(body));
}

/** Current PRD: anchor → fingerprint. */
export interface PrdAnchorState {
  anchor: string;
  hash: string;
}

/** A spec's recorded link to the PRD (anchor it was refined against + the
 *  fingerprint at stamp time, if stamped). */
export interface SpecLink {
  storyId: string;
  prdAnchor?: string;
  /** `prd_ref.sha` recorded at stamp time; absent = never stamped. */
  prdSha?: string;
}

export interface StaleSpec {
  storyId: string;
  anchor: string;
  recorded: string;
  current: string;
}

export interface FreshnessResult {
  /** specs whose recorded fingerprint ≠ the current PRD anchor (the PRD moved). */
  stale: StaleSpec[];
  /** specs that link a PRD anchor but were never stamped (unknown freshness). */
  unstamped: { storyId: string; anchor: string }[];
  freshCount: number;
}

/**
 * FRESHNESS — does each spec's recorded fingerprint still match its PRD anchor?
 * `stale` = the anchor body changed since the spec was stamped (the rot we want
 * to catch). Specs with no `prdAnchor` are skipped (orphans are `checkTrace`'s
 * job); anchors that no longer exist are skipped here (dangling-prd-ref already
 * flags those). Deterministic; advisory by default (cosmetic edits can move a
 * section hash, so the caller decides whether to fail).
 */
export function checkFreshness(input: {
  specs: SpecLink[];
  anchors: PrdAnchorState[];
}): FreshnessResult {
  const byAnchor = new Map(input.anchors.map((a) => [a.anchor, a.hash]));
  const stale: StaleSpec[] = [];
  const unstamped: { storyId: string; anchor: string }[] = [];
  let freshCount = 0;
  for (const s of input.specs) {
    if (!s.prdAnchor) continue;
    const current = byAnchor.get(s.prdAnchor);
    if (current === undefined) continue; // dangling anchor — checkTrace handles it
    if (!s.prdSha) {
      unstamped.push({ storyId: s.storyId, anchor: s.prdAnchor });
    } else if (s.prdSha !== current) {
      stale.push({ storyId: s.storyId, anchor: s.prdAnchor, recorded: s.prdSha, current });
    } else {
      freshCount++;
    }
  }
  return { stale, unstamped, freshCount };
}

/**
 * IMPACT — given the set of PRD anchors whose content changed (e.g. from a git
 * diff between two PRD revisions), which stories link them? Forward direction
 * (PRD→stories). The reverse (story→PRD) is the same link read backward: a
 * changed story's `prdAnchor` is the PRD section to review.
 */
export function computeImpact(input: {
  specs: SpecLink[];
  changedAnchors: string[];
}): { affected: { storyId: string; anchor: string }[] } {
  const changed = new Set(input.changedAnchors);
  const affected = input.specs
    .filter((s) => s.prdAnchor && changed.has(s.prdAnchor))
    .map((s) => ({ storyId: s.storyId, anchor: s.prdAnchor! }));
  return { affected };
}

/** Diff two PRD states (anchor→hash) → anchors that changed, were added, or
 *  removed. `changed` is what impact analysis keys on. */
export function diffPrdStates(
  before: PrdAnchorState[],
  after: PrdAnchorState[]
): { changed: string[]; added: string[]; removed: string[] } {
  const a = new Map(before.map((x) => [x.anchor, x.hash]));
  const b = new Map(after.map((x) => [x.anchor, x.hash]));
  const changed: string[] = [];
  const added: string[] = [];
  for (const [anchor, hash] of b) {
    if (!a.has(anchor)) added.push(anchor);
    else if (a.get(anchor) !== hash) changed.push(anchor);
  }
  const removed = [...a.keys()].filter((anchor) => !b.has(anchor));
  return { changed, added, removed };
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
