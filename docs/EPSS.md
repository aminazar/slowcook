# EPSS — the Epic · Persona · Scenario · State model

**Audience: agents (menu, vibe, taster) and humans.** This is the canonical
definition of EPSS. Read it before emitting or consuming `testing-surfaces.json`,
before writing `epic`/`acceptance_scenarios` on a spec, and before generating the
LCR mock's review manifest.

EPSS is the index of the **Living Coded Requirements (LCR)** mock. The LCR is one
clickable app over a real in-browser data adaptor; EPSS is how a reviewer navigates
it — and, later, how the real product is tested. The same four-level structure
serves **two lifecycles**:

1. **Design-time (UI/UX):** a navigable matrix of every *(scenario × meaningful
   state)* a persona can be in — so design review covers the real states, not just
   the happy path.
2. **Build-time (testing):** each cell is also a **manual test case** — a start
   state plus a walk-through — that the `taster` turns into a test plan for the
   real product. **Author the matrix once; reuse it as the test plan.**

---

## The four levels

| Level | Meaning | Source of truth | Convention it mirrors |
|---|---|---|---|
| **Epic** | A product *theme* — a journey that groups scenarios **across personas** (e.g. "Founder onboarding" spanning founder + operator). | spec `epic` (menu-emitted) | agile epic · journey-map journey |
| **Persona** | The *actor*. One concrete id (`founder`, `operator`, `guest`), never a slash-blob. | spec `persona.id` | Cooper / NN-g persona |
| **Scenario** | A *task the persona pursues* — a goal/journey, **not a screen**. One scenario may span several screens; one screen may host many scenarios. | acceptance_scenario's **"When"** | user scenario · user flow · Gherkin When |
| **State** | The *precondition the scenario starts in* — what's true about the data/world before the walk-through. | acceptance_scenario's **"Given"** | Storybook story · Figma variant · Gherkin Given |

And one attribute that is **not** a level:

- **route** — *where* the test starts. An attribute of the scenario, reusable
  across scenarios. The original EPSS bug was treating the route as the scenario's
  identity, which produced one meaningless "scenario" per URL. **A scenario is a
  task; a route is just its starting page.**

### The mapping is Given/When/Then

Every `acceptance_scenario` is a Gherkin triple, and each clause becomes one part of
an EPSS test case:

```
Given a guest who requested a code,   →  State    (the precondition)
When  they enter it before it expires, →  Scenario (the task/action)
Then  they are signed in.              →  expected outcome (carried as `expect`)
```

`route` = the persona's start surface (the `home: true` surface, else the first).

---

## Initial use — designing UI/UX

The mental model: **the LCR mock is to a whole app what Storybook is to a
component.** Storybook is a navigable matrix of *(component × state)*; EPSS is a
navigable matrix of *(persona × scenario × state)* over the whole app. The review
overlay renders the EPSS manifest as a jump palette so a designer/PM can land on any
cell and judge the *designed* UI for that exact situation.

This is how design practice already separates work (see research below):

- **Separating a scenario per persona** — persona-based flows. The same feature is a
  *different scenario* for a different persona (different goal, permissions, data).
  EPSS makes that explicit: Epic groups them; Persona forks them.
- **Forking a scenario by state** — Storybook stories / Figma variants. Each
  meaningful state is its own previewable cell. EPSS lists the states under the
  scenario; the overlay writes the selected state to `localStorage`, and the mock's
  data adaptor produces data for that precondition, so the screen actually renders in
  that state.

Design review that only sees the happy path ships interfaces that fall apart on
empty/error/edge. EPSS forces the states onto the review surface.

---

## Later reuse — test plans for the real product

An EPSS cell is not a static screenshot — it is a **test case you can run**:

> **start** at `route` with the data seeded to the **State** (Given) → **walk** the
> **Scenario** (the When: fill this form, click that button) → assert the **expected
> outcome** (the Then).

