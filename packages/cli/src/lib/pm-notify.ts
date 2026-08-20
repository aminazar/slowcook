/**
 * PM notification mentions — "the pipeline halted and needs a human" must
 * reach the human's pocket, not wait to be polled (rewo run: three
 * awaiting-PM halts sat unnoticed until the PM went looking).
 *
 * GitHub push-notifies @mentions on mobile under their own category, so
 * every HITL-pause comment (clarifying questions, multifurcation proposal,
 * overlap/contradiction blocks, worker failures) appends `cc @handle`.
 *
 * Handle sources, in order:
 *   1. `.brewing/stack.json` → `"pm": ["@handle", ...]` — explicit config;
 *   2. CODEOWNERS default rule (`* @handle ...`) — already the project's
 *      declaration of who owns everything; slowcook init writes it.
 *
 * NOTE: GitHub suppresses self-mentions — a comment AUTHORED by @x that
 * mentions @x does not notify. Mentions only bite when agents post under
 * their own identity (the GitHub App, `slowcook app init`) — the two
 * features are a pair.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Resolve the PM handles to mention on HITL pauses. Empty = no cc line. */
export function pmHandles(repoRoot: string): string[] {
  // 1. Explicit stack.json pm list.
  try {
    const stack = JSON.parse(
      readFileSync(join(repoRoot, ".brewing", "stack.json"), "utf8")
    ) as { pm?: unknown };
    if (Array.isArray(stack.pm)) {
      const handles = stack.pm
        .filter((h): h is string => typeof h === "string" && h.trim().length > 0)
        .map((h) => (h.startsWith("@") ? h : `@${h}`));
      if (handles.length > 0) return handles;
    }
  } catch {
    // no stack.json or no pm field — fall through
  }

  // 2. CODEOWNERS default rule.
  for (const rel of ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"]) {
    try {
      const lines = readFileSync(join(repoRoot, rel), "utf8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const [pattern, ...owners] = trimmed.split(/\s+/);
        if (pattern === "*" ) {
          const handles = owners.filter((o) => o.startsWith("@"));
          if (handles.length > 0) return handles;
        }
      }
    } catch {
      // file absent — try the next location
    }
  }
  return [];
}

/**
 * The cc suffix for a halt comment. Empty string when no PM is declared —
 * never invent a mention.
 */
export function ccLine(handles: string[]): string {
  return handles.length > 0 ? `\n\ncc ${handles.join(" ")}` : "";
}

/** Convenience: resolve + render in one step. */
export function pmCc(repoRoot: string): string {
  return ccLine(pmHandles(repoRoot));
}
