import { existsSync, readFileSync } from "node:fs";
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
 *  - perf_budget, observability, infra, api_shape
 *
 * 0.14.0-α.3+ (V7 hard-signal track): ui_layout + fixtures synthesizers
 * landed when the LLM-side prompt steering proved soft (refine 0.13.6
 * told the agent to emit ui_layout when ui_behavior was present, but on
 * rewo story-015 the agent put real tokens in prose ui_behavior and
 * skipped the structured proposal). The synthesizers below are the
 * hard-signal backstop: when the LLM doesn't elevate to a structured
 * block, the synth derives one from prose + brownfield extracts.
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

  if (!existing.ui_layout) {
    const ui = deriveUiLayout(spec);
    if (ui) synthesized.ui_layout = ui;
  }

  if (!existing.fixtures) {
    const fx = deriveFixtures(spec);
    if (fx) synthesized.fixtures = fx;
  }

  return synthesized;
}

/**
 * 0.14.0-α.3 — V7 hard-signal backstop for fixtures proposals.
 *
 * Detects "data display" stories — api_contract has at least one GET
 * endpoint AND ui_behavior implies displaying that data — and emits an
 * empty-seed shell. The shell lets refine's writeMockFixtures still emit
 * `<domain>.mock.ts` + `<domain>.ts` stub files (with empty arrays) so
 * the generated mockup and brew's data-layer seam still wire up.
 *
 * Real fixture rows still need either the LLM-side prompt steering or
 * hand-authoring; the shell just unblocks the pipeline.
 *
 * Domain naming: derives from the last meaningful path segment of the
 * first GET endpoint (e.g. `GET /api/profiles/:handle/pins` → `pins`).
 * Conservative: only one domain emitted to keep the synth predictable.
 */
function deriveFixtures(spec: Spec): SpecProposals["fixtures"] | null {
  const api = (spec.api_contract ?? []) as Array<{
    method?: string;
    path?: string;
  }>;
  const gets = api.filter((e) => (e.method ?? "").toUpperCase() === "GET");
  if (gets.length === 0) return null;

  const ui = spec.ui_behavior ?? {};
  const uiProse = Object.values(ui).join("\n").toLowerCase();
  if (uiProse.trim().length === 0) return null;
  // Heuristic: must imply listing/displaying data, not just a static page.
  if (!/list|strip|feed|grid|cards?|rows?|items?|chronological|render|timeline/i.test(uiProse)) {
    return null;
  }

  // Pick the first GET endpoint's tail segment as the domain.
  const firstPath = gets[0]!.path ?? "";
  // Strip trailing dynamic segments (`/:rewo_id`) and `/api/` prefix.
  const segs = firstPath
    .replace(/^\/api\//, "")
    .split("/")
    .filter((s) => s.length > 0 && !s.startsWith(":") && !s.startsWith("[") && !s.startsWith("<"));
  const domainRaw = segs[segs.length - 1] ?? "";
  const domain = domainRaw.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!domain || !/^[a-z][a-z0-9_-]*$/.test(domain)) return null;

  const rationale =
    "Synthesised by spec-body-synth: api_contract has GET endpoint(s) + ui_behavior implies data display, but no structured fixtures were emitted by refine. Empty-seed shell lets the data-layer seam wire up; hand-author or re-refine to populate the seed before testgen.";

  return {
    status: "pending",
    proposed_by: "spec-body-synth",
    rationale,
    by_domain: {
      [domain]: { seed: { list: [] } },
    },
  };
}

/**
 * 0.14.0-α.3 — V7 hard-signal backstop for ui_layout proposals.
 *
 * Walks ui_behavior prose for token usage (`bg-…`, `text-…`, `border-…`,
 * `var(--…)`) and component path mentions (`src/components/…`).
 * Validates each against the brownfield extracts:
 *   - tokens.md: only emit tokens that EXIST (filters out invented)
 *   - tokens promoted to `tokens_to_add` when they appear in prose
 *     but NOT in the catalog (lets brew see invention attempts)
 * Skips if ui_behavior is empty (the agent declared no UI surface).
 *
 * Emits with proposed_by: spec-body-synth so reviewers know it was
 * derived, not hand-authored.
 */