This is exactly a manual test plan. The `taster` agent reads the EPSS matrix plus
the delivered code and writes the product's manual test plan from it — no second
authoring pass. The acceptance criteria authored at decomposition (menu) become the
design matrix (vibe/overlay) and then the test plan (taster). One artifact, three
uses.

Because the LCR data adaptor and the backend share a data contract (mock→prod is a
data-source swap), the *same* start-state seeding that drove design review can drive
the real product's test setup.

---

## Universal states — the one consideration that shapes everything

Research (Scott Hurff's **UI Stack**, *Designing Products People Love*, 2016) says
every data screen has **five** states: **Ideal** (populated), **Loading**, **Empty**,
**Error**, **Partial**. The trap is treating all five as per-screen design/test work.

slowcook splits them in two:

- **Universal states — `loading`, `error`, `partial`.** These are *presentation*,
  identical everywhere. They are **not** declared per scenario. They are rendered by
  ONE shared primitive (`<Async>` / `useAsync`) and showcased in ONE place: the
  **Foundations** epic, whose single scenario (`/_foundations`) lets a reviewer
  preview loading/empty/error once. *Even universal states need a starting page* —
  Foundations is that page — but they get exactly one, not one per surface.
- **Meaningful states — the business/data Givens.** `empty` vs `populated`,
  `insufficient-funds`, `expired-voucher`, `mark-below-threshold`. These change *what
  the user sees or can DO*, so they are declared per scenario (the Gherkin Given) and
  reviewed in context on their own page.

Rule for `menu` when emitting a surface's `states`: **list only the meaningful
business/data conditions. Never list `loading` or `error`.** Rule for `vibe`: pages
wrap their body in the shared `<Async>` and branch only on meaningful state; the
Foundations entry carries the universal ones.

This is why most surfaces declare **zero or one** state — the heavy lifting
(loading/error) is shared, and only genuine business forks are spelled out. It keeps
the matrix small without losing coverage.

### Why "loading" isn't a scenario

A scenario is a *task*. "The page is loading" is not a task a persona pursues — it's a
transient presentation of *every* task. Putting it in the matrix per page is the same
category error as treating a route as a scenario: it inflates the matrix with cells
that carry no design or test judgement. One Foundations home covers it.

---

## State drives the data, not a layout flag

A subtle but load-bearing rule discovered while building the mock: **a page should
render whatever the data adaptor returns — it must not branch its layout on the EPSS
state id.** The State selects the *data* (via the adaptor seeding the precondition);
the page reacts to the *data*, not to the token.

Concretely:
- `empty` vs `populated` → the page branches on `rows.length === 0`, not on
  `state === "empty"`. The adaptor returns no rows for the empty precondition.
- `below-threshold`, `insufficient-funds` → the page reflects the *values* in the
  data (a mark under the threshold, a balance under the floor), not a flag.
- `loading` / `error` → the shared `<Async>` handles them off the async result.

Why: the Gherkin "Given" is prose, and the spec's `surfaces[].states` are coarse
generic tokens (`empty`/`populated`/`edge`) — neither is a stable code identifier a
page can switch on without breaking when wording changes. Coupling layout to the
state id is brittle; rendering the data is robust and is what a real product does.
The seam that makes a State real is therefore the **data adaptor** (`vibe seed` /
`lib/queries`): it reads the selected state and produces the matching rows. That is
also why the *same* mock seeding can later seed the real product's test setup.

> Open OSS gap: there is no explicit link from an `acceptance_scenario` to the
> `surfaces[].states` token it exercises. Until `menu` tags each scenario with its
> state token, the manifest carries the Given prose as the State label and pages stay
> data-driven. Don't reintroduce `state === "<token>"` layout branches.

## Design is a state source — the inverse

The rule above runs data → render. The complement, discovered the hard way while
building a mock: **the design runs the other direction — affordances → requirements,
and variants of an affordance → States.** The mock isn't an *illustration* of the
spec; in slowcook it **is** the spec. So:

- **Every affordance a design shows is a requirement** — a "Next session" block, a
  "Change therapist" button, a status badge, a disabled control. Not decoration.
- **Every way an affordance changes with the data is a State** (a Given): present vs
  absent, enabled vs disabled, booked vs unbooked, this-value vs that-value. A rich
  component is therefore a **state-discovery surface** — read its variants *backwards*
  into the EPSS matrix, including States the written spec never enumerated.
- **An affordance's *interaction* is part of the requirement, not just its
  presence and appearance.** *What it does when activated* is spec: a button that
  opens a confirm modal is not satisfied by a button that navigates away; the modal's
  content and its data-driven branching are themselves requirements. Reproducing the
  look (and even the disabled/variant states) while stubbing the handler drops a
  requirement just as surely as omitting the control. For each *interactive*
  affordance ask not only "what State does this imply?" but **"what does activating it
  do, and what does that flow reveal?"** — then reproduce that flow, not a placeholder.
- **Simplifying a design silently drops requirements *and* States.** A "lite"
  reproduction loses behaviours, not just pixels.

Consequence for the loop: a **"drifted from design" review comment is a dropped
requirement, not a cosmetic nit** — and "doesn't *behave* like design" is the same
class of miss as "doesn't *look* like design." The fix recovers the affordance, the
behaviour/state it encoded, **and the interaction it triggers.** When `vibe`
reproduces (or a port adapts) a component, it must carry the *full* affordance set and
ask of each piece "what State/behaviour does this imply, and what does activating it
do?" — then add those States *and that flow* to the matrix. (Provenance: a
chosen-therapist card whose dropped "next session / change-disabled" affordances
encoded the one-therapist-per-care-profile rule; and whose Manage/Cancel buttons,
reproduced to *look* right but wired to a `navigate` stub, dropped the confirm-sheet
flow that surfaces the ≥24h-refund / <24h-charge cancellation model.)

