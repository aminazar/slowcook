import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * 0.11.13+ — cross-brew provenance index.
 *
 * Every successful brew appends entity-level updates to
 * `.brewing/provenance.json`. Indexed by entity (file / symbol / route),
 * not by brew event, so a future brew on overlapping surface can ask
 * "what's the history of this surface?" with one lookup.
 *
 * 0.11.13 ships writes only — no agent reads the file yet. This
 * bootstraps the index so by the time 0.12.0 (reads) lands, the data
 * isn't empty. Schema versioned so we can iterate on shape during the
 * write-only window without forcing migrations on every project.
 */

export const PROVENANCE_PATH = ".brewing/provenance.json";
export const PROVENANCE_SCHEMA_VERSION = 1;

export interface FileProvenance {
  first_added_by: string;
  modified_by: string[];
  last_brew: string;
  last_pr: string | null;
  last_modified: string;
  halt_count: number;
  regression_count: number;
}

export interface SymbolProvenance {
  file: string;
  /** "component" | "helper" | "type" | "route" | "page" | "hook" | "other" — coarse for now. */
  kind: string;
  added_by: string;
  modified_by: string[];
}

export interface RouteProvenance {
  stories: string[];
  current_file: string | null;
}

export interface ProvenanceIndex {
  schema_version: number;
  by_file: Record<string, FileProvenance>;
  by_symbol: Record<string, SymbolProvenance>;
  by_route: Record<string, RouteProvenance>;
}

export interface BrewProvenanceEntry {
  story_id: string;
  pr_url: string | null;
  /** ISO 8601 timestamp. */
  completed_at: string;
  /** Files the brew successfully edited (filtered by allowedPaths). */
  files_touched: string[];
  /** Tier-1 file regressions: tests that brew turned red after they had been green. */
  regression_count: number;
  /** Whether brew halted (vs. clean success). */
  halted: boolean;
  /** Optional: explicit symbol-level changes if the caller has them. Empty allowed. */
  symbols_added?: Array<{ name: string; file: string; kind: string }>;
  /** Optional: routes added/touched (e.g., new src/app/x/page.tsx). */
  routes_added?: Array<{ path: string; file: string }>;
}

/** Read the current provenance index, or return a fresh empty one. */
export function readProvenance(repoRoot: string): ProvenanceIndex {
  const path = join(repoRoot, PROVENANCE_PATH);
  if (!existsSync(path)) {
    return {
      schema_version: PROVENANCE_SCHEMA_VERSION,
      by_file: {},
      by_symbol: {},
      by_route: {},
    };
  }
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<ProvenanceIndex>;
    if (parsed.schema_version !== PROVENANCE_SCHEMA_VERSION) {
      // Future migrations land here. For 0.11.13, anything other than
      // schema_version=1 is treated as foreign and we start fresh
      // rather than silently corrupting it.
      return {
        schema_version: PROVENANCE_SCHEMA_VERSION,
        by_file: {},
        by_symbol: {},
        by_route: {},
      };
    }
    return {
      schema_version: PROVENANCE_SCHEMA_VERSION,
      by_file: parsed.by_file ?? {},
      by_symbol: parsed.by_symbol ?? {},
      by_route: parsed.by_route ?? {},
    };
  } catch {
    // Corrupt or unreadable — return empty rather than crash mid-brew.
    return {
      schema_version: PROVENANCE_SCHEMA_VERSION,
      by_file: {},
      by_symbol: {},
      by_route: {},
    };
  }
}

/**
 * Apply a single brew's results to the index. Returns the updated
 * index. Pure: doesn't write to disk; caller controls persistence.
 */
export function applyBrewEntry(
  index: ProvenanceIndex,
  entry: BrewProvenanceEntry
): ProvenanceIndex {
  const next: ProvenanceIndex = {
    schema_version: PROVENANCE_SCHEMA_VERSION,
    by_file: { ...index.by_file },
    by_symbol: { ...index.by_symbol },
    by_route: { ...index.by_route },
  };

  // by_file: append story to modified_by; first_added_by stays put;
  // last_brew / last_pr / last_modified update unconditionally.
  for (const file of entry.files_touched) {
    const prior = next.by_file[file];
    if (prior) {
      next.by_file[file] = {
        first_added_by: prior.first_added_by,
        modified_by: prior.modified_by.includes(entry.story_id)
          ? prior.modified_by
          : [...prior.modified_by, entry.story_id],
        last_brew: entry.story_id,
        last_pr: entry.pr_url,
        last_modified: entry.completed_at,
        halt_count: prior.halt_count + (entry.halted ? 1 : 0),
        regression_count: prior.regression_count + entry.regression_count,
      };
    } else {
      next.by_file[file] = {
        first_added_by: entry.story_id,
        modified_by: [entry.story_id],
        last_brew: entry.story_id,
        last_pr: entry.pr_url,
        last_modified: entry.completed_at,
        halt_count: entry.halted ? 1 : 0,
        regression_count: entry.regression_count,
      };
    }
  }

  // by_symbol: optional, additive. If the brew didn't supply symbols
  // (they're hard to extract reliably without ts-morph integration —
  // that's Phase 1's job), this loop is a no-op.
  for (const sym of entry.symbols_added ?? []) {
    const prior = next.by_symbol[sym.name];
    if (prior) {
      next.by_symbol[sym.name] = {
        file: sym.file, // last-writer-wins on relocations
        kind: sym.kind,
        added_by: prior.added_by,
        modified_by: prior.modified_by.includes(entry.story_id)
          ? prior.modified_by
          : [...prior.modified_by, entry.story_id],
      };
    } else {
      next.by_symbol[sym.name] = {
        file: sym.file,
        kind: sym.kind,
        added_by: entry.story_id,
        modified_by: [entry.story_id],
      };
    }
  }

  // by_route: optional, additive.
  for (const route of entry.routes_added ?? []) {
    const prior = next.by_route[route.path];
    if (prior) {
      next.by_route[route.path] = {
        stories: prior.stories.includes(entry.story_id)
          ? prior.stories
          : [...prior.stories, entry.story_id],
        current_file: route.file,
      };
    } else {
      next.by_route[route.path] = {
        stories: [entry.story_id],
        current_file: route.file,
      };
    }
  }

  return next;
}

