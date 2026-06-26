// Spec and SpecIndex types — the shape of specs/story-N.yaml and specs/_index.yaml.
// These live in consumer repos, authored by the refinement agent (slowcook refine)
// and amended only through explicit "change-of-mind" revocations.

export type SpecStatus = "draft" | "active" | "superseded";

/** T-shirt size for the budgeting `effort` block (relative sizing per dimension). */
export type EffortSize = "xs" | "s" | "m" | "l" | "xl";

export type RelationshipKind = "overlap" | "related" | "superseded";

export interface Actor {
  name: string;
  notes?: string;
}

export interface ApiEndpoint {
  method: string;
  path: string;
  /** Free-form schema description; deliberately not a strict type to keep refinement flexible. */
  request_schema?: unknown;
  responses?: Record<string, unknown>;
}

export interface UiBehavior {
  [viewportScheme: string]: string;
}

export interface RelatedSpec {
  id: string;
  relationship: RelationshipKind;
  note?: string;
}

/**
 * Status of a single proposal within a spec. Proposals are refine-agent-
 * generated defaults for missing context (schema, UI layout, routes, etc.)
 * that the issue author didn't specify. Humans review + resolve each.
 *
 * - `pending` — refine emitted a proposal; awaiting human sign-off
 * - `approved` — human signed off (approved_by + approved_at populated)
 * - `rejected` — human rejected; proposal ignored downstream, refine
 *   should regenerate or ask clarifying questions on the next run
 * - `deferred` — refine decided the story is small enough that the gap
 *   doesn't matter (e.g., no perf budget for a read-only GET); reason
 *   captured in the proposal's `rationale`
 * - `blocked_on_clarification` — refine couldn't propose defensibly
 *   without more info from the operator; clarifying question asked
 */
export type ProposalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "deferred"
  | "blocked_on_clarification";

interface ProposalBase {
  status: ProposalStatus;
  proposed_by: string;
  approved_by?: string;
  approved_at?: string;
  rationale?: string;
}

export interface SchemaProposal extends ProposalBase {
  /** Raw DDL — human reads, PR body renders as Mermaid ERD. */
  sql: string;
}

export interface UiLayoutProposal extends ProposalBase {
  viewport_coverage?: string[];
  components_to_reuse?: string[];
  tokens_to_reuse?: string[];
  tokens_to_add?: string[];
}

export interface RoutesProposal extends ProposalBase {
  paths: Array<{ path: string; file: string }>;
}

export interface AuthProposal extends ProposalBase {
  requirements?: string[];
}

export interface PerfBudgetProposal extends ProposalBase {
  budgets?: Record<string, number>;
}

export interface ObservabilityProposal extends ProposalBase {
  log_events?: string[];
  metrics?: Array<{ name: string; type: string }>;
}

export interface InfraProposal extends ProposalBase {
  runtime?: string;
  deploy_target?: string;
  /** Free-form notes on cloud/facility choices when applicable. */
  notes?: string;
}

export interface ApiShapeProposal extends ProposalBase {
  endpoints?: Array<{
    method: string;
    path: string;
    request_schema?: unknown;
    responses?: Record<string, unknown>;
  }>;
}

/**
 * 0.14.0-α.1 (mockup-first refinement, data-layer seam) — fixtures
 * keyed by domain (a single-word slug for the story's primary
 * resource: `notifications`, `bookmarks`). Each domain's `seed` is
 * an arbitrary record of named exports the generated
 * `src/lib/data/<domain>.mock.ts` will emit verbatim.
 */
export interface FixturesProposal extends ProposalBase {
  by_domain?: Record<string, { seed: Record<string, unknown> }>;
}

/**
 * Proposals block — optional; absent on specs authored pre-0.11 or on
 * stories where no gaps were detected.
 */
export interface SpecProposals {
  schema?: SchemaProposal;
  ui_layout?: UiLayoutProposal;
  routes?: RoutesProposal;
  auth?: AuthProposal;
  perf_budget?: PerfBudgetProposal;
  observability?: ObservabilityProposal;
  infra?: InfraProposal;
  api_shape?: ApiShapeProposal;
  /** 0.14.0-α.1 mockup-first data-layer seam — see FixturesProposal. */
  fixtures?: FixturesProposal;
}

export interface Spec {
  $schema?: string;
  story_id: string;
  title: string;
  status: SpecStatus;
  created_at: string;
  /** Story IDs this spec revokes (change-of-mind). */
  supersedes: string[];
  /** If this spec has itself been revoked, the newer story ID. */
  superseded_by: string | null;
  /** Dollar cap for the brew phase; optional here. */
  token_budget_usd?: number;
  estimate?: "small" | "medium" | "large";

  source_issue?: string;
  refined_by?: string;

  actors: Actor[];
  preconditions: string[];
  invariants: string[];
  api_contract?: ApiEndpoint[];
  ui_behavior?: UiBehavior;
  acceptance_scenarios: string[];
  non_goals: string[];

