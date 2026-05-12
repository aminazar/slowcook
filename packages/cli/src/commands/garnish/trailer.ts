/**
 * 0.19.0-α.15 — `slowcook garnish` trailer helpers.
 *
 * When a human (or another agent) commits a tweak on top of an agent's
 * work, we mark the commit with `Tweaks-output-of:` git trailer lines —
 * one per file the tweak touched, naming the upstream agent + sha. A
 * future `slowcook reflect` command mines these trailers to surface
 * learning signal for the upstream agent (eval-set fixtures, prompt
 * amendment candidates, drift catalogs).
 *
 * Trailer format (one line per file):
 *
 *   Tweaks-output-of: agent=<name> sha=<commit-sha> file=<repo-relative-path>
 *
 * Examples:
 *   Tweaks-output-of: agent=vibe sha=a7df238 file=mock/src/components/Foo.tsx
 *   Tweaks-output-of: agent=plate sha=00905ae file=mock/src/components/Bar.tsx
 *
 * Pure module — no IO. Caller composes the trailer lines into the commit
 * message and runs git separately.
 */

export interface UpstreamRef {
  /** Upstream agent name (vibe / plate / brew / chef / etc). */
  agent: string;
  /** Upstream commit SHA (short or full; renderer trims to 7). */
  sha: string;
  /** Repo-relative file path the tweak touched. */
  file: string;
}

/**
 * Format a list of upstream refs into trailer lines (one per ref).
 * Pure: returns a single string with `\n` separators, no leading or
 * trailing newline. Caller appends to the commit-message body.
 */
export function formatTrailer(refs: UpstreamRef[]): string {
  return refs
    .map((r) => `Tweaks-output-of: agent=${r.agent} sha=${r.sha.slice(0, 7)} file=${r.file}`)
    .join("\n");
}

/**
 * Parse a single trailer line, returning the parsed ref or null if the
 * line doesn't match the expected shape. Tolerates leading/trailing
 * whitespace + the optional "  " indent some `git interpret-trailers`
 * outputs add.
 */
export function parseTrailerLine(line: string): UpstreamRef | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("Tweaks-output-of:")) return null;
  const body = trimmed.slice("Tweaks-output-of:".length).trim();
  // body looks like: "agent=vibe sha=abc1234 file=mock/src/X.tsx"
  // file= may contain spaces in the rare case of weird paths; capture
  // greedily as the last field.
  const m = body.match(/^agent=(\S+)\s+sha=(\S+)\s+file=(.+)$/);
  if (!m) return null;
  const [, agent, sha, file] = m;
  if (!agent || !sha || !file) return null;
  return { agent, sha, file };
}

/**
 * Parse all `Tweaks-output-of:` trailers from a full commit-message
 * body (multi-line). Returns refs in the order they appeared.
 */
export function parseTrailers(commitBody: string): UpstreamRef[] {
  const out: UpstreamRef[] = [];
  for (const line of commitBody.split("\n")) {
    const ref = parseTrailerLine(line);
    if (ref) out.push(ref);
  }
  return out;
}

/**
 * Inspect a git author line + return the upstream agent name, if the
 * author follows slowcook's agent convention. Otherwise null.
 *
 * Conventions detected:
 *   slowcook-vibe[bot]       → "vibe"
 *   slowcook-plate[bot]      → "plate"
 *   slowcook-brew[bot]       → "brew"
 *   slowcook-chef[bot]       → "chef"
 *   slowcook-refine[bot]     → "refine"
 *   slowcook-testgen[bot]    → "testgen"
 *   slowcook-recipe[bot]     → "recipe"
 *   anything else            → null (human or unrelated bot)
 *
 * Pure: no IO. Caller pipes git author through it.
 */
export function agentFromAuthor(author: string): string | null {
  const m = author.match(/^slowcook-([a-z][\w-]*)\[bot\]$/);
  if (!m) return null;
  return m[1]!;
}

/**
 * Compose the full commit message body for a garnish commit: a one-line
 * subject naming the touched files, a blank line, optional user-provided
 * body, a blank line, then the trailer block.
 *
 * Pure: caller passes the staged-file list + the parsed upstream refs +
 * the optional user message. Returns the body string ready for `git
 * commit -F`.
 */
export function composeCommitMessage(args: {
  touchedFiles: string[];
  upstreamRefs: UpstreamRef[];
  userMessage?: string;
}): string {
  const subject = `[garnish] ${formatTouchedFilesSummary(args.touchedFiles)}`;
  const parts: string[] = [subject, ""];
  if (args.userMessage && args.userMessage.trim().length > 0) {
    parts.push(args.userMessage.trim(), "");
  }
  if (args.upstreamRefs.length > 0) {
    parts.push(formatTrailer(args.upstreamRefs));
  }
  return parts.join("\n");
}

function formatTouchedFilesSummary(files: string[]): string {
  if (files.length === 0) return "(no files)";
  if (files.length === 1) return files[0]!;
  if (files.length === 2) return `${files[0]} + ${files[1]}`;
  return `${files[0]} + ${files.length - 1} more`;
}
