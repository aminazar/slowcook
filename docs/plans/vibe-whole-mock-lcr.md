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

## Landed (seed + adaptor pass)

Decision: the LCR uses a **real in-browser SQLite** (sql.js + Drizzle), per the
gucdi keystone — so the mock's query layer runs real SQL and mock→prod is a
data-source swap, not a rewrite.

- **Deterministic runtime** (`vibe seed`, no LLM): `schema.ts` (Drizzle) + `ddl.ts`
  (CREATE TABLE, enum CHECKs, FK REFERENCES) + `db.ts` (sql.js boot → materialise →
  seed). `compileSqliteDdl` + `dbBootstrapTs` in schema-gen.ts (+ tests).
- **LLM passes** (`SEED_SYSTEM`, `ADAPTOR_SYSTEM`): `seed.ts` (dense,
  state-covering, referentially-consistent inserts) + `queries.ts` (typed
  `DataSource` adaptor, shaped by acceptance scenarios, invariants enforced in the
  query shape).
- **Boundary held:** structure (schema/ddl/db) → deterministic; content (seed,
  domain queries) → LLM.

**Dogfood (dash):** deterministic runtime generated for all 37 tables and
**validated against real sql.js** — 37 tables created, FK joins work, enum CHECK +
FK constraints enforced. The LLM seed/queries run was **blocked on Anthropic
credit** (key exhausted); the passes are wired and ready once credit is restored.

## Landed (app scaffold — deterministic) + greenfield fix

- **`slowcook vibe app`** (`vibe/app-gen.ts`, pure + 7 tests): from the plan,
  scaffold the **runnable, navigable** LCR — Vite + Tailwind-v4 app, `App.tsx`
  router (every surface a route, no auth walls, HashRouter), persona shell
  (chrome-aware nav + persona/theme switcher), and a **stub page per route** (sets
  the `@story` marker, lists personas/states). Sets `.brewing/mock.yaml`
  (`review_mode: lcr`). The LLM `vibe surfaces` pass fills page bodies.
- **`greenfield status` rewritten** for whole-app LCR: coverage is staged (data
  model → schema → adaptor → app → surfaces), not per-story `@story` markers; the
  next-action ladder routes through `vibe schema`/`seed`/`app`/`surfaces`.
- **schema-gen fix:** circular/mutual FKs annotate `(): AnySQLiteColumn` (the
  documented Drizzle fix) so the generated schema typechecks.

**Dogfood (dash):** `vibe app` → 27 routes · 8 personas · 38 files;
`greenfield status` → `LCR (whole-app) ✓ — schema ✓ · adaptor ✓ · app ✓ · 32/32`;
the mock **builds** (`tsc -b && vite build`, 71 modules) and **runs** (navigable
shell + persona switcher + per-route stub pages). Left: the LLM page bodies + dense
seed (`vibe seed` + `vibe surfaces`), blocked on credit.

## Next slice

- `vibe surfaces` (LLM): replace each stub page body with the designed UI rendering
  via `queries.ts`; + the real dense `vibe seed` run. Both need credit.

## Migration (don't break downstream at once)

Per-story scenario mode stays as legacy opt-in; the whole-app LCR is the new default.
`greenfield status` coverage shifts from per-story `@story` file-markers to
route/marker coverage (the persona-surface trace already does most of this). `plate`,
`recon`, `brew --mode plate` migrate from `slowcook/mockup/story-<id>` per-story
branches to the single LCR branch incrementally — tracked as follow-ups.
