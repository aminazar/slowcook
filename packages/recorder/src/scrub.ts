/**
 * Pre-save scrubber for recorded fixtures. Replaces volatile fields with
 * placeholders so committed JSON doesn't leak secrets, personal data, or
 * make the fixture non-deterministic.
 *
 * Defaults are loud: every UUID / email / bearer / timestamp pattern is
 * scrubbed unless the consumer adds an allow-list entry. Additive —
 * consumers extend via the `custom` field.
 *
 * Post-scrub CI guard: any fixture file whose content still matches a
 * leaked-secret regex fails `slowcook fixtures check`.
 */

const DEFAULT_PATTERNS: { name: string; re: RegExp; replacement: string }[] = [
  // UUID v4 (with dashes)
  {
    name: "uuid",
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    replacement: "<UUID>",
  },
  // ISO 8601 timestamps (with optional milliseconds + Z)
  {
    name: "iso-timestamp",
    re: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z?\b/g,
    replacement: "<TIMESTAMP>",
  },
  // Email addresses (RFC-5322 shallow)
  {
    name: "email",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replacement: "<EMAIL>",
  },
  // JWT tokens (three base64url segments separated by dots)
  {
    name: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: "<JWT>",
  },
  // Supabase anon / service keys (sbp_*, sb_*)
  {
    name: "supabase-key",
    re: /\b(?:sbp|sb)_[A-Za-z0-9]{20,}\b/g,
    replacement: "<SUPABASE_KEY>",
  },
  // Bearer tokens with "Bearer " prefix
  {
    name: "bearer",
    re: /Bearer\s+[A-Za-z0-9_\-.]{20,}/g,
    replacement: "Bearer <TOKEN>",
  },
];

export interface ScrubConfig {
  /** Keep these raw strings as-is (wins over the default patterns). */
  allowList?: string[];
  /** Extra patterns to apply on top of defaults. */
  custom?: { name: string; pattern: RegExp; replacement: string }[];
  /** Skip specific default patterns by name. */
  skip?: string[];
}

/**
 * Scrub a JSON-shaped value. Mutates nothing; returns a cleaned clone.
 */
export function scrub(value: unknown, config: ScrubConfig = {}): unknown {
  const allowList = new Set(config.allowList ?? []);
  const patterns = [
    ...DEFAULT_PATTERNS.filter((p) => !config.skip?.includes(p.name)),
    ...(config.custom ?? []).map((p) => ({
      name: p.name,
      re: p.pattern,
      replacement: p.replacement,
    })),
  ];

  const scrubString = (s: string): string => {
    if (allowList.has(s)) return s;
    let out = s;
    for (const { re, replacement } of patterns) {
      out = out.replace(re, replacement);
    }
    return out;
  };

  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrubString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };

  return walk(value);
}

/**
 * Guard: returns the list of patterns a value still matches AFTER
 * scrubbing. Empty array = clean. CI runs this on every committed
 * fixture. Non-empty output blocks the PR.
 */
export function detectUnscrubbed(
  value: unknown,
  config: ScrubConfig = {}
): { pattern: string; hit: string }[] {
  const hits: { pattern: string; hit: string }[] = [];
  const allowList = new Set(config.allowList ?? []);
  const patterns = [
    ...DEFAULT_PATTERNS.filter((p) => !config.skip?.includes(p.name)),
    ...(config.custom ?? []).map((p) => ({
      name: p.name,
      re: p.pattern,
      replacement: p.replacement,
    })),
  ];

  const checkString = (s: string): void => {
    if (allowList.has(s)) return;
    for (const { name, re } of patterns) {
      // Reset regex state for global regexes
      re.lastIndex = 0;
      const match = re.exec(s);
      if (match && match[0] !== undefined) {
        hits.push({ pattern: name, hit: match[0] });
      }
    }
  };

  const walk = (v: unknown): void => {
    if (typeof v === "string") checkString(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };

  walk(value);
  return hits;
}
