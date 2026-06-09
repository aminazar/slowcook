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

1. **Waterfall.** "Completely exhausts initiatives before backend" is a waterfall bet. **Mitigation:** iterate at the *PRD level* — LCR covers the v1 initiative set; later initiatives are PRD amendments → new stories → LCR grows. Not big-bang.
2. **Mock→backend data mismatch (amplified).** Mocking the whole app first maxes the delgoosh #188-#5 failure (flat mock shape vs nested real DTO). **Mitigation:** each story carries a **data contract** (entities + intended API shape) so the LCR's mock data is shaped like the eventual real data. The `references` field (#7) + plate-mode carry it into brew. *This is a hard constraint, not optional.*
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
