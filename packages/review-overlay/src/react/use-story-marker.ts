/**
 * 0.6.0 — LCR runtime story marker.
 *
 * An LCR page renders the implementation of a story/requirement. Calling
 * `useStoryMarker("104")` (or `<StoryMarker story="104">`) on that page sets
 * `document.documentElement.dataset.slowcookStory` while it's mounted, so the
 * review overlay can tag a comment left there with the exact requirement — the
 * comment becomes a contextualised, `vibe`-labelled issue for that story.
 *
 * The @story SOURCE comments stay the provenance record; this is the runtime
 * echo the browser can read. Absent marker → the overlay still files the route;
 * vibe can derive the story from it.
 */
"use client";

import { useEffect } from "react";

const ATTR = "slowcookStory"; // document.documentElement.dataset.slowcookStory

/** Read the story the current route declares, if any. */
export function readCurrentStory(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const v = document.documentElement.dataset[ATTR];
  return v && v.length > 0 ? v : undefined;
}

/** Declare the story for the route this component renders (while mounted). */
export function useStoryMarker(story: string): void {
  useEffect(() => {
    if (typeof document === "undefined" || !story) return;
    const prev = document.documentElement.dataset[ATTR];
    document.documentElement.dataset[ATTR] = story.replace(/^story-/, "");
    return () => {
      if (prev === undefined) delete document.documentElement.dataset[ATTR];
      else document.documentElement.dataset[ATTR] = prev;
    };
  }, [story]);
}
