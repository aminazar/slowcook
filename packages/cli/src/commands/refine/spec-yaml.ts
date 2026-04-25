import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import {
  makeEmptyIndex,
  type Spec,
  type SpecIndex,
  type SpecIndexEntry,
  type ForgeAdapter,
} from "@slowcook-ai/core";

/** Where specs live, relative to repo root. */
export const SPECS_DIR = "specs";
export const INDEX_FILE = join(SPECS_DIR, "_index.yaml");

const SpecStatusSchema = z.enum(["draft", "active", "superseded"]);

const SpecIndexEntrySchema = z.object({
  title: z.string(),
  status: SpecStatusSchema,
  source_issue: z.string().optional(),
  tags: z.array(z.string()).optional(),
  summary: z.string().optional(),
  supersedes: z.array(z.string()).optional(),
  superseded_by: z.union([z.string(), z.null()]).optional(),
});

const SpecIndexSchema = z.object({
  $schema: z.string().optional(),
  schema_version: z.literal(1),
  stories: z.record(z.string(), SpecIndexEntrySchema),
});

const ProposalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "deferred",
  "blocked_on_clarification",
]);

const ProposalBaseSchema = z.object({
  status: ProposalStatusSchema,
  proposed_by: z.string(),
  approved_by: z.string().optional(),
  approved_at: z.string().optional(),
  rationale: z.string().optional(),
});

export const SpecProposalsSchema = z.object({
  schema: ProposalBaseSchema.extend({ sql: z.string() }).optional(),
  ui_layout: ProposalBaseSchema.extend({
    viewport_coverage: z.array(z.string()).optional(),
    components_to_reuse: z.array(z.string()).optional(),
    tokens_to_reuse: z.array(z.string()).optional(),
    tokens_to_add: z.array(z.string()).optional(),
  }).optional(),
  routes: ProposalBaseSchema.extend({
    paths: z.array(z.object({ path: z.string(), file: z.string() })),
  }).optional(),
  auth: ProposalBaseSchema.extend({
    requirements: z.array(z.string()).optional(),
  }).optional(),
  perf_budget: ProposalBaseSchema.extend({
    budgets: z.record(z.string(), z.number()).optional(),
  }).optional(),
  observability: ProposalBaseSchema.extend({
    log_events: z.array(z.string()).optional(),
    metrics: z
      .array(z.object({ name: z.string(), type: z.string() }))
      .optional(),
  }).optional(),
  infra: ProposalBaseSchema.extend({
    runtime: z.string().optional(),
    deploy_target: z.string().optional(),
    notes: z.string().optional(),
  }).optional(),
  api_shape: ProposalBaseSchema.extend({
    endpoints: z
      .array(
        z.object({
          method: z.string(),
          path: z.string(),
          request_schema: z.unknown().optional(),
          responses: z.record(z.string(), z.unknown()).optional(),
        })
      )
      .optional(),
  }).optional(),
  /**
   * 0.14.0-α.1 (mockup-first refinement, data-layer seam) — fixtures
   * the agent has hand-authored to make a mockup behaviorally complete.
   * Keyed by domain (a single-word slug derived from the story's primary
   * resource: `notifications`, `bookmarks`, `feed`). Each domain's
   * `seed` is an arbitrary record of named arrays/values that the
   * generated `<domain>.mock.ts` will export verbatim.
   *
   * Example:
   *   fixtures:
   *     status: pending
   *     proposed_by: refine-agent
   *     by_domain:
   *       notifications:
   *         seed:
   *           list:
   *             - { id: "n-1", actor_handle: "@alice", read_at: null }
   *             - { id: "n-2", actor_handle: "@bob",   read_at: "2026-04-25T12:00:00Z" }
   *           unread_count: 1
   *
   * Refine writes `src/lib/data/notifications.mock.ts` exporting
   * `seed.list` and `seed.unread_count` as JSON-equivalent constants.
   * The page/component imports from `@/lib/data/notifications`; an
   * env flag `MOCK_STORY_N=1` routes the import to the mock module.
   * Brew (later) writes the real `notifications.ts` and removes the flag.
   */
  fixtures: ProposalBaseSchema.extend({
    by_domain: z
      .record(
        z.string(),
        z.object({
          seed: z.record(z.string(), z.unknown()),
        })
      )
      .optional(),
  }).optional(),
});

