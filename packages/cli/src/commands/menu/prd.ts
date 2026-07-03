/**
 * GUCDI — PRD parsing (pure). The `menu` agent decomposes a PRD into a story
 * set; each story anchors back to a PRD initiative. This module turns a PRD
 * markdown file into the list of anchorable initiatives (heading → GitHub-style
 * slug) so those anchors are stable, grep-able, and traceable by `trace check`.
 *
 * See docs/plans/gucdi-greenfield.md.
 */

export interface PrdInitiative {
  /** GitHub-style slug anchor (or an explicit `{#id}`), stable across edits. */
  anchor: string;
  /** Heading text (the initiative title). */
  title: string;
  /** Heading depth (1–6). */
  level: number;
  /** Prose under this heading, up to the next heading of any level. */
  body: string;
}

/**
 * GitHub heading-anchor slug: lowercase, spaces → hyphens, drop characters that
 * aren't alphanumeric/hyphen, collapse repeats. Matches GitHub's algorithm
 * closely enough for stable in-repo anchors.
 */
export function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "") // drop punctuation (keeps word chars, spaces, hyphens)
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Parse a PRD markdown string into its initiatives. Each ATX heading
 * (`#`…`######`) becomes an initiative. An explicit trailing `{#custom-anchor}`
 * on the heading overrides the slug. Body text is captured up to the next
 * heading of any level. Lines inside fenced code blocks are ignored (so a `#`
 * comment in a code sample isn't mistaken for a heading).
 */
export function parsePrdInitiatives(md: string): PrdInitiative[] {
  const lines = md.split(/\r?\n/);
  const inits: PrdInitiative[] = [];
  let current: PrdInitiative | null = null;
  let inFence = false;

  const flush = () => {
    if (current) {
      current.body = current.body.replace(/\n+$/, "");
      inits.push(current);
    }
  };

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      if (current) current.body += line + "\n";
      continue;
    }
    // dash dogfood: PRDs also anchor sections as bold LIST ITEMS
    // (`- **7.9a Title** {#anchor} — body…`). Only EXPLICITLY anchored
    // bullets become initiatives — plain bullets stay body text.
    const li = !inFence
      ? /^\s*[-*]\s+\*\*(.+?)\*\*\s*\{#([\w-]+)\}\s*(?:[—–-]\s*)?(.*)$/.exec(line)
      : null;
    if (li) {
      const parentLevel: number = current !== null ? current.level : 2;
      flush();
      current = {
        anchor: li[2]!,
        title: li[1]!.trim(),
        level: parentLevel + 1,
        body: (li[3] ?? "") + "\n",
      };
      continue;
    }
    const h = !inFence ? /^(#{1,6})\s+(.+?)\s*$/.exec(line) : null;
    if (h) {
      flush();
      const level = h[1]!.length;
      let title = h[2]!;
      let anchor: string | null = null;
      const explicit = /\{#([\w-]+)\}\s*$/.exec(title);
      if (explicit) {
        anchor = explicit[1]!;
        title = title.replace(/\s*\{#[\w-]+\}\s*$/, "").trim();
      }
      current = { anchor: anchor ?? slugify(title), title, level, body: "" };
    } else if (current) {
      current.body += line + "\n";
    }
  }
  flush();
  return inits;
}
