/**
 * GUCDI — LCR plan compiler (pure). The deterministic spine of the whole-app
 * `vibe` redesign: instead of generating one mock per story, vibe first compiles
 * ALL specs into a single coherent plan for one clickable LCR app —
 *   - the unified DATA MODEL (every story's `data_contract.entities` merged into
 *     one schema, with cross-story field conflicts surfaced) → the data adaptor's
 *     spine (a Drizzle/SQLite schema is generated from this);
 *   - the ROUTE / PERSONA map (from each story's `persona` + `surfaces`) → the
 *     app's navigation, every surface reachable;
 *   - per-story COVERAGE (which stories contribute a surface vs are backend-only).
 *
 * No LLM: this is aggregation over the specs. The schema/seed/surface GENERATION
 * passes (LLM) hang off this plan. See docs/plans/vibe-whole-mock-lcr.md.
 */

/** The slice of a spec the planner needs (kept minimal so the core stays pure +
 *  unit-testable independent of the full Spec type). */
export interface PlanSpecInput {
  storyId: string;
  entities: { name: string; fields: { name: string; type: string }[]; relations?: string[] }[];
  actors?: { name: string }[];
  persona?: { id: string; chrome?: string };
  surfaces?: { route: string; persona?: string; home?: boolean; states?: string[] }[];
}

export interface PlanField {
  name: string;
  type: string;
  fromStories: string[];
}
export interface PlanEntity {
  name: string;
  fields: PlanField[];
  relations: string[];
  fromStories: string[];
}
/** Same entity+field declared with divergent types across stories — the thing
 *  that silently breaks a hand-merged schema; we surface it for resolution. */
export interface FieldConflict {
  entity: string;
  field: string;
  types: { type: string; stories: string[] }[];
}
export interface PlanPersona {
  id: string;
  chrome?: string;
  fromStories: string[];
}
export interface PlanSurface {
  route: string;
  persona: string;
  storyId: string;
  home: boolean;
  states: string[];
}
export interface PlanStory {
  storyId: string;
  entities: string[];
  personas: string[];
  routes: string[];
  hasSurface: boolean;
}
export interface LcrPlan {
  entities: PlanEntity[];
  conflicts: FieldConflict[];
  personas: PlanPersona[];
  surfaces: PlanSurface[];
  stories: PlanStory[];
  /** stories that declare no surface — either a UI gap or a legitimately
   *  backend-only story (the planner can't tell; it reports). */
  uncoveredStories: string[];
}

function pushUnique(arr: string[], v: string): void {
  if (!arr.includes(v)) arr.push(v);
}

/** Merge every spec's data_contract.entities into one data model, unioning
 *  fields by name and tracking which stories contributed each entity/field.
 *  Divergent field types across stories become `conflicts`. */
function compileEntities(specs: PlanSpecInput[]): { entities: PlanEntity[]; conflicts: FieldConflict[] } {
  const byName = new Map<string, PlanEntity>();
  // entity → field → type → stories  (for conflict detection)
  const typeWitness = new Map<string, Map<string, Map<string, string[]>>>();

  for (const spec of specs) {
    for (const e of spec.entities) {
      let ent = byName.get(e.name);
      if (!ent) {
        ent = { name: e.name, fields: [], relations: [], fromStories: [] };
        byName.set(e.name, ent);
        typeWitness.set(e.name, new Map());
      }
      pushUnique(ent.fromStories, spec.storyId);
      for (const r of e.relations ?? []) pushUnique(ent.relations, r);

      const fieldWitness = typeWitness.get(e.name)!;
      for (const f of e.fields) {
        let field = ent.fields.find((x) => x.name === f.name);
        if (!field) {
          field = { name: f.name, type: f.type, fromStories: [] };
          ent.fields.push(field);
        }
        pushUnique(field.fromStories, spec.storyId);
        if (!fieldWitness.has(f.name)) fieldWitness.set(f.name, new Map());
        const types = fieldWitness.get(f.name)!;
        if (!types.has(f.type)) types.set(f.type, []);
        pushUnique(types.get(f.type)!, spec.storyId);
      }
    }
  }

  const conflicts: FieldConflict[] = [];
  for (const [entity, fields] of typeWitness) {
    for (const [field, types] of fields) {
      if (types.size > 1) {
        conflicts.push({
          entity,
          field,
          types: [...types.entries()].map(([type, stories]) => ({ type, stories })),
        });
      }
    }
  }

  return { entities: [...byName.values()], conflicts };
}

/** Compile the whole-app plan from the spec set. Deterministic. */
export function compileLcrPlan(specs: PlanSpecInput[]): LcrPlan {
  const { entities, conflicts } = compileEntities(specs);

  const personaById = new Map<string, PlanPersona>();
  const surfaces: PlanSurface[] = [];
  const stories: PlanStory[] = [];
  const uncoveredStories: string[] = [];

  for (const spec of specs) {
    // Personas: prefer the explicit `persona` block; fall back to `actors` names
    // so the list is non-empty on specs that predate menu-emits-surfaces.
    const personaIds: string[] = [];
    if (spec.persona?.id) {
      personaIds.push(spec.persona.id);
      const p = personaById.get(spec.persona.id) ?? { id: spec.persona.id, chrome: spec.persona.chrome, fromStories: [] };
      if (spec.persona.chrome && !p.chrome) p.chrome = spec.persona.chrome;
      pushUnique(p.fromStories, spec.storyId);
      personaById.set(p.id, p);
    } else {
      for (const a of spec.actors ?? []) {
        personaIds.push(a.name);
        const p = personaById.get(a.name) ?? { id: a.name, fromStories: [] };
        pushUnique(p.fromStories, spec.storyId);
        personaById.set(p.id, p);
      }
    }

    const routes: string[] = [];
    for (const s of spec.surfaces ?? []) {
      const persona = s.persona ?? spec.persona?.id ?? "—";
      surfaces.push({
        route: s.route,
        persona,
        storyId: spec.storyId,
        home: s.home === true,
        states: s.states ?? [],
      });
      pushUnique(routes, s.route);
    }

    const hasSurface = (spec.surfaces?.length ?? 0) > 0;
    if (!hasSurface) uncoveredStories.push(spec.storyId);
    stories.push({
      storyId: spec.storyId,
      entities: spec.entities.map((e) => e.name),
      personas: personaIds,
      routes,
      hasSurface,
    });
  }

  return {
    entities,
    conflicts,
    personas: [...personaById.values()],
    surfaces,
    stories,
    uncoveredStories,
  };
}