function deriveUiLayout(spec: Spec): SpecProposals["ui_layout"] | null {
  const ui = spec.ui_behavior ?? {};
  const prose = Object.values(ui).join("\n");
  if (prose.trim().length === 0) return null;

  const seenTokens = new Set<string>();

  // var(--name) usages
  for (const m of prose.matchAll(/var\(\s*(--[a-z0-9_-]+)\s*\)/gi)) {
    seenTokens.add(m[1]!);
  }
  // Tailwind-shaped class usages: bg-X, text-X, border-X, divide-X,
  // ring-X. These map onto @theme tokens (e.g. bg-coral → --color-coral).
  // We capture them as the BARE token name without prefix so downstream
  // brew/testgen can grep for them in component source.
  for (const m of prose.matchAll(
    /\b(?:bg|text|border|divide|ring|fill|stroke)-([a-z][a-z0-9-]*(?:\/\d+)?)\b/gi
  )) {
    // Skip pure-number tints (`text-foreground/60` is captured via the
    // first half; `/60` is opacity, not a token).
    seenTokens.add(m[0]!.toLowerCase());
  }

  // Component path mentions
  const components = new Set<string>();
  for (const m of prose.matchAll(
    /src\/components\/[a-z0-9_/-]+\.(?:tsx|ts)\b/gi
  )) {
    components.add(m[0]!);
  }
  // Also match backtick-wrapped PascalCase names — e.g. "renders each row
  // via `RewoCard`". These are weaker signal but useful for the consumer
  // when the spec doesn't include a path.
  //
  // POLISH-2 (α.5): require a recognized component-name suffix to filter
  // out button-label strings like `Pin`, `Pinned`, `Unpin` that appeared
  // in story-015. Real React components in rewo follow conventions:
  // Card/Page/Form/List/Item/Picker/Toggle/Menu/Logo/Detail/Button/Layout/
  // Provider/Container/Wrapper/Row/Column/Avatar/Badge/Modal/Dialog/Tooltip.
  const COMPONENT_SUFFIX_RE = /(?:Card|Page|Form|List|Item|Picker|Toggle|Menu|Logo|Detail|Button|Layout|Provider|Container|Wrapper|Row|Column|Avatar|Badge|Modal|Dialog|Tooltip|Header|Footer|Sidebar|Nav|NavLink|Strip|Preview|View|Section|Grid|Cell|Field|Input|Select|Switch|Tab|Tabs|Pill|Chip|Tag|Bar|Drawer|Sheet|Panel|Slide|Slider|Toast|Spinner|Loader|Empty|Placeholder)$/;
  const componentNames = new Set<string>();
  for (const m of prose.matchAll(/`([A-Z][A-Za-z0-9]+)`/g)) {
    const name = m[1]!;
    // Crude filter: skip tags that look like SQL constants (UUID, JSON)
    if (/^(UUID|JSON|HTML|CSS|SQL|API|URL|HTTP|RLS|FK)$/.test(name)) continue;
    // Require a recognized component-name suffix.
    if (!COMPONENT_SUFFIX_RE.test(name)) continue;
    componentNames.add(name);
  }

  if (seenTokens.size === 0 && components.size === 0 && componentNames.size === 0) {
    return null;
  }

  // Bucket tokens against the catalog.
  const catalog = readExistingTokens();
  const tokensToReuse: string[] = [];
  const tokensToAdd: string[] = [];
  for (const t of Array.from(seenTokens).sort()) {
    if (catalog.size === 0) {
      // No brownfield catalog available — emit everything as reuse, the
      // PM/brewer can correct if any are invented.
      tokensToReuse.push(t);
      continue;
    }
    const stem = t.replace(/^(?:bg|text|border|divide|ring|fill|stroke|fill|font)-/, "");
    const stemNoOpacity = stem.replace(/\/\d+$/, "");
    // Skip Tailwind built-in utilities — they're not project tokens, not
    // tokens to add. Includes typography (text-{xs,sm,base,lg,xl,...}),
    // weight (font-{thin,normal,medium,bold,...}), border-{dashed,dotted,solid,
    // none,2,4,8}, ring sizes, opacity etc. Pre-α.4 polish: these polluted
    // tokens_to_add for story-015 (text-sm, text-xs, border-dashed).
    if (isTailwindBuiltin(t)) continue;
    if (catalog.has(t) || catalog.has(stem) || catalog.has(stemNoOpacity)) {
      tokensToReuse.push(t);
    } else if (catalog.has("--" + stemNoOpacity) || catalog.has("--color-" + stemNoOpacity)) {
      tokensToReuse.push(t);
    } else {
      tokensToAdd.push(t);
    }
  }

  const componentsToReuse = [
    ...Array.from(components).sort(),
    ...Array.from(componentNames).sort().map((n) => `\`${n}\` (path TBD — derived from spec prose)`),
  ];

  // If we ended up with literally nothing actionable, skip.
  if (tokensToReuse.length === 0 && tokensToAdd.length === 0 && componentsToReuse.length === 0) {
    return null;
  }

  const rationale =
    "Synthesised by spec-body-synth from `ui_behavior` prose + brownfield extracts in `.brewing/diagrams/tokens.md`. Tokens classified as REUSE when present in the catalog, otherwise flagged in `tokens_to_add` for review. Components extracted from `src/components/...` path mentions and backtick-wrapped PascalCase names. Edit before merging if classifications are wrong.";

  return {
    status: "pending",
    proposed_by: "spec-body-synth",
    rationale,
    components_to_reuse: componentsToReuse.length > 0 ? componentsToReuse : undefined,
    tokens_to_reuse: tokensToReuse.length > 0 ? tokensToReuse : undefined,
    tokens_to_add: tokensToAdd.length > 0 ? tokensToAdd : undefined,
  };
}