const SpecSchema = z.object({
  $schema: z.string().optional(),
  story_id: z.string(),
  title: z.string(),
  status: SpecStatusSchema,
  created_at: z.string(),
  supersedes: z.array(z.string()),
  superseded_by: z.union([z.string(), z.null()]),
  token_budget_usd: z.number().optional(),
  estimate: z.enum(["small", "medium", "large"]).optional(),
  source_issue: z.string().optional(),
  refined_by: z.string().optional(),
  actors: z.array(z.object({ name: z.string(), notes: z.string().optional() })),
  preconditions: z.array(z.string()),
  invariants: z.array(z.string()),
  api_contract: z.array(z.unknown()).optional(),
  ui_behavior: z.record(z.string(), z.string()).optional(),
  acceptance_scenarios: z.array(z.string()),
  non_goals: z.array(z.string()),
  related_specs: z
    .array(
      z.object({
        id: z.string(),
        relationship: z.enum(["overlap", "related", "superseded"]),
        note: z.string().optional(),
      })
    )
    .optional(),
  proposals: SpecProposalsSchema.optional(),
});

export function readIndex(repoRoot: string): SpecIndex {
  const path = join(repoRoot, INDEX_FILE);
  if (!existsSync(path)) return makeEmptyIndex();
  const raw = YAML.parse(readFileSync(path, "utf8"));
  const parsed = SpecIndexSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid ${INDEX_FILE}: ${parsed.error.issues.map((i) => i.message).join("; ")}`
    );
  }
  return parsed.data;
}

export function writeIndex(repoRoot: string, index: SpecIndex): void {
  const path = join(repoRoot, INDEX_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    YAML.stringify(index, { lineWidth: 0 }),
    "utf8"
  );
}

export function readSpec(repoRoot: string, storyId: string): Spec {
  const path = join(repoRoot, SPECS_DIR, `story-${storyId}.yaml`);
  const raw = YAML.parse(readFileSync(path, "utf8"));
  const parsed = SpecSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid spec at ${path}: ${parsed.error.issues.map((i) => i.message).join("; ")}`
    );
  }
  return parsed.data as Spec;
}

export function writeSpec(repoRoot: string, spec: Spec): string {
  const path = join(repoRoot, SPECS_DIR, `story-${spec.story_id}.yaml`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, YAML.stringify(spec, { lineWidth: 0 }), "utf8");
  return path;
}

export function listActiveSpecs(repoRoot: string): Spec[] {
  const dir = join(repoRoot, SPECS_DIR);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter(
    (f) => f.startsWith("story-") && f.endsWith(".yaml")
  );
  const specs: Spec[] = [];
  for (const f of files) {
    const id = f.replace(/^story-/, "").replace(/\.yaml$/, "");
    try {
      const s = readSpec(repoRoot, id);
      if (s.status === "active") specs.push(s);
    } catch {
      // ignore invalid specs; surface them elsewhere
    }
  }
  return specs;
}

/**
 * Allocate the next unused story ID (zero-padded 3 digits).
 *
 * Considers BOTH the local index (specs/_index.yaml on the checked-out branch)
 * AND remote branches matching `slowcook/spec/story-*`. This prevents story-ID
 * collisions when a spec PR is in flight (branch exists on remote but index on
 * main doesn't reflect it yet) or when two refinement runs overlap.
 *
 * `forge` is optional so callers without a forge (e.g., local tooling) can still
 * use the function — they just get a weaker guarantee (index-only).
 */
export async function nextStoryId(
  repoRoot: string,
  forge?: ForgeAdapter
): Promise<string> {
  const index = readIndex(repoRoot);
  const fromIndex = Object.keys(index.stories)
    .map((id) => parseInt(id, 10))
    .filter((n) => !isNaN(n));

  let fromBranches: number[] = [];
  if (forge) {
    try {
      const branches = await forge.listBranchesMatching("slowcook/spec/story-");
      fromBranches = branches
        .map((b) => b.replace(/^slowcook\/spec\/story-/, ""))
        .map((id) => parseInt(id, 10))
        .filter((n) => !isNaN(n));
    } catch {
      // Best-effort: if the listing fails (rate limit, etc.), fall back to
      // index-only. Collision risk returns but behaviour stays sane.
    }
  }

  const all = [...fromIndex, ...fromBranches, 0];
  return String(Math.max(...all) + 1).padStart(3, "0");
}

/** Public accessors for tests. */
export const schemas = {
  SpecIndex: SpecIndexSchema,
  Spec: SpecSchema,
  SpecIndexEntry: SpecIndexEntrySchema,
};

/** Minimal helper for the agent to build a SpecIndexEntry from a Spec. */
export function entryFromSpec(spec: Spec): SpecIndexEntry {
  return {
    title: spec.title,
    status: spec.status,
    source_issue: spec.source_issue,
    summary: spec.acceptance_scenarios[0]?.slice(0, 160),
    supersedes: spec.supersedes,
    superseded_by: spec.superseded_by,
  };
}
