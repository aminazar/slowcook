# vibe app — connectivity & shared-data gap (design)

> `vibe app` scaffolds a runnable LCR, but the generated surfaces are **islands**:
> the only thing connecting them is the EPSS navigator (teleport). The product's
> own navigation and a shared data layer are never generated, so the mock doesn't
> behave like a product and EPSS scenarios can't be reached by *using* it.
> Found dogfooding dash; fix specified here. (2026-06-29)

## Symptoms (observed on the dash mock)
- **No product navigation.** `vibe app` strips the shell to a bare `<Outlet/>`, so
  there's no sidebar/nav/hub — surfaces are only reachable by typing the URL or via
  the EPSS pill. (Already flagged in dash's hand-built chrome as "GAP #4".)
- **Breadcrumb parents that don't exist.** A surface at `…/settings/members` ships,
  but there's no `…/settings` index page, so the breadcrumb chain dead-ends.
- **Actions live on separate surfaces, not inline.** "Add member" is its own EPSS
  screen instead of a button on the project — because each acceptance scenario was
  emitted as an isolated surface.
- **No shared data.** Each surface seeds its own local state, so entering data on
  one never appears on another; a scenario's "Given" state can only be *picked*
  from the navigator, never *reached by doing the prior steps*.

## Root cause
`vibe app` maps **one acceptance-scenario/surface → one stub route**, and wires
them with exactly one connector: the EPSS router. Two things are missing:
1. **Product chrome + navigation** — generated from the persona's `chrome` (member
   sidebar / public nav / admin toolbar) AND the surface graph (a project's
   sub-surfaces under a project nav; index/hub pages for breadcrumb parents).
2. **A shared, mutable data adaptor** wired into every surface — `vibe seed`
   already emits a typed `DataSource` (the mock→prod swap seam); `vibe app` should
   have every surface read/write it, not seed locally.

## The fix
`vibe app` should generate a **connected, incremental** app:

1. **Chrome per persona** — emit the shell (sidebar/nav/toolbar) instead of a bare
   `<Outlet/>`. (The `chrome` field already exists on the persona.)
2. **Navigation graph** — derive nav + hubs from the surface routes: a parent route
   with children gets an **index/hub** page that links them; sub-surfaces appear in
   a scoped nav; breadcrumb parents resolve.
3. **Surfaces wired to the adaptor** — each generated surface reads `DataSource`
   and calls its **mutations**; no per-surface local seed. Adding a surface is
   *incremental into the running app*, sharing data with the rest.
4. **Actions inline where the product has them** — an acceptance scenario that
   mutates (add member, top up) becomes a control on the owning surface, not a
   standalone screen, unless the scenario truly is its own page.
5. **EPSS scenarios become traversable paths.** With shared mutable data, a
   scenario's "Given" is produced by performing the earlier steps; the EPSS
   navigator stays as a **deep-link shortcut** for review coverage, not the only
   door. Each scenario should be reachable both ways: by interaction, and by jump.

## Pragmatic scope — wire where data *flows*

Not every surface needs the adaptor. The value of adaptor-wiring is **cross-surface
flow** (entered data appears elsewhere) and **traversable state** (a "Given" reached
by doing). So wire the entities that flow — members, wallet, gates, workers — and
let **leaf surfaces** (no other surface reads their data — e.g. an audit log, a QA
plan, a voucher console) keep realistic local/seed data: for those, adaptor-backed
is *functionally identical* to seeded, so the port is uniformity with no behaviour.
`vibe app` should default to wiring, but this is the line when triaging by hand.

## Why it matters
- **No duplication** — one app, many paths, one data source (vs N isolated screens).
- **Real test flows** — a scenario is a journey through the live app; review +
  `eye`/`taster` exercise the product, not disconnected stubs.
- **Mock ≈ product** — the swap seam (`DataSource`) means brew implements the same
  interface against the real backend; the navigated mock maps 1:1 to the shipped app.

## Status
- **dash (hand-built reference):** Layer 1 (nav spine: project nav · settings index
  · overview hub · resolving breadcrumbs) done; Layer 2 (surfaces onto the shared
  adaptor with mutations) in progress (members + wallet done, rest incremental).
- **OSS `vibe app`:** to implement per the above — chrome, nav graph, adaptor
  wiring, traversable EPSS. dash is the worked example to port from.
