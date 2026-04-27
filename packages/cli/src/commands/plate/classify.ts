/**
 * PM-comment classifier — 0.16.0-α.7.
 *
 * Each element-anchored review-overlay comment on a slowcook-mockup PR
 * gets categorized so plate knows what to do with it:
 *
 *   - "cosmetic"      → amend the mock with minimum diff
 *   - "spec-altering" → ESCALATE: would invalidate a spec assertion or
 *                       acceptance scenario; PM must confirm the spec
 *                       change before plate touches the mock
 *   - "mock-divergence" → the mock diverged from the spec; align mock
 *                         to spec; note in summary why the PM ask is
 *                         being interpreted this way
 *
 * α.7 ships a deterministic heuristic. Each classification has a clear
 * rationale string so the escalation comment can quote the trigger.
 *
 * Heuristic structure:
 *   1. Parse the spec YAML to extract the salient assertion targets:
 *        - acceptance_scenarios prose lines
 *        - api_contract response field names
 *        - invariants prose
 *        - ui_behavior viewport prose
 *      → a flat set of "spec terms" (lowercased, normalized words).
 *   2. Score the comment prose against those terms:
 *        - any direct mention of an acceptance keyword phrase     → spec-altering
 *        - mention of a domain noun + a "remove/change/replace"   → spec-altering
 *        - mentions only adjective/style words (color, padding,   → cosmetic
 *          font, spacing, alignment, shadow, etc.)
 *        - else                                                   → mock-divergence
 *
 * The heuristic is intentionally conservative on spec-altering: false
 * positives only cost a PM confirm round; false negatives let plate
 * silently weaken the spec, which is the failure mode the architecture
 * is designed to prevent. When in doubt → escalate.
 *
 * No LLM dep here — pure functions over inputs. LLM-backed classifier
 * is a future α.7.1 upgrade if heuristic shows real misses.
 */

export type Classification = "cosmetic" | "spec-altering" | "mock-divergence";

export interface ClassifyResult {
  classification: Classification;
  /** Why this classification — included verbatim in escalation comments. */
  rationale: string;
  /** The spec terms (if any) that matched in the comment prose. */
  matchedSpecTerms: string[];
}

const COSMETIC_WORDS = [
  "color", "colour", "shade", "tint", "hue", "rgb", "hex",
  "padding", "margin", "spacing", "gap", "indent",
  "font", "typeface", "weight", "italic", "underline",
  "alignment", "align", "center", "centre", "left-aligned", "right-aligned",
  "shadow", "border", "outline", "radius", "rounded",
  "size", "smaller", "bigger", "larger", "tighter", "looser",
  "background", "bg",
  "icon", "emoji",
  "feel", "vibe", "look",
  "ratio", "scale",
];

const STRUCTURAL_VERBS = [
  "remove", "removed", "delete", "deleted", "drop",
  "replace", "swap", "switch",
  "add", "introduce", "include",
  "change", "rename",
  "split", "merge", "combine",
  "block", "prevent", "disallow",
  "require", "enforce",
];

export interface ClassifyArgs {
  /** Free prose written by the PM in the review-overlay comment. */
  prose: string;
  /**
   * Spec YAML body. Hand-parsed for the assertion targets; we don't
   * need a full YAML parser since the heuristic only needs salient
   * words from acceptance_scenarios / invariants / api_contract.
   */
  specYaml: string;
}