/** Write the index to disk. Creates the .brewing dir if missing. */
export function writeProvenance(
  repoRoot: string,
  index: ProvenanceIndex
): void {
  const path = join(repoRoot, PROVENANCE_PATH);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(index, null, 2) + "\n");
}

/**
 * Convenience: read, apply, write in one call. The brew completion
 * path uses this; tests use the lower-level functions.
 */
export function recordBrewProvenance(
  repoRoot: string,
  entry: BrewProvenanceEntry
): void {
  const current = readProvenance(repoRoot);
  const updated = applyBrewEntry(current, entry);
  writeProvenance(repoRoot, updated);
}

/**
 * 0.12.0+ — render a "prior brew history" markdown block for files
 * the current brew is touching. Returns empty string when there's
 * no history to surface.
 *
 * Inputs:
 *   - index: the loaded provenance.json
 *   - manifestFiles: file paths from the current story's manifest
 *     (i.e., the files brew's tests are likely to exercise; loaded by
 *     deriveStoryTestFiles or similar at the brew layer)
 *   - currentStoryId: skip entries that only mention the current story
 *     (no novel context — agent already knows about its own brew).
 *
 * The block is small by design: bounded attention is the point. We
 * include hot-spot files only (touched in ≥2 brews) plus files with
 * non-zero halt or regression counts.
 */
export function renderPriorContextBlock(
  index: ProvenanceIndex,
  manifestFiles: string[],
  currentStoryId: string,
  options: { maxFiles?: number } = {}
): string {
  const max = options.maxFiles ?? 8;

  const candidates: Array<{ file: string; entry: FileProvenance }> = [];
  for (const f of manifestFiles) {
    const entry = index.by_file[f];
    if (!entry) continue;
    // Skip entries that only mention the current story.
    const others = entry.modified_by.filter((s) => s !== currentStoryId);
    if (others.length === 0) continue;
    candidates.push({ file: f, entry });
  }
  // Also surface files in the same directory as manifest files. Cheap
  // proxy for "code adjacent to what the agent will touch."
  const adjacentSeen = new Set(candidates.map((c) => c.file));
  const dirs = new Set(manifestFiles.map((f) => f.split("/").slice(0, -1).join("/")));
  for (const [f, entry] of Object.entries(index.by_file)) {
    if (adjacentSeen.has(f)) continue;
    const dir = f.split("/").slice(0, -1).join("/");
    if (!dirs.has(dir)) continue;
    const others = entry.modified_by.filter((s) => s !== currentStoryId);
    if (others.length === 0) continue;
    candidates.push({ file: f, entry });
  }

  // Rank: regression-heavy first, then hot-spot, then recent.
  candidates.sort((a, b) => {
    const ra = a.entry.regression_count + a.entry.halt_count * 2;
    const rb = b.entry.regression_count + b.entry.halt_count * 2;
    if (rb !== ra) return rb - ra;
    if (b.entry.modified_by.length !== a.entry.modified_by.length) {
      return b.entry.modified_by.length - a.entry.modified_by.length;
    }
    return b.entry.last_modified.localeCompare(a.entry.last_modified);
  });

  const top = candidates.slice(0, max);
  if (top.length === 0) return "";

  const lines: string[] = [];
  lines.push("### Prior brew history (this surface area)");
  lines.push("");
  for (const { file, entry } of top) {
    const stories = entry.modified_by.join(", ");
    const flags: string[] = [];
    if (entry.halt_count > 0) flags.push(`${entry.halt_count} halt(s)`);
    if (entry.regression_count > 0) flags.push(`${entry.regression_count} regression(s)`);
    const flagSuffix = flags.length > 0 ? ` — ${flags.join(", ")}` : "";
    const prSuffix = entry.last_pr ? ` — last PR: ${entry.last_pr}` : "";
    lines.push(`- \`${file}\` — ${stories}${flagSuffix}${prSuffix}`);
  }
  lines.push("");
  lines.push(
    "Read prior PRs before duplicating logic. If a previous brew touched a file you're about to edit, the existing structure is the right starting point — extend it, don't bypass it."
  );
  return lines.join("\n");
}
