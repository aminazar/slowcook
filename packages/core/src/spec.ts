// Spec and SpecIndex types — the shape of specs/story-N.yaml and specs/_index.yaml.
// These live in consumer repos, authored by the refinement agent (slowcook refine)
// and amended only through explicit "change-of-mind" revocations.

export type SpecStatus = "draft" | "active" | "superseded";

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

  related_specs?: RelatedSpec[];
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