export function classifyComment(args: ClassifyArgs): ClassifyResult {
  const proseNorm = normalize(args.prose);
  const specTerms = extractSpecTerms(args.specYaml);
  const matched: string[] = [];
  for (const term of specTerms) {
    if (proseNorm.includes(term)) matched.push(term);
  }

  const cosmeticHits = COSMETIC_WORDS.filter((w) => containsWord(proseNorm, w));
  const structuralVerb = STRUCTURAL_VERBS.find((v) => containsWord(proseNorm, v));

  // Rule 1 — spec term + structural verb → spec-altering. Highest
  // priority; this is the failure mode we MUST escalate. "Remove the
  // pinned strip" / "replace pinned with bookmarked" etc.
  if (matched.length > 0 && structuralVerb) {
    return {
      classification: "spec-altering",
      rationale:
        `Mentions spec term${matched.length > 1 ? "s" : ""} (${matched.slice(0, 5).map((m) => `"${m}"`).join(", ")}) ` +
        `together with structural verb "${structuralVerb}". This would change the spec's contract; ` +
        `PM must confirm before the mock changes.`,
      matchedSpecTerms: matched,
    };
  }

  // Rule 2 — cosmetic word present (with or without spec term, but
  // no structural verb) → cosmetic. A PM saying "the Pinned button
  // background should be coral" is naming the element AND asking for
  // a style change; that's still cosmetic. Amend the mock with min diff.
  if (cosmeticHits.length > 0) {
    return {
      classification: "cosmetic",
      rationale:
        `Style-only feedback (matched: ${cosmeticHits.slice(0, 5).map((w) => `"${w}"`).join(", ")})` +
        (matched.length > 0
          ? `; spec term${matched.length > 1 ? "s" : ""} (${matched.slice(0, 3).map((m) => `"${m}"`).join(", ")}) named the element but no structural verb present.`
          : `; no spec terms triggered.`),
      matchedSpecTerms: matched,
    };
  }

  // Rule 3 — spec terms with no cosmetic word and no structural verb
  // → mock-divergence. The PM is talking about something the spec
  // mentions but neither styling it nor changing the contract.
  // Likely "mock shows X but spec says Y."
  if (matched.length > 0) {
    return {
      classification: "mock-divergence",
      rationale:
        `Mentions spec term${matched.length > 1 ? "s" : ""} (${matched.slice(0, 5).map((m) => `"${m}"`).join(", ")}) ` +
        `without a structural verb or styling cue. Likely the mock diverged from spec; align mock to spec.`,
      matchedSpecTerms: matched,
    };
  }

  // Rule 4 — fallthrough. No signal in any direction. Default to
  // mock-divergence so plate's LLM still gets the chance to reason
  // about both spec + comment in context (false-positive cost is low).
  return {
    classification: "mock-divergence",
    rationale:
      `No clear spec or style signal in the prose. Defaulting to mock-divergence so plate has a chance to reconcile against the spec.`,
    matchedSpecTerms: [],
  };
}

/**
 * Extract candidate "spec terms" — lowercase, deduplicated significant
 * tokens from the spec sections plate cares about. Used by the
 * classifier to detect overlap between PM prose and spec assertions.
 */
export function extractSpecTerms(specYaml: string): string[] {
  const sections = ["acceptance_scenarios", "invariants", "api_contract"];
  const terms = new Set<string>();
  // Also include ui_behavior viewport prose — a comment about
  // "remove the desktop_light pinned strip" is spec-altering.
  for (const sec of [...sections, "ui_behavior"]) {
    const body = extractYamlSection(specYaml, sec);
    if (!body) continue;
    for (const tok of tokenize(body)) {
      if (isStopword(tok)) continue;
      if (tok.length < 4) continue; // skip short noise
      terms.add(tok);
    }
  }
  return Array.from(terms);
}

function extractYamlSection(yaml: string, sectionName: string): string {
  // Find the line `sectionName:` at indent 0; capture indented body
  // until the next zero-indent line.
  const lines = yaml.split(/\r?\n/);
  const out: string[] = [];
  let inSection = false;
  for (const raw of lines) {
    const m = raw.match(/^(\s*)([a-zA-Z_][\w]*)\s*:/);
    if (m && m[1]!.length === 0) {
      if (m[2] === sectionName) {
        inSection = true;
        continue;
      } else if (inSection) {
        // hit a sibling top-level key
        break;
      }
    }
    if (inSection) out.push(raw);
  }
  return out.join("\n");
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(s: string): string[] {
  // Split on non-word; preserve underscores (snake_case identifiers)
  return s
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length > 0);
}

function containsWord(haystackNorm: string, needle: string): boolean {
  // Word-boundary check; needle is already lowercase.
  const re = new RegExp(`(^|[^a-z0-9_])${escapeRe(needle)}([^a-z0-9_]|$)`);
  return re.test(haystackNorm);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STOPWORDS = new Set([
  "the","a","an","and","or","but","of","in","on","at","to","for","with","by","is","are","was","were","be","been","being","have","has","had","do","does","did","this","that","these","those","it","its","as","if","then","else","when","while","each","every","any","all","not","no","yes","true","false","null","can","will","may","must","should","would","also","only","very","more","most","such","than","into","from","over","under","between","through","because","since","once","yaml","example","note","todo","null_","status","approved","draft","paused","active",
]);

function isStopword(w: string): boolean {
  if (STOPWORDS.has(w)) return true;
  // Pure-numeric tokens are noise
  if (/^[0-9]+$/.test(w)) return true;
  return false;
}
