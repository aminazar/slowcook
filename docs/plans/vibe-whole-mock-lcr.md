# vibe: per-story → whole-app LCR

**Status:** building (deterministic plan foundation landed). **Owner:** GUCDI.

## The change

`vibe` stops generating one mock per story. It generates **one complete, clickable
LCR app** — richly populated, covering every epic/persona/scenario/state, with a
shared **data adaptor** so all surfaces are visible as a navigable design. Per-story
vibe (`--spec <id>` → one scenario file) is wrong: you can't review a product as 23
disconnected screens, and per-scenario inline fixtures never become a coherent store.

## Why now / what already exists (reuse, don't reinvent)

- The **vision** (`gucdi-greenfield.md`) already specifies the LCR as a whole-app
  requirements artifact with a **SQLite+ORM data layer** as "the keystone."
- `review_mode: "lcr"` already exists end-to-end: run-mock device-flow auth, the
  overlay shows on every route + persona switcher + files `[LCR] story-NNN` issues.
- The **rewo LCR is the working precedent**: Drizzle schema (12 `@story`-annotated
  tables) + a dense seed/query data-layer + persona variants + a 15-route auth-free
  shell + per-route story markers.
- The gap: **`vibe` never generated any of it** — rewo's was hand-authored.

So the redesign = teach `vibe` to generate the whole-app LCR + its data adaptor,
targeting the `lcr` mode that already exists downstream.

## Architecture — staged generation (a 23-story app can't be one LLM call)

1. **`vibe plan` — deterministic, no LLM.** Compile all specs → one LCR plan:
   - **data model**: merge every story's `data_contract.entities` into one schema,
     unioning fields, flagging cross-story field-type **conflicts**. → the adaptor spine.
   - **persona/route map**: from each story's `persona` + `surfaces`. → navigation.
   - **coverage**: which stories contribute a surface vs are backend-only.
2. **schema pass (LLM)** — plan's data model → a Drizzle schema (`@story`-annotated,
   SQLite-portable), the rewo pattern.
3. **seed + adaptor pass (LLM)** — a dense seed covering personas/scenarios/states +
   a typed query layer = **the data adaptor** (mock→prod swap seam; Type B, finally
   generated not hand-authored).
4. **surface passes (LLM, per route/epic)** — each page reads via the adaptor;
   assembled into **one auth-free clickable app** + router + persona/state switcher +
   per-route `@story` markers → `review_mode: "lcr"`.

## Landed (this slice — deterministic foundation)

- **`menu` emits `persona` + `surfaces`** per UI story (prompt + `MenuStoryDraft` +
  schema + assemble). This is the upstream fix (chosen over vibe-infers-routes):
  declared provenance, feeds the existing persona-surface trace lint. Backend-only
  stories omit them.
- **`vibe plan`** (`vibe/lcr-plan.ts`, pure + 7 tests): `compileLcrPlan(specs)` →
  entities/conflicts/personas/surfaces/coverage. CLI prints it + writes
  `.brewing/lcr-plan.json` for the generation passes.

**Dogfood (dash, token-free):** 23 specs → **36 entities, 284 fields, 1 conflict**
(`ExternalAccessGrant.scope_type` drifts across story-004/005/006), 0 surfaces
(specs predate menu-emits-surfaces → re-run `menu`). The data-model + conflict
detection is immediately useful and is the schema-pass input.

## Landed (schema pass — deterministic)

- **`slowcook vibe schema`** (`vibe/schema-gen.ts`, pure + 10 tests): the plan's
  data model → an `@story`-annotated Drizzle schema (SQLite-portable). Because the
  `data_contract` types are structured, the schema is **deterministic** — no LLM,
  no drift. Type map (uuid/string→text, timestamp→integer timestamp-mode,
  enum(...)→text+enum, float→real, `|null`→nullable), FK thunks from relations,
  `id`→primaryKey (never an FK — drops inverse relations). Conflicts block.
  **This draws the boundary: structure → deterministic; content/judgment → LLM.**
- **Dogfood (dash):** 37 tables · 292 columns, 0 PK-as-FK, no dangling FK targets,
  valid syntax. Caught + fixed a real inverse-relation bug (`project.id` was being
  made an FK to its child).

## Next slices

- Seed + adaptor pass (LLM): dense seed + typed query layer covering the state matrix.
- Surface passes + shell assembly: one clickable app targeting `lcr` mode.
- Re-derive dash specs (menu) so the route map populates; then `vibe plan` shows
  the full persona/route map, not just the data model.

## Migration (don't break downstream at once)

Per-story scenario mode stays as legacy opt-in; the whole-app LCR is the new default.
`greenfield status` coverage shifts from per-story `@story` file-markers to
route/marker coverage (the persona-surface trace already does most of this). `plate`,
`recon`, `brew --mode plate` migrate from `slowcook/mockup/story-<id>` per-story
branches to the single LCR branch incrementally — tracked as follow-ups.
