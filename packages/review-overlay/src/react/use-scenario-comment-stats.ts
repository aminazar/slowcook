/**
 * `useScenarioCommentStats` — 0.4.0.
 *
 * Aggregate per-scenario comment stats for the picker page. Walks every
 * mockup PR in the repo + groups by `story_id`. Cached in localStorage
 * for instant render on refresh; background-refresh on focus.
 *
 * Returns `null` until the first fetch (or cache hit) lands. The picker
 * gates badge rendering on `stats !== null` so cards don't blink stats
 * in/out across loads.
 */

"use client";

import { useEffect, useState } from "react";
import {
  loadPat,
  fetchScenarioStats,
  loadCachedScenarioStats,
  saveCachedScenarioStats,
  type ScenarioCommentStats,
  type RepoCoord,
} from "../github.js";

export interface UseScenarioCommentStatsArgs extends RepoCoord {
  /** Same gate as the overlay's `enabled` prop — preview / dev only. */
  enabled?: boolean;
}

export function useScenarioCommentStats(
  args: UseScenarioCommentStatsArgs
): Record<string, ScenarioCommentStats> | null {
  const { owner, repo, enabled = true } = args;
  const [stats, setStats] = useState<Record<string, ScenarioCommentStats> | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!enabled) return;
    if (!owner || !repo) return;

    const cached = loadCachedScenarioStats(window.localStorage, { owner, repo });
    if (cached) setStats(cached);

    const refresh = () => {
      const pat = loadPat(window.localStorage, { owner, repo });
      // Don't prompt for a PAT here — picker page is a low-signal place
      // for that interruption. Wait until the user lands on a scenario
      // page where the comment composer naturally requests one.
      if (!pat) return;
      void fetchScenarioStats({ owner, repo, pat })
        .then((next) => {
          setStats(next);
          saveCachedScenarioStats(window.localStorage, { owner, repo }, next);
        })
        .catch(() => { /* keep cached state */ });
    };
    refresh();
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, owner, repo]);

  return stats;
}
