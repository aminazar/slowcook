import type { Spec, SpecProposals } from "@slowcook-ai/core";

/**
 * Deterministic post-processor that derives proposals from the spec
 * body when the LLM inlined decisions into `invariants` / `api_contract`
 * / `ui_behavior` without populating `proposals`. Two attempts at prompt
 * steering failed to get the LLM to emit proposals reliably when the PM
 * answered clarifying questions in detail; this is the structural fix.
 *
 * Philosophy: we don't override what the LLM explicitly chose to put
 * in proposals — LLM-emitted proposals always win. We only fill in
 * categories the LLM left empty, sourcing the content from the spec's
 * traditional fields. The synthesized proposals carry
 * `proposed_by: "spec-body-synth"` so reviewers can tell the difference.
 *
 * Categories covered with high-signal synthesis:
 *  - `routes`: extract page-like paths from `api_contract` + `ui_behavior`
 *     prose, map to Next.js App Router file locations
 *  - `auth`: extract "authenticated" / "auth.uid()" / "RLS policy" hints
 *     from invariants
 *  - `schema`: detect DDL-implying invariants; flag as needing completion
 *     if the LLM didn't emit structured DDL (prose alone isn't
 *     reconstructable into Mermaid without another LLM call)
 *
 * Categories NOT covered (low signal — leave to LLM or skip):
 *  - ui_layout, perf_budget, observability, infra, api_shape
 */
export function synthesizeProposalsFromSpec(spec: Spec): SpecProposals {
  const existing = spec.proposals ?? {};
  const synthesized: SpecProposals = { ...existing };

  if (!existing.routes) {
    const routes = deriveRoutes(spec);
    if (routes) synthesized.routes = routes;
  }

  if (!existing.auth) {
    const auth = deriveAuth(spec);
    if (auth) synthesized.auth = auth;
  }

  if (!existing.schema) {
    const schema = deriveSchema(spec);
    if (schema) synthesized.schema = schema;
  }

  return synthesized;
}

