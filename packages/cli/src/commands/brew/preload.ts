/**
 * ORIENTATION CARRY (dovizir handover §13, lead 2 + 3).
 *
 * Measured live (armb brew-notes-001.log): every iteration the driver spent
 * 14–26 read_file/list_directory calls re-reading the SAME orientation set —
 * target test, pinned .d.ts, package.json, src/index.ts — because iterations
 * are fresh-context. Two turns hit the tool-round cap mid-orientation and
 * ended with no edit; the day's bill showed $10.42 uncached input vs $1.23
 * cache reads. The model never got cheap access to what the previous turn
 * already learned.
 *
 * Fix: brew keeps a per-run READ CACHE (path → content, hit count). Each
 * turn's prompt pre-loads the most-consulted files — target test always
 * first — so a fresh-context turn starts where the last one left off instead
 * of re-paying the walk. Files whose on-disk content changed since caching
 * are dropped (the cache must never lie); a changed file is worth re-reading.
 *
 * Pure module: fs access is injected, so every decision here unit-tests.
 */

export interface ReadCacheEntry {
  content: string;
  hits: number;
}

/** Record one successful read. Content is stored post-truncation (what the
 *  agent actually saw); hits count how often the run consulted the path. */
export function recordRead(
  cache: Map<string, ReadCacheEntry>,
  path: string,
  content: string
): void {
  const prior = cache.get(path);
  if (prior) {
    prior.hits += 1;
    prior.content = content;
  } else {
    cache.set(path, { content, hits: 1 });
  }
}

/** Character budget for the whole block (~6k tokens). Generous because each
 *  avoided re-read saves a full tool ROUND-TRIP with its context resend. */
const DEFAULT_BUDGET = 24_000;
/** Per-file cap so one giant file can't crowd out the set the agent uses. */
const PER_FILE_CAP = 8_000;

export function buildPreloadBlock(args: {
  cache: Map<string, ReadCacheEntry>;
  /** Always pre-loaded, first, even on iteration 1 (lead 3: the file the
   *  turn is ABOUT should never cost a tool round to see). */
  targetTestFile: string;
  /** Current on-disk content, or null when unreadable. Injected. */
  readFile: (path: string) => string | null;
  budgetChars?: number;
}): string {
  const budget = args.budgetChars ?? DEFAULT_BUDGET;
  const chosen: { path: string; content: string }[] = [];
  let used = 0;

  const consider = (path: string, requireUnchanged: boolean): void => {
    if (chosen.some((c) => c.path === path)) return;
    const current = args.readFile(path);
    if (current === null) return; // unreadable/moved — nothing to preload
    if (requireUnchanged) {
      const cached = args.cache.get(path);
      // The cache stores what the agent SAW (possibly truncated); accept
      // either exact match or the cached text being a prefix of current.
      if (!cached) return;
      const seen = cached.content.replace(/\n…\(truncated\)$/, "");
      if (current !== cached.content && !current.startsWith(seen)) return;
    }
    const body = current.length > PER_FILE_CAP
      ? current.slice(0, PER_FILE_CAP) + "\n…(truncated — read_file for the rest)"
      : current;
    const cost = body.length + path.length + 32;
    if (used + cost > budget) return;
    used += cost;
    chosen.push({ path, content: body });
  };

  // Target test first, from disk, unconditionally — it needs no cache entry.
  consider(args.targetTestFile, false);

  // Then the run's most-consulted files, unchanged ones only.
  const byHits = [...args.cache.entries()]
    .filter(([p]) => p !== args.targetTestFile)
    .sort((a, b) => b[1].hits - a[1].hits);
  for (const [path] of byHits) consider(path, true);

  if (chosen.length === 0) return "";

  const lines: string[] = [];
  lines.push("### Pre-loaded files (already read for you — do NOT spend tool calls re-reading these)");
  lines.push(
    "These are current as of this turn. Re-read a file ONLY if you edit it first, or if it is not listed here."
  );
  lines.push("");
  for (const c of chosen) {
    lines.push(`**\`${c.path}\`:**`);
    lines.push("```");
    lines.push(c.content);
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}
