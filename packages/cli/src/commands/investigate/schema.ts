/**
 * BugProfile — the artefact emitted by `slowcook investigate`.
 *
 * Lives at `.brewing/bug-profiles/B-<id>.yaml`. Plays the role for
 * the bug-fix flow that `specs/story-N.yaml` plays for the story
 * flow: the contract between investigate (or refine) and the next
 * agent down the pipeline (sift / brew).
 *
 * v1 (slowcook 0.13.0) shape. Schema version bump on any field
 * removal or rename.
 */

export const BUG_PROFILE_SCHEMA_VERSION = 1 as const;

/**
 * Bug ids are sequential under `B-<n>`. The numbering is independent
 * of `story-<NNN>` — bugs and stories are different artefact types.
 * Race-condition collision avoidance: same logic as story-id picker
 * (slowcook#8 fix); the picker walks `.brewing/bug-profiles/` and
 * matching `slowcook/bug-profile/B-*` branches before assigning.
 */
export type BugId = string; // "B-1", "B-42", etc.

export interface FailureLocus {
  /** Repo-relative path where the failure originates (or where the
   *  fix should land if multi-site). Always present. */
  file: string;
  /** 1-based line of the offending statement when known. */
  line?: number;
  /** Function / method / route name when known. */
  function?: string;
  /** One-paragraph human-readable diagnosis from the investigate
   *  agent. The "why broken", not the "how to fix" — fix-shaping
   *  happens in sift. */
  diagnosis: string;
}

export interface RelatedSpec {
  /** Spec or bug id that's relevant context. */
  id: string;
  /** Relationship hint — guides chef when sequencing fixes. */
  relationship: "touches" | "supersedes" | "related" | "duplicates";
  /** One-line explanation. Optional. */
  note?: string;
}

export interface BugProfile {
  /** $schema field for editor tooling. */
  $schema?: string;
  schema_version: typeof BUG_PROFILE_SCHEMA_VERSION;
  bug_id: BugId;
  /** Human title — usually a paraphrase of the issue title. */
  title: string;
  /** GitHub issue number (`#NNN`). */
  source_issue: string;
  /** Lifecycle. Mirrors story-flow status semantics. */
  status: "investigated" | "recipe-emitted" | "sifted" | "shipped" | "closed";
  /** Investigate agent + version that emitted this profile. */
  investigated_by: string;
  /** ISO-8601 timestamp of emission. */
  created_at: string;

  /** What the user / reporter sees. Verbatim or close-paraphrase
   *  from the issue body. Refine-style paraphrasing is forbidden;
   *  see the "PM intent carries weight" rule. */
  symptom: string[];
  /** What the system should do instead. Often inferable from the
   *  issue body; otherwise asked of the PM. */
  expected: string[];
  /** Minimum repro steps. Often a one-liner ("load /feed as authed
   *  user"); rarely longer than 3 steps. */
  reproduction: string[];

  /** Where the bug actually lives in the code. The investigate
   *  agent's job is to find this. */
  failure_locus: FailureLocus;

  /** What the regression test should assert in plain English.
   *  recipe --regression turns this into a vitest file. */
  regression_assertion: string[];

  /** Paths the fix is allowed to touch. Sift uses this as
   *  allowed_paths. Narrow on purpose — bug fixes shouldn't sprawl. */
  fix_scope: string[];

  /** Stories or bugs this fix interacts with. */
  related_specs?: RelatedSpec[];
}

/**
 * Validate a parsed YAML object against the schema. Returns
 * `{ ok: true, profile }` on success, `{ ok: false, errors }`
 * otherwise. Hand-rolled; we don't want a JSON-schema dep.
 */
export function validateBugProfile(input: unknown): {
  ok: true;
  profile: BugProfile;
} | {
  ok: false;
  errors: string[];
} {
  const errors: string[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ["root must be an object"] };
  }
  const obj = input as Record<string, unknown>;

  const schemaVersion = obj["schema_version"];
  if (schemaVersion !== BUG_PROFILE_SCHEMA_VERSION) {
    errors.push(
      `schema_version must be ${BUG_PROFILE_SCHEMA_VERSION}, got ${String(schemaVersion)}`
    );
  }

  const requireString = (key: string): string | null => {
    const v = obj[key];
    if (typeof v !== "string" || v.length === 0) {
      errors.push(`${key} must be a non-empty string`);
      return null;
    }
    return v;
  };
  const requireStringArray = (key: string): string[] | null => {
    const v = obj[key];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      errors.push(`${key} must be an array of strings`);
      return null;
    }
    return v as string[];
  };

  const bugId = requireString("bug_id");
  if (bugId && !/^B-\d+$/.test(bugId)) {
    errors.push(`bug_id must match /^B-\\d+$/ (got "${bugId}")`);
  }
  const sourceIssue = requireString("source_issue");
  if (sourceIssue && !/^#\d+$/.test(sourceIssue)) {
    errors.push(`source_issue must match /^#\\d+$/ (got "${sourceIssue}")`);
  }
  requireString("title");
  requireString("status");
  requireString("investigated_by");
  requireString("created_at");
  requireStringArray("symptom");
  requireStringArray("expected");
  requireStringArray("reproduction");
  requireStringArray("regression_assertion");
  requireStringArray("fix_scope");

  const locus = obj["failure_locus"];
  if (!isPlainObject(locus)) {
    errors.push("failure_locus must be an object");
  } else {
    const l = locus as Record<string, unknown>;
    if (typeof l["file"] !== "string" || l["file"].length === 0) {
      errors.push("failure_locus.file must be a non-empty string");
    }
    if (typeof l["diagnosis"] !== "string" || l["diagnosis"].length === 0) {
      errors.push("failure_locus.diagnosis must be a non-empty string");
    }
    if (l["line"] !== undefined && typeof l["line"] !== "number") {
      errors.push("failure_locus.line must be a number when present");
    }
    if (l["function"] !== undefined && typeof l["function"] !== "string") {
      errors.push("failure_locus.function must be a string when present");
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, profile: obj as unknown as BugProfile };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