function deriveRoutes(spec: Spec): SpecProposals["routes"] | null {
  const paths = new Set<string>();

  // 1. Page-like paths from api_contract entries that don't start with /api/
  for (const entry of spec.api_contract ?? []) {
    const p = (entry as { path?: string }).path;
    if (typeof p === "string" && !p.startsWith("/api/")) paths.add(p);
  }

  // 2. Path mentions in ALL prose fields, not just ui_behavior. Specs use
  // `<handle>` in preconditions/invariants/acceptance_scenarios as the
  // canonical dynamic-segment shorthand; example handles like `/u/amin`
  // show up in ui_behavior + scenarios as concrete repros. We capture
  // BOTH forms and coalesce below so the proposal emits the dynamic
  // route, not an accidental static route keyed on an example handle.
  const prose = [
    ...Object.values(spec.ui_behavior ?? {}),
    ...(spec.preconditions ?? []),
    ...(spec.invariants ?? []),
    ...(spec.acceptance_scenarios ?? []),
    ...(spec.non_goals ?? []),
  ].join("\n");

  // Regex accepts either `[name]` (Next.js App Router shape) or
  // `<name>` (spec shorthand) as dynamic segments, alongside literal
  // path segments. The `<>` form is normalised to `[]` after the scan.
  const pathRe = /(?:^|[\s(`"'])(\/(?:[a-z][a-z0-9_-]*)(?:\/(?:\[[a-z_]+\]|<[a-z_]+>|[a-z0-9_-]+))*)(?=[`"'\s)),.?]|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(prose)) !== null) {
    const raw = m[1]!;
    if (raw.startsWith("/api/")) continue;
    if (raw.includes(".")) continue;
    // Normalise <name> → [name] so downstream file-path derivation
    // sees a Next.js-shaped route regardless of which form the spec
    // used in prose.
    const normalised = raw.replace(/<([a-z_]+)>/gi, "[$1]");
    paths.add(normalised);
  }

  if (paths.size === 0) return null;

  // Coalesce literal siblings into their dynamic parent: if both
  // `/u/amin` and `/u/[handle]` are present, keep only `/u/[handle]`.
  // This handles the common case where a spec includes both
  // `<handle>` (canonical form) and concrete example handles in
  // repro scenarios. Without this, testgen+brew see two routes and
  // either pick the wrong one or generate duplicate files.
  const pathList = Array.from(paths);
  const hasDynamicSibling = (p: string): boolean => {
    for (const other of pathList) {
      if (other === p) continue;
      if (!other.includes("[")) continue;
      // Compare segment-by-segment: same length, same literal segments,
      // other's `[name]` segments win over self's literal.
      const aSegs = p.split("/");
      const bSegs = other.split("/");
      if (aSegs.length !== bSegs.length) continue;
      let fits = true;
      for (let i = 0; i < aSegs.length; i++) {
        const a = aSegs[i]!;
        const b = bSegs[i]!;
        if (a === b) continue;
        if (b.startsWith("[") && b.endsWith("]")) continue;
        fits = false;
        break;
      }
      if (fits) return true;
    }
    return false;
  };
  const coalesced = pathList.filter((p) => p.includes("[") || !hasDynamicSibling(p));

  const entries = coalesced.sort().map((path) => ({
    path,
    file: pathToPageFile(path),
  }));

  return {
    status: "pending",
    proposed_by: "spec-body-synth",
    rationale:
      "Derived from api_contract + prose fields. `<name>` dynamic segments are normalised to `[name]`; literal example paths that have a dynamic sibling (e.g., `/u/amin` alongside `/u/[handle]`) are dropped in favour of the dynamic form. Review the path-to-file mapping against the project's Next.js App Router convention.",
    paths: entries,
  };
}

/**
 * Map a URL path to a candidate Next.js App Router file location.
 * Uses the `(main)` route group by default (authenticated app pages).
 * Consumer can edit post-emit if their layout differs.
 */
function pathToPageFile(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return "src/app/(main)/page.tsx";
  const inside = segments.map((s) => s).join("/");
  return `src/app/(main)/${inside}/page.tsx`;
}

function deriveAuth(spec: Spec): SpecProposals["auth"] | null {
  const requirements: string[] = [];
  const seen = new Set<string>();

  const push = (r: string): void => {
    const key = r.trim();
    if (!seen.has(key) && key) {
      seen.add(key);
      requirements.push(key);
    }
  };

  for (const inv of spec.invariants ?? []) {
    const text = typeof inv === "string" ? inv : "";
    if (/\bauthenticated\b/i.test(text)) {
      if (/\bmember\b/i.test(text) || /\bviewer\b/i.test(text) || /\buser\b/i.test(text)) {
        push("Viewer must be authenticated");
      }
    }
    // Extract RLS policies mentioned in prose
    const rlsMatch = text.match(
      /RLS (?:policy|policies)[^:]*[:]?\s*([^.]+)(?:\.|$)/i
    );
    if (rlsMatch && rlsMatch[1]) {
      push(`RLS: ${rlsMatch[1].trim()}`);
    }
    // Extract auth.uid() usage patterns
    const authUidMatch = text.match(/`?member_id\s*=\s*auth\.uid\(\)`?/i);
    if (authUidMatch) {
      push(`RLS scope: ${authUidMatch[0].replace(/`/g, "")}`);
    }
    // Ownership checks
    if (/\bowner\b/i.test(text) && /\bcheck\b/i.test(text)) {
      push("Ownership check required for write endpoints");
    }
  }

  if (requirements.length === 0) return null;

  return {
    status: "pending",
    proposed_by: "spec-body-synth",
    rationale: "Derived from invariants mentioning authentication / RLS / ownership.",
    requirements,
  };
}

/**
 * Detect when the spec implies a new DB table / columns but no structured
 * DDL exists. Emits a `pending` schema proposal with a placeholder `sql`
 * asking for completion (regenerate or hand-author). Can't reliably
 * reconstruct actual DDL from prose without another LLM call — that's
 * a follow-up. For 0.11.3 we at least surface the gap in the PR body.
 */
function deriveSchema(spec: Spec): SpecProposals["schema"] | null {
  const invariants = spec.invariants ?? [];
  const hints: string[] = [];

  for (const inv of invariants) {
    const text = typeof inv === "string" ? inv : "";
    if (
      /\b(?:unique\s+constraint|alter\s+table|add\s+column|(?:create|new)\s+table)\b/i.test(
        text
      )
    ) {
      hints.push(text);
    }
    // Table.column references e.g., `bookmarks(member_id, rewo_id)`
    if (/`?[a-z_][a-z0-9_]*`?\s*\(\s*[a-z_][a-z0-9_]*\s*,/i.test(text) && /constraint|unique|index/i.test(text)) {
      hints.push(text);
    }
  }

  if (hints.length === 0) return null;

  return {
    status: "pending",
    proposed_by: "spec-body-synth",
    rationale:
      "The spec's invariants imply new / altered tables or constraints but structured DDL was not emitted in proposals. The SQL below is a placeholder — regenerate the spec or hand-author the migration to replace it.",
    sql:
      "-- TODO: structured DDL not emitted by refine. Invariants referencing schema:\n" +
      hints.map((h) => `-- * ${h.replace(/\n/g, " ")}`).join("\n") +
      "\n-- Regenerate the spec or hand-author the migration.\n",
  };
}
