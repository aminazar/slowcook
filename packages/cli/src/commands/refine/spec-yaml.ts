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
  // design #8 — which viewport/scheme cells are in fidelity scope for the eye.
  // Dimension-value tokens (light|dark|mobile|desktop); the eye expands them to
  // the (declared-or-full) product. Absent = eye uses its full default matrix.
  fidelity: z.object({ modes: z.array(z.string()) }).optional(),
  // GUCDI — the primary persona this story serves in the whole-app LCR, and the
  // UI surfaces (routes) it contributes. `menu` emits these; the LCR plan
  // compiles them into the app's persona registry + navigation, and the
  // persona-surface trace lint checks each route resolves to a real router path.
  // GUCDI — the product THEME this story belongs to (an Epic in the EPSS test
  // matrix). Groups acceptance-scenario test cases across personas — e.g. "Founder
  // onboarding" spanning founder + operator. Absent = the LCR derives a label from
  // the prd_ref anchor.
  epic: z.string().optional(),
  persona: z
    .object({ id: z.string(), label: z.string().optional(), chrome: z.enum(["member", "public", "admin"]).optional() })
    .optional(),
  surfaces: z
    .array(
      z.object({
        route: z.string(),
        name: z.string().optional(),
        persona: z.string().optional(),
        home: z.boolean().optional(),
        states: z.array(z.string()).optional(),
      })
    )
    .optional(),
  // GUCDI — provenance anchor to a PRD initiative (greenfield only). OPTIONAL:
  // brownfield specs trace via source_issue instead, and `trace check` NEVER
  // demands a prd_ref (provenance is the union {issue|prd|convention|craft}).
  prd_ref: z
    .object({
      file: z.string(),
      anchor: z.string(),
      /** Fingerprint of the anchor's PRD body at stamp time (`trace stamp`).
       *  Lets `trace check` detect when the PRD section moved out from under the
       *  spec. Absent = never stamped. See trace/check.ts `anchorHash`. */
      sha: z.string().optional(),
    })
    .optional(),
  // GUCDI — the data contract this story needs, baked into the LCR's SQLite+ORM
  // schema and inherited by the backend (mock→prod becomes a data-source swap).
  data_contract: z
    .object({
      entities: z
        .array(
          z.object({
            name: z.string(),
            fields: z.array(z.object({ name: z.string(), type: z.string() })).optional(),
            relations: z.array(z.string()).optional(),
          }),
        )
        .optional(),
      api: z
        .array(z.object({ method: z.string(), path: z.string(), note: z.string().optional() }))
        .optional(),
    })
    .optional(),
  // GUCDI — open questions surfaced at decomposition or via path-discovery.
  // addressable = must resolve before the scope is "complete"; deferred = parked.
  open_questions: z
    .object({ addressable: z.array(z.string()), deferred: z.array(z.string()) })
    .optional(),
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
  /**
   * 0.19.0-α.34 (sc#67) — canonical story cost. Aggregated from the
   * `specs/story-<id>.cost.jsonl` sidecar by `applyCostToSpec`. Optional
   * because older specs predate this and the sidecar is the
   * source-of-truth — the spec field is a glance-readable mirror.
   */
  cost: z.object({
    total_usd: z.number(),
    last_updated: z.string(),
  }).optional(),
}).passthrough();

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

/**
 * Coerce "helpfully structured" array entries back to strings, matching the
 * Spec schema (acceptance_scenarios et al. are `string[]`). Agents — menu AND
 * refine — emit a {given,when,then} BDD object for an entry even when told to
 * emit strings; normalise at ingestion. Shared so both producers agree.
 * Non-breaking: well-formed string entries pass through unchanged.
 */
export function normalizeScenarioArrays<T extends Record<string, unknown>>(doc: T): T {
  if (!doc || typeof doc !== "object") return doc;
  const out = { ...doc } as Record<string, unknown>;
  for (const key of ["acceptance_scenarios", "preconditions", "invariants", "non_goals"]) {
    const val = out[key];
    if (!Array.isArray(val)) continue;
    out[key] = val.map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object") {
        const o = entry as Record<string, unknown>;
        const given = o.given ?? o.Given, when = o.when ?? o.When, then = o.then ?? o.Then;
        if (typeof given === "string" && typeof when === "string" && typeof then === "string")
          return `Given ${given}, When ${when}, Then ${then}`;
      }
      return `[NORMALIZED_OBJECT] ${JSON.stringify(entry)}`;
    });
  }
  return out as T;
}

/**
 * Entries the normalizer could only mark, not repair (ledger G25): a
 * scenario written with unquoted YAML-meaningful characters (the rewo
 * amendment's inline `{ from_id: ..., to_id: ... }` call syntax) parses
 * as a nested map and survives only as a "[NORMALIZED_OBJECT]" stub.
 * Persisting the stub poisons every downstream consumer — emissions
 * carrying any casualty must FAIL, with this list as the feedback.
 */
export function normalizationCasualties(spec: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["acceptance_scenarios", "preconditions", "invariants", "non_goals"]) {
    const val = spec[key];
    if (!Array.isArray(val)) continue;
    for (const entry of val) {
      if (typeof entry === "string" && entry.startsWith("[NORMALIZED_OBJECT]")) {
        out.push(`${key}: ${entry.slice(0, 120)}…`);
      }
    }
  }
  return out;
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
    } catch (e) {
      // (c) Don't silently swallow — a dropped spec that looks like "0 stories"
      // is a lie that costs hours. Surface it so the operator sees the real cause.
      console.warn(`  ⚠ skipping invalid spec ${f}: ${e instanceof Error ? e.message : String(e)}`);
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
 *
 * `scope` (dovizir handover §3) keeps the branch scan inside THIS project's
 * namespace. Story numbering is per-project: in a monorepo, contracts/story-001
 * and notes/story-001 are different stories, so an unscoped scan would make the
 * second project skip 001 purely because the first had used it.
 */
export async function nextStoryId(
  repoRoot: string,
  forge?: ForgeAdapter,
  scope = ""
): Promise<string> {
  const index = readIndex(repoRoot);
  const fromIndex = Object.keys(index.stories)
    .map((id) => parseInt(id, 10))
    .filter((n) => !isNaN(n));

  // Brownfield guard: repos whose specs predate slowcook (or were written by
  // other tooling) have `specs/story-*.yaml` files but no `_index.yaml` — the
  // files are the ground truth. Without this, refine allocated "001" into a
  // repo holding 58 stories and OVERWROTE story-001 (found dogfooding dash).
  let fromFiles: number[] = [];
  try {
    fromFiles = readdirSync(join(repoRoot, SPECS_DIR))
      .map((f) => /^story-(\d+)\.yaml$/.exec(f)?.[1])
      .filter((id): id is string => id !== undefined)
      .map((id) => parseInt(id, 10))
      .filter((n) => !isNaN(n));
  } catch {
    // no specs/ dir yet — fine, fresh repo.
  }

  let fromBranches: number[] = [];
  if (forge) {
    try {
      const prefix = scope ? `slowcook/spec/${scope}/story-` : "slowcook/spec/story-";
      const branches = await forge.listBranchesMatching(prefix);
      fromBranches = branches
        .map((b) => b.slice(prefix.length))
        .map((id) => parseInt(id, 10))
        .filter((n) => !isNaN(n));
    } catch {
      // Best-effort: if the listing fails (rate limit, etc.), fall back to
      // index-only. Collision risk returns but behaviour stays sane.
    }
  }

  const all = [...fromIndex, ...fromFiles, ...fromBranches, 0];
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