## How it's encoded

- **Spec (`specs/story-*.yaml`):** `epic` (theme), `persona`, `surfaces[]` (routes +
  meaningful `states`), `acceptance_scenarios[]` (the Given/When/Then test cases).
  `menu` emits all of these from the PRD; if `epic` is absent the LCR derives a label
  from the `prd_ref` anchor (coarse — prefer an explicit `epic`).
- **Plan (`compileLcrPlan`):** parses each acceptance_scenario into an `EpssScenario`
  `{ epic, persona, scenario, state, then, route, storyId }`. Backend-only stories
  (no surface) produce no EPSS case.
- **Manifest (`public/testing-surfaces.json`, via `epssManifestJson`):** groups the
  EPSS cases `epic ▸ context(persona) ▸ scenario(When) ▸ state(Given)`, appends the
  Foundations epic, and sets `base: ""` (scenarios carry absolute routes; the overlay
  composes the nav URL as `base + route`).
- **Overlay (`@slowcook-ai/review-overlay`):** renders the manifest as the EPSS jump
  palette and writes the selected `{ stateId }` to `localStorage`
  (`slowcook_test_surface`); the mock reads it via `useSurfaceState` to drive the data
  adaptor.

---

## Research notes (provenance for the model above)

- **UI Stack — five states.** Scott Hurff, *Designing Products People Love* (O'Reilly,
  2016). Every screen has Ideal/Loading/Empty/Error/Partial; loading/error are
  universal presentation. <https://www.scotthurff.com/posts/why-your-user-interface-is-awkward-youre-ignoring-the-ui-stack/>
- **Persona ≠ scenario ≠ screen.** NN/g: a persona is the actor; a *scenario* is the
  persona pursuing a goal in context (a narrative spanning screens); a *user flow* is
  the discrete steps. <https://www.nngroup.com/articles/scenario-mapping-personas/> ·
  <https://www.nngroup.com/articles/user-journeys-vs-user-flows/>
- **States fork a scenario — Storybook/Figma.** A Storybook *story* (and a Figma
  *variant*) is a component in one state; the tool is a navigable matrix of
  *(thing × state)* with shared naming across design + code. EPSS applies the same
  shape to the whole app. <https://storybook.js.org/docs/sharing/design-integrations>