/**
 * Recognize standard Tailwind utility classes that aren't project-defined
 * design tokens — text sizes, font weights, border styles, etc. These
 * shouldn't appear in either tokens_to_reuse OR tokens_to_add (the former
 * is for project-token reuse, the latter for invented project tokens).
 * Standard utility classes are just framework primitives.
 */
function isTailwindBuiltin(token: string): boolean {
  // Strip the property prefix.
  const stem = token.replace(/^(?:bg|text|border|divide|ring|fill|stroke|font)-/, "");
  const stemNoOpacity = stem.replace(/\/\d+$/, "");
  return (
    /^(?:xs|sm|base|md|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)$/.test(stemNoOpacity) ||
    /^(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)$/.test(stemNoOpacity) ||
    /^(?:dashed|dotted|solid|double|none|hidden)$/.test(stemNoOpacity) ||
    /^(?:0|1|2|4|8|px)$/.test(stemNoOpacity) ||
    /^(?:left|center|right|justify|start|end)$/.test(stemNoOpacity) ||
    /^(?:auto|inherit|current|transparent|initial)$/.test(stemNoOpacity)
  );
}

function readExistingTokens(): Set<string> {
  // Read token names from .brewing/diagrams/tokens.md if present.
  // Same fix as readExistingEntities — top-level import instead of
  // require() under ES modules.
  const set = new Set<string>();
  try {
    const path = ".brewing/diagrams/tokens.md";
    if (!existsSync(path)) return set;
    const content = readFileSync(path, "utf8");
    // Tokens render as table rows: `| \`--color-coral\` | …`
    for (const m of content.matchAll(/\|\s*`(--[a-z0-9_-]+)`/gi)) {
      set.add(m[1]!.toLowerCase());
    }
  } catch {
    // ignore
  }
  return set;
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

  // Regex accepts dynamic segments in three notations:
  //   - `[name]` — Next.js App Router shape
  //   - `<name>` — spec shorthand
  //   - `:name`  — Express / OpenAPI / colon shorthand (most common in
  //                hand-authored api_contract entries; was missed pre-0.14.0-α.3
  //                and caused literal example handles to be the only thing
  //                captured — see story-015 / `/u/alice` regression).
  // The `<name>` and `:name` forms are normalised to `[name]` after the scan.
  // Step 1 above already covers api_contract paths verbatim; step 2 here
  // sweeps prose for additional path mentions including the canonical
  // dynamic-segment forms.
  const pathRe = /(?:^|[\s(`"'])(\/(?:[a-z][a-z0-9_-]*)(?:\/(?:\[[a-z_]+\]|<[a-z_]+>|:[a-z_][a-z0-9_]*|[a-z0-9_-]+))*)(?=[`"'\s)),.?]|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(prose)) !== null) {
    const raw = m[1]!;
    if (raw.startsWith("/api/")) continue;
    if (raw.includes(".")) continue;
    // Normalise <name> + :name → [name] so downstream file-path derivation
    // sees a Next.js-shaped route regardless of which form the spec used.
    const normalised = raw
      .replace(/<([a-z_][a-z0-9_]*)>/gi, "[$1]")
      .replace(/:([a-z_][a-z0-9_]*)/gi, "[$1]");
    paths.add(normalised);
  }

  // Note (BUG-D, 0.14.0-α.4): an earlier α.3 attempt to lift dynamic
  // segment names from api_contract and rewrite EVERY literal path's
  // last segment was reverted because it generated `/[handle]` from
  // `/feed` when api_contract had `:handle`. The :name regex extension
  // above alone catches the common case (`/u/:handle` in prose) without
  // requiring this aggressive lift.

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
 * Detect when the spec implies a new DB table / columns and synthesise a
 * best-effort `CREATE TABLE` from invariants + api_contract response shapes.
 *
 * Pre-0.14.0-α.3 this just emitted a `-- TODO` placeholder. Validated as a
 * regression on rewo story-015: invariants clearly stated `rewo_pins(member_id,
 * rewo_id)`, `pin_limit_reached` trigger, etc., but the synth bailed. Brew
 * couldn't act on a TODO.
 *
 * Now: detects new-table mentions, scrapes column names from invariants +
 * api_contract response prose, infers types by suffix convention
 * (_id → uuid, _at → timestamptz, _count → int, default → text), and
 * emits a CREATE TABLE skeleton with foreign keys when the column suffix
 * matches an existing entity in `.brewing/diagrams/schema.mmd`. Brew /
 * a PM can still hand-author the migration; the skeleton just makes the
 * common case (single new table with conventional columns) shippable
 * without a re-refine round.
 */
function deriveSchema(spec: Spec): SpecProposals["schema"] | null {
  const invariants = spec.invariants ?? [];
  const apiContract = (spec.api_contract ?? []) as Array<{
    method?: string;
    path?: string;
    request_schema?: unknown;
    responses?: Record<string, unknown>;
  }>;

  const hints: string[] = [];
  const tableMentions = new Map<string, Set<string>>();

  // Heuristic 1: "`<table>(col1, col2)`" or "`<table>`(col1, col2)" pattern
  // in invariants — REQUIRES at least the LEADING backtick. Pre-α.4 both
  // backticks were optional, which swept English prepositions/verbs
  // ("for (member_id, rewo_id)") into the candidate-tables set.
  // See BUG-C. The closing backtick after the name is optional because
  // the most common spec convention wraps table+parens together as one
  // backticked identifier.
  const tableColRe = /`([a-z_][a-z0-9_]*)`?\s*\(\s*([a-z_][a-z0-9_]*(?:\s*,\s*[a-z_][a-z0-9_]*)*)\s*\)/g;
  for (const inv of invariants) {
    const text = typeof inv === "string" ? inv : "";
    if (
      /\b(?:unique\s+constraint|alter\s+table|add\s+column|(?:create|new)\s+table)\b/i.test(text)
    ) {
      hints.push(text);
    }
    let m: RegExpExecArray | null;
    const re = new RegExp(tableColRe.source, "g");
    while ((m = re.exec(text)) !== null) {
      const tbl = m[1]!.toLowerCase();
      // Skip false positives: function names + SQL reserved words.
      if (/^(?:auth|now|gen_random_uuid|max|min|count|sum|coalesce|select|insert|update|delete|from|where|join|table|create|alter|drop|grant|set|with|on|by|as|in|is|or|and|not|all|any|some|exists)$/i.test(tbl)) continue;
      const cols = m[2]!.split(/\s*,\s*/).map((c) => c.trim().toLowerCase()).filter(Boolean);
      if (!tableMentions.has(tbl)) tableMentions.set(tbl, new Set());
      const set = tableMentions.get(tbl)!;
      for (const c of cols) set.add(c);
    }

    // Heuristic 1b: split-form constraint convention — "`(col1, col2)` in `<table>`"
    // or "constraint on `(col1, col2)` for `<table>`". Common in Postgres-doc-style
    // specs where the column list and table name live in separate backticks.
    // story-015 used this form; α.3 missed it (member_id was dropped from rewo_pins).
    const splitFormRe = /`\(\s*([a-z_][a-z0-9_]*(?:\s*,\s*[a-z_][a-z0-9_]*)*)\s*\)`(?:\s+(?:in|on|for|of|to)\s+)`([a-z_][a-z0-9_]*)`/gi;
    let mm: RegExpExecArray | null;
    while ((mm = splitFormRe.exec(text)) !== null) {
      const cols = mm[1]!.split(/\s*,\s*/).map((c) => c.trim().toLowerCase()).filter(Boolean);
      const tbl = mm[2]!.toLowerCase();
      if (!tableMentions.has(tbl)) tableMentions.set(tbl, new Set());
      const set = tableMentions.get(tbl)!;
      for (const c of cols) set.add(c);
    }
  }

  // Heuristic 2: any backticked snake_case identifier mentioned >= 2 times
  // across invariants is a strong table-name signal. Walks all invariants
  // (not just per-line) so multi-mention counting works. Pre-α.4 this used
  // a narrow `<word> row|insert|delete` pattern which missed `rewo_pins`
  // (the actual main table in story-015) because the prose said
  // "rows in `rewo_pins` at any time" — `at` doesn't match the suffix list.
  //
  // Blacklist: error codes and column names that appear in api_contract
  // responses as quoted "code" values (e.g. `pin_limit_reached`,
  // `already_pinned`) — those are API contract identifiers, not tables.
  // Pre-α.4 these slipped through and produced spurious `create table
  // pin_limit_reached` etc. (caught on rewo story-015 re-run).
  const errorCodeBlacklist = new Set<string>();
  for (const e of apiContract) {
    const responses = e.responses ?? {};
    for (const respValue of Object.values(responses)) {
      if (typeof respValue !== "string") continue;
      // Pull "<name>" from `code: "..."` patterns and `code: name | other_name`.
      for (const m of respValue.matchAll(/code\s*:\s*['"]?([a-z_][a-z0-9_]*)['"]?/gi)) {
        errorCodeBlacklist.add(m[1]!.toLowerCase());
      }
      // Also pull from `"x" | "y" | "z"` enums after `code:`.
      const codeEnumMatch = respValue.match(/code\s*:\s*((?:['"]?[a-z_][a-z0-9_]*['"]?\s*\|\s*)+['"]?[a-z_][a-z0-9_]*['"]?)/i);
      if (codeEnumMatch) {
        for (const part of codeEnumMatch[1]!.split("|")) {
          const name = part.trim().replace(/^['"]|['"]$/g, "");
          if (/^[a-z_][a-z0-9_]*$/i.test(name)) errorCodeBlacklist.add(name.toLowerCase());
        }
      }
    }
  }
  // Also blacklist anything that follows "raising" / "raises" in prose —
  // standard pattern for declaring trigger-raised error codes.
  for (const inv of invariants) {
    const text = typeof inv === "string" ? inv : "";
    for (const m of text.matchAll(/(?:raising|raises|throws|throwing|with code)\s+`?([a-z_][a-z0-9_]*)`?/gi)) {
      errorCodeBlacklist.add(m[1]!.toLowerCase());
    }
  }

  const tickedCounts = new Map<string, number>();
  const allInvariants = invariants.map((inv) => (typeof inv === "string" ? inv : "")).join("\n");
  for (const m of allInvariants.matchAll(/`([a-z_][a-z0-9_]+)`/g)) {
    const id = m[1]!.toLowerCase();
    // Skip identifiers that contain operators/spaces (like `pinned_at = now()`)
    // — those wouldn't match the regex anyway, but defensive.
    // Skip likely-column-names (single short word with no underscore).
    if (id.length < 4) continue;
    if (errorCodeBlacklist.has(id)) continue;
    tickedCounts.set(id, (tickedCounts.get(id) ?? 0) + 1);
  }
  for (const [id, count] of tickedCounts) {
    if (count < 2) continue;
    // Require either (a) a snake_case shape with at least one underscore
    // (table names usually multi-word like `rewo_pins`), OR (b) appears
    // alongside a SQL action word in the same invariant.
    const hasUnderscore = id.includes("_");
    const hasActionContext = invariants.some((inv) => {
      const text = typeof inv === "string" ? inv : "";
      return text.includes("`" + id + "`") &&
        /\b(?:row|rows|insert|delete|select|update|table|trigger|constraint)\b/i.test(text);
    });
    if (!hasUnderscore && !hasActionContext) continue;
    if (!tableMentions.has(id)) tableMentions.set(id, new Set());
  }

  // Heuristic 3: api_contract path tail = candidate domain table name
  // (e.g. POST /api/pins → table `pins` or `<resource>_pins`); but only
  // treat as a HINT for column names — actual table-name detection comes
  // from invariants above so we don't invent tables nobody mentioned.
  const apiColumns = new Set<string>();
  for (const e of apiContract) {
    const responses = e.responses ?? {};
    for (const respValue of Object.values(responses)) {
      if (typeof respValue !== "string") continue;
      // Pull bareword identifiers from response prose like
      // `{ id: string, rewo_id: string, pinned_at: string }`.
      for (const colMatch of respValue.matchAll(/\b([a-z_][a-z0-9_]*)\s*:/gi)) {
        const name = colMatch[1]!.toLowerCase();
        if (/^(items|status|error|code|next_cursor|message|count|total|data)$/.test(name)) continue;
        apiColumns.add(name);
      }
    }
  }

  if (tableMentions.size === 0 && hints.length === 0) return null;

  // Determine which mentioned tables are NEW vs existing — use the
  // brownfield ERD if available so we don't redundantly emit CREATE
  // TABLE for a table that already lives in supabase/migrations.
  const existingEntities = readExistingEntities(spec);

  const newTables = Array.from(tableMentions.entries()).filter(
    ([t]) => !existingEntities.has(t.toLowerCase())
  );

  let sql: string;
  if (newTables.length === 0) {
    // All mentioned tables already exist — likely an ALTER. Fall through
    // to the legacy TODO (we don't yet synthesise ALTER statements).
    sql =
      "-- TODO: structured ALTER not emitted by refine. Invariants referencing schema:\n" +
      hints.map((h) => `-- * ${h.replace(/\n/g, " ")}`).join("\n") +
      "\n-- Regenerate the spec or hand-author the migration.\n";
  } else {
    sql = newTables
      .map(([table, cols]) => renderCreateTable(table, cols, apiColumns, existingEntities))
      .join("\n\n");
  }

  const rationale =
    newTables.length > 0
      ? `Synthesised CREATE TABLE for ${newTables.length} new table(s) detected in invariants — column types inferred by suffix convention (_id → uuid, _at → timestamptz). Foreign keys validated against existing entities in .brewing/diagrams/schema.mmd. Review + edit before merging.`
      : "The spec's invariants imply altered tables or constraints but structured DDL was not emitted in proposals. The SQL below is a placeholder — regenerate the spec or hand-author the migration to replace it.";

  return {
    status: "pending",
    proposed_by: "spec-body-synth",
    rationale,
    sql,
  };
}

function readExistingEntities(_spec: Spec): Set<string> {
  // Read entity names from .brewing/diagrams/schema.mmd if present.
  // Pre-α.4 this used a lazy `require("node:fs")` call which throws
  // ReferenceError under ES modules — the swallowing try/catch left
  // existingEntities empty in production runs (no FK validation, no
  // FK clauses on synthesised CREATE TABLEs). Switched to top-level
  // imports.
  const set = new Set<string>();
  try {
    const path = ".brewing/diagrams/schema.mmd";
    if (!existsSync(path)) return set;
    const content = readFileSync(path, "utf8");
    for (const m of content.matchAll(/^ {2}([A-Z_]+)\s*\{/gm)) {
      set.add(m[1]!.toLowerCase());
    }
  } catch {
    // ignore
  }
  return set;
}

function renderCreateTable(
  table: string,
  invariantCols: Set<string>,
  apiColumns: Set<string>,
  existingEntities: Set<string>
): string {
  // Union the columns we found from invariants + api_contract.
  const cols = new Set<string>([...invariantCols, ...apiColumns]);
  // Ensure the conventional id column is always present.
  cols.add("id");
  // Stable order: id first, then alphabetical, with `created_at` last.
  const ordered = ["id"];
  for (const c of Array.from(cols).filter((c) => c !== "id" && c !== "created_at").sort()) {
    ordered.push(c);
  }
  if (cols.has("created_at") || true) ordered.push("created_at");

  const lines: string[] = [`create table ${table} (`];
  const colDefs: string[] = [];
  for (const col of ordered) {
    colDefs.push("  " + columnDef(col, existingEntities));
  }
  lines.push(colDefs.join(",\n"));
  lines.push(");");
  return lines.join("\n");
}

function columnDef(col: string, existingEntities: Set<string>): string {
  if (col === "id") return "id uuid primary key default gen_random_uuid()";
  if (col === "created_at") return "created_at timestamptz not null default now()";
  if (col.endsWith("_at")) return `${col} timestamptz`;
  if (col === "count" || col.endsWith("_count")) return `${col} integer not null default 0`;
  if (col.endsWith("_id")) {
    // Convention: column `<entity>_id` references `<entity>s` (plural)
    // when that exists, else `<entity>` singular when that exists.
    const stem = col.slice(0, -3);
    const candidates = [stem + "s", stem, "profiles", "rewos"];
    let target: string | null = null;
    for (const c of candidates) {
      if (existingEntities.has(c.toLowerCase())) {
        target = c;
        break;
      }
    }
    // member_id is conventionally a profile reference even though `members` doesn't exist
    if (!target && stem === "member" && existingEntities.has("profiles")) {
      target = "profiles";
    }
    if (target) {
      return `${col} uuid not null references ${target}(id) on delete cascade`;
    }
    return `${col} uuid not null`;
  }
  if (col === "read_at" || col === "verified_at") return `${col} timestamptz`;
  return `${col} text`;
}
