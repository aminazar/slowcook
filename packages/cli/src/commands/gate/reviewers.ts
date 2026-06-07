/**
 * design #9 — HITL role gates: reviewer roster.
 *
 * Reads `.brewing/reviewers.yaml` to map review roles (pm, designer, qa,
 * …) to the GitHub handles authorised to satisfy that role's gate. This
 * roster is the trust anchor for the gate-integrity core: an approval
 * only counts if its author is a configured handle for the required
 * role (see `./model.js`).
 *
 * Handles are lowercased on load so downstream matching against the
 * (also lowercased) approver handle is case-insensitive — GitHub login
 * comparison is case-insensitive and a gate must not be bypassable by a
 * casing mismatch.
 *
 * Single source of truth: nothing else should hard-code the roster
 * location or shape.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";

const ReviewersConfigSchema = z.object({
  schema_version: z.literal(1),
  // role -> list of GitHub handles. Lowercased on load (see transform).
  roles: z
    .record(z.string(), z.array(z.string()))
    .default({})
    .transform((roles) => {
      const out: Record<string, string[]> = {};
      for (const [role, handles] of Object.entries(roles)) {
        out[role] = handles.map((h) => h.toLowerCase());
      }
      return out;
    }),
});

export type ReviewersConfig = z.infer<typeof ReviewersConfigSchema>;

const EMPTY_DEFAULT: ReviewersConfig = {
  schema_version: 1,
  roles: {},
};

/**
 * Load `.brewing/reviewers.yaml`. Returns an empty roster
 * (`{ schema_version: 1, roles: {} }`) when the file is absent — a repo
 * with no roster has no configured reviewers, so every role gate is
 * unsatisfiable until one is authored (fail-closed). Throws on parse
 * error / schema violation so a mis-authored roster surfaces loudly
 * rather than silently granting or denying approvals.
 */
export function loadReviewers(repoRoot: string): ReviewersConfig {
  const p = join(repoRoot, ".brewing", "reviewers.yaml");
  if (!existsSync(p)) {
    return { schema_version: 1, roles: {} };
  }
  const raw = YAML.parse(readFileSync(p, "utf8"));
  const parsed = ReviewersConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid .brewing/reviewers.yaml: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return parsed.data;
}

/**
 * Returns the configured handles for a role (already lowercased), or an
 * empty array when the role is unset. An empty array means the role can
 * never be satisfied — fail-closed by design.
 */
export function resolveRole(cfg: ReviewersConfig, role: string): string[] {
  return cfg.roles[role] ?? [];
}

export { EMPTY_DEFAULT };