  /** design #8 — viewport/scheme/locale modes the fidelity eye must check. */
  fidelity?: { modes: string[] };
  /**
   * GUCDI — provenance anchor to a PRD initiative (greenfield only; optional).
   * Brownfield traces via `source_issue`. `trace check` never demands this.
   */
  prd_ref?: { file: string; anchor: string; sha?: string };
  /**
   * GUCDI — the data contract this story needs, baked into the LCR's SQLite+ORM
   * schema and inherited by the backend (mock→prod becomes a data-source swap).
   */
  data_contract?: {
    entities?: { name: string; fields?: { name: string; type: string }[]; relations?: string[] }[];
    api?: { method: string; path: string; note?: string }[];
  };
  /**
   * GUCDI — the primary persona this story serves in the whole-app LCR. `chrome`
   * selects the shell variant (member sidebar / public nav / admin toolbar).
   * `menu` emits this; the LCR plan compiles it into the app's persona registry.
   */
  /**
   * GUCDI — the product THEME this story belongs to (an Epic in the EPSS test
   * matrix). Groups acceptance-scenario test cases across personas. Absent = the
   * LCR derives a label from the prd_ref anchor.
   */
  epic?: string;
  /**
   * Budgeting — the agent's earliest (post-`menu`) RELATIVE effort estimate. The
   * LLM is poor at absolute hours but decent at relative sizing + naming drivers,
   * so it sizes each dimension t-shirt-style and flags the qualitative cost/risk
   * drivers that aren't countable from the spec; a calibrated deterministic model
   * (`slowcook estimate`) converts this + the countable drivers into a 3-point
   * dual-currency (tokens + manhours) estimate. `confidence` sets the cone band
   * width; `risk` adds variance. See dash docs/BUDGETING-AND-ROADMAP.md.
   */
  effort?: {
    /** relative size of design (plate/vibe) work. */
    design: EffortSize;
    /** relative size of implementation (build) work. */
    build: EffortSize;
    /** relative size of test + manual QA work. */
    qa: EffortSize;
    /** qualitative cost/risk drivers the LLM identifies (not countable). */
    drivers: string[];
    /** delivery risk → variance + rework likelihood. */
    risk: "low" | "medium" | "high";
    /** 0–1, the agent's confidence in this sizing → cone band width. */
    confidence: number;
    /** one line: why this size (auditability). */
    rationale?: string;
  };
  persona?: { id: string; label?: string; chrome?: "member" | "public" | "admin" };
  /**
   * GUCDI — the UI surfaces this story contributes to the LCR. Each is a route
   * the whole-app mock must expose (every surface reachable, no auth walls).
   * `home: true` marks a persona's landing route; `states` lists the meaningful
   * data states the surface must render (empty / populated / error / edge).
   * The persona-surface trace lint checks each route resolves to a real router path.
   */
  surfaces?: { route: string; name?: string; persona?: string; home?: boolean; states?: string[] }[];
  /** GUCDI — open questions; addressable must resolve before the scope is "complete". */
  open_questions?: { addressable: string[]; deferred: string[] };

  related_specs?: RelatedSpec[];

  /**
   * Refine-agent proposals for gaps in the source issue (0.11+). Each
   * category is optional; proposals start `pending` and resolve to
   * approved/rejected/deferred as humans review. Brew reads `approved`
   * schema proposals to unlock allowed-paths for migrations.
   */
  proposals?: SpecProposals;

  /**
   * 0.19.0-α.34 (sc#67) — canonical story cost. Aggregated from the
   * `specs/story-<id>.cost.jsonl` sidecar by `applyCostToSpec`. Glance-
   * readable mirror; sidecar is the source-of-truth.
   */
  cost?: {
    total_usd: number;
    last_updated: string;
  };
}

export interface SpecIndexEntry {
  title: string;
  status: SpecStatus;
  source_issue?: string;
  tags?: string[];
  summary?: string;
  supersedes?: string[];
  superseded_by?: string | null;
}

export interface SpecIndex {
  $schema?: string;
  schema_version: 1;
  stories: Record<string, SpecIndexEntry>;
}

/**
 * Relationship verdict between a new issue and the existing spec corpus.
 * Produced by a "relationship analysis" LLM call before refinement proper.
 */
export type RelationshipVerdict =
  | { kind: "new_or_independent"; reasoning: string }
  | { kind: "overlap"; conflicting_ids: string[]; reasoning: string }
  | { kind: "contradiction"; conflicting_ids: string[]; reasoning: string }
  /**
   * New issue fulfills scope an active spec explicitly deferred via its
   * `non_goals` list. This is the "builds on top" pattern — common in
   * product work where a story intentionally defers scope (to stay
   * shippable) that a later story picks up. The prior spec's non_goals
   * is a positive invitation for this follow-up, not a red flag.
   *
   * Handling: refinement CONTINUES (no halt). The resulting spec should
   * cite the predecessor(s) in its `related_specs` with relationship
   * "related" and a note explaining what non-goal is now in scope.
   */
  | { kind: "follow_up"; related_ids: string[]; reasoning: string };

export function makeEmptyIndex(): SpecIndex {
  return {
    $schema: "./index.schema.json",
    schema_version: 1,
    stories: {},
  };
}

/**
 * Apply a supersede: mark old stories as superseded_by the new one,
 * and add the new story to the index as active. Pure.
 */
export function applySupersede(
  index: SpecIndex,
  newStory: { id: string; entry: SpecIndexEntry },
  supersededIds: string[]
): SpecIndex {
  const next: SpecIndex = {
    ...index,
    stories: { ...index.stories },
  };
  for (const oldId of supersededIds) {
    const existing = next.stories[oldId];
    if (!existing) continue;
    next.stories[oldId] = {
      ...existing,
      status: "superseded",
      superseded_by: newStory.id,
    };
  }
  next.stories[newStory.id] = {
    ...newStory.entry,
    supersedes: supersededIds.length > 0 ? supersededIds : (newStory.entry.supersedes ?? []),
  };
  return next;
}
