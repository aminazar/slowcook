# GUCDI — greenfield, design-first initiation (RFC)

> **Status: DRAFT for redline.** Codename **GUCDI** (Greenfield User-Centric Design Initiation). This RFC proposes a distinct *greenfield* workflow that front-loads the entire UX + branding + requirements into a living mock, fully traceable to user initiatives, before any backend is written. Authored 2026-06-09 from a PM proposal; terminology and sequencing critiqued + revised below.

## Problem

Today's slowcook pipeline is **per-issue + iterative**: one GitHub issue → refine → testgen → vibe → plate → recon → brew → chef, repeated. That fits *brownfield* (an existing app, incremental change). It does **not** fit a **fresh project**, where the right starting point is a whole product vision, a coherent brand, and a comprehensive UX — authored together, up front, as one artifact — before a line of backend exists.

## The workflow (revised)

```
PRD ──▶ stories ──▶                          ┌── (per story) ─▶ LCR grows
 │        │          brand brief ─▶ design     │     vibe into mock/, mock data,
 │        │             system (tokens/CSS/     │     branded, across all modes
 │        │             logo)                   │     (lingual · screen-size · a11y/dark-light)
 │        │                │                    │            │
 └────────┴────────────────┴────────────────────┴───── traceability spine ──┘
                                                              │
                              LCR covers the v1 initiative set ▼
                                       ↓
                       refine → recipe → brew → chef  (backend, per story, existing flow)
```

1. **PRD** — the product vision + initiative set. The human-authored (or co-authored) entry artifact. Markdown with stable anchors per initiative.
2. **Stories** — a new agent decomposes the PRD into a comprehensive story set, each story carrying a back-anchor to its PRD initiative **and a data contract** (entities + intended API shape — see Risk 2).
3. **Brand brief → design system** — the existing `brand` agent: a one-paragraph taste/feel brief (+ a few examples) → `mock/src/design-system/tokens.ts` + global CSS (palette, semantic, dark/light), typography (incl. i18n), and logo handling. Expanded per "brand-agent changes" below.
4. **LCR (Living Coded Requirements)** — the `mock/` Vite/React HMR app, reframed as **the** requirements artifact. `vibe` integrates each story into the UI with mock data, per the design system, across every mode. The LCR amalgamates requirements + branding + UX behaviour into one runnable, traceable thing.
5. **Backend** — only once the LCR covers the v1 initiative set, the existing per-story flow (refine → recipe → brew → chef) wires real data behind the already-designed UI.

## What already exists (reuse — do NOT rebuild)

| GUCDI need | Existing slowcook capability |
|---|---|
| design system from a brief | `brand` agent (`mock/src/design-system/tokens.ts` + global CSS; "visual contract downstream inherits") |
| living mock, story-by-story, mock data | `vibe` agent + the `mock/` Vite SPA (extends incrementally; scenarios ARE the data) |
| vibing across lingual / screen / a11y / dark-light modes | `fidelity.modes` + the eye (`slowcook eye`) + the `--locale` RTL axis (#193) |
| PRD-ish decomposition | `refine/multifurcate` (issue-level; needs lifting to PRD-level) |
| backend per story | refine → recipe → brew → chef |
| some traceability | `history-index`, `related_specs`, story manifests, `references` field (design #7) |

**Implication:** GUCDI is mostly *re-sequencing + orchestration* of existing agents, not new agents. Build cost is dominated by the genuinely-new pieces below.

## What is genuinely new

1. **PRD → stories agent** (proposed name **`menu`** — the menu enumerates everything the product offers). Lifts `multifurcate` from "split one issue" to "decompose a whole PRD into a comprehensive, non-overlapping story set," each story anchored back to a PRD initiative and carrying a data contract. Reuses refine's granularity-floor + relationship/overlap logic.
2. **Traceability spine + `slowcook trace check`** (the load-bearing new thing). A schema of anchored, bidirectional links: PRD initiative ↔ story ↔ LCR component (in-code comment) ↔ design-system token ↔ brand cue. Shared coded artefacts (SVG ids, CSS class names, token labels) carry the same label across BCD and LCR so they're grep-traceable. The **lint** fails on: an LCR component with no story anchor; a story with no PRD anchor; a token with no brand-cue origin; orphans; dangling refs. *Without this lint, the spine rots into stale comments.*
3. **Greenfield orchestration** — `slowcook init --greenfield` / a driver that sequences: `menu` (PRD→stories) → `brand` (brief→design system) → loop[`vibe` story → `eye` across modes → fidelity gate] until the v1 set is covered → hand off to the backend flow. Mostly wiring; the eye/fidelity.modes are the per-story verification.
4. **Brand-agent expansion** — i18n typography (per-script font stacks), multiple palettes (dark/light as first-class), logo handling, and **brand-cue → token anchors** so `trace check` can verify provenance. (See Risk 4 on logos.)

## Terminology decisions (revised from the proposal)

The original proposal introduced six acronyms; three rename concepts slowcook already names. Collapsed:

| Proposed | Decision | Why |
|---|---|---|
| PRD | **keep** | industry standard |
| LOUS (list of user stories) | **drop** → "stories" | adds nothing; reads as "louse" |
| BIAC (branding indicators & cues) | **drop** → "brand brief" | the `brand` agent already consumes a "brand brief" |
| BCD (branding coded document) | **drop** → "design system" / "brand tokens" | the `brand` agent's existing output |
| LCR (living coded requirements) | **KEEP** | the one novel, valuable term: the mock *as* requirements, not a throwaway prototype |
| GUCDI | keep as **initiative codename** only | the real surface is `slowcook prd`/`menu` + greenfield orchestration |
| "cookbook" (PRD agent) | **propose `menu`** | culinary; "cookbook" reads as a recipe collection; `recipe` is already taken (testgen alias) |

## Risks + mitigations

1. **Waterfall — resolved via scope + amendments (PM call, 2026-06-09).** "Complete" does NOT mean *frozen*; it means **all _addressable_ questions for the current scope are answered**. A **scope** is a versioned snapshot of the addressable initiative set; **amendments** ("change that / add that") start the next scope iteration → menu re-decomposes → LCR grows/changes. Crucially, questions that genuinely *can't* be decided yet are **explicitly parked as deferred questions**, never silently dropped. So the LCR exhausts the *answerable* design space per scope, not the *unknowable* one — avoiding the waterfall trap while still producing a coherent, complete-for-now requirements artifact. The `menu` agent surfaces open questions and splits them: **addressable** (must be resolved before the LCR is "scope-complete") vs **deferred** (parked, re-enter on a future amendment).

   **Living + bidirectional (PM call, 2026-06-09).** Even within a scope, *treading the path* changes things: an answer committed at story 3 can be falsified when you reach story 12, and the act of vibing the LCR (or later brewing the backend) **detects new questions** invisible at decomposition time. So the spine is NOT write-once top-down — **changes propagate back UP it with provenance** (an LCR edit can amend its story; a story revision can annotate its PRD initiative; a backend reality can re-open a UX decision). "Scope-complete" is therefore **re-openable**: a path-discovery either revises an existing answer or appends a new open question to the ledger. This is precisely why the **traceability spine + `trace check` is the keystone, not `menu`** — bidirectional, revisable links only stay coherent if the lint mechanically flags drift: a story whose PRD answer was revised but whose LCR wasn't re-vibed; an LCR component pinned to a story that changed; an open question marked addressable but never resolved. The spine turns "the design changed" from silent rot into a surfaced, actionable diff.
2. **Mock→backend data mismatch — solved by a baked-in structured store (PM call, 2026-06-09).** Instead of arbitrary flat fixtures (the delgoosh #188-#5 failure), the LCR's mock data layer is a **real, structured store — SQLite with the ORM/schema baked in.** This upgrades the LCR from "UI mock" to a **thin full-stack mock**: the `useDataDomain`/`useScenarioFixture` seam resolves to real SQLite queries over real ORM models, not hand-shaped JSON. Consequences:
   - The "data contract" per story stops being a *description* and becomes the **actual schema** (tables/columns/relations) the story needs; contracts accumulate into the LCR's SQLite schema as stories are vibed.
   - Mock data is real entity shapes (relations, types, constraints) by construction — the UI can't quietly assume a shape the backend can't produce.
   - **Backend handoff collapses to a data-source swap:** the schema + ORM models + migrations already exist (co-designed *against real UI usage* in the LCR), so brew swaps SQLite → the prod DB (Postgres/timescale) and wires the API, inheriting the models rather than discovering them.
   - **One constraint:** the ORM must be **DB-portable** (Drizzle / Prisma / TypeORM all target SQLite *and* Postgres) so the same models drive SQLite-in-LCR and Postgres-in-prod. Pick the ORM at `brand`/init time as part of the stack config. Where prod needs DB-specific features (extensions, timescale hypertables), those are deferred-question annotations on the schema, not silent gaps.
3. **Traceability rot.** Links degrade silently. **Mitigation:** `slowcook trace check` as a CI gate; shared grep-able artefact labels.
4. **SVG logo by LLM is unreliable.** **Mitigation:** prefer PM-supplied logo → brand agent only *tokenizes/recolors* (dark/light variants) rather than generates from scratch; generation is best-effort opt-in.
5. **Cost/scale.** A real PRD × all modes is a large, expensive run. **Mitigation:** per-story eye/fidelity gate; a cost model + budget gauge (existing `budget` command) before the LCR loop.

## Phased build plan

- **Phase 0 — this RFC.** Lock terminology + the document spine schema.
- **Phase 1 — `slowcook menu`** (PRD → stories agent): consume `PRD.md` (anchored) → emit the story set, each with a PRD back-anchor + data contract. Reuse multifurcate/relationship logic. ~3–4d.
- **Phase 2 — traceability spine + `slowcook trace check`** (the keystone). Schema + lint + CI workflow. ~3d.
- **Phase 3 — greenfield orchestration** (`init --greenfield` driver): sequence menu → brand → vibe/eye loop → backend handoff. Mostly wiring existing agents. ~2–3d.
- **Phase 4 — brand-agent expansion** (i18n type, multi-palette, logo handling, cue→token anchors). ~3d.

## Open questions (for redline)

- **Agent name** for PRD→stories: `menu` (recommended) vs keep `cookbook` vs other.
- **Where does the PRD live?** `docs/PRD.md` in the consumer, or `.brewing/PRD.md`?
- **Data-contract location:** on the story spec (extends the schema) or a sibling artifact?
- **Is `menu` a new agent or a `refine --from-prd` mode?** (Lighter: a refine mode that batch-decomposes; heavier: a distinct agent.)
- **LCR completeness signal:** how does the orchestration know the v1 set is "covered"? (trace check green + every story has a passing eye gate?)
