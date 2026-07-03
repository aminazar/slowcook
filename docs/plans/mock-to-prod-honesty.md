# Mock→Prod honesty — root cause & fix for fixture/gating/CTA leakage

## The three field-reported defects

A consumer shipped a slowcook-built product to production and found three
classes of defect that the mock review never surfaced:

- **A. Fake data in prod.** Pages rendered fixture data (sample projects,
  seeded transcripts, canned lists) that only ever existed to make the mock
  reviewable.
- **B. No gating in prod.** Internal pages (`/projects`, `/billing`, admin
  consoles) were reachable by unauthenticated guests — the mock's
  barrier-free navigation shipped as product behavior.
- **C. Undeveloped CTAs.** Buttons ("Connect a repo", "Email me a code",
  "Approve") produced a fake local-state success and delivered nothing —
  the mock's theatrical `onClick={() => setState(next)}` shipped verbatim.

These are not three bugs. They are one architectural gap with three faces.

## Root cause

slowcook is design-first: the **mock is the spec in visual form**, and it is
*deliberately* built to be reviewed by humans. `spec.ts` states the stance
outright — surfaces are declared with "**every surface reachable, no auth
walls**", populated with `fixtures.by_domain` seed data, and wired with
local-state transitions so a reviewer can walk the state machine.

**That reviewability requires exactly the three things that must not survive
to production.** The mock is *product behavior* and *review scaffolding*
superimposed in the same code. The port→brew pipeline is supposed to strip the
scaffolding and keep the product — but it only does so for **one** of the three
dimensions, and even that one is bypassable:

| Dimension | Mock scaffolding | Pipeline transform today | Gap |
|---|---|---|---|
| **Data (A)** | `useScenarioFixture("x")` OR inline `const X=[…]` | `port` rewrites `useScenarioFixture → useDataDomain` | Inline `const` fixtures never touch the seam, so `port` has nothing to rewrite — they ship verbatim. |
| **Access (B)** | "no auth walls", every route open | none — access lives as *prose* in `actors`/`auth_proposal`, and `auth_proposal` drives **API/RLS** auth, not **route/page** gating | Page-level gating is nobody's job. brew gates an API only if a test drives it; the page shell stays reachable. |
| **CTA effect (C)** | `onClick={() => setState(next)}` | brew swaps `setState → fetch` **only where a test asserts it** | An untested CTA keeps its mock theater. Effects are scattered prose (`ui_behavior`/scenarios), never a per-CTA declaration. |

So the unifying root cause:

> **The mock's fixtures, open routing, and theatrical CTAs are review
> scaffolding. slowcook has a mandatory transform for none of them and a
> bypassable transform for one. The pipeline enforces honesty only where a
> test happens to drive it — so scaffolding that no test covers ships as
> product.**

The deeper methodological point: brew is **test-driven**, which is a strength
for *behavior* but a hole for *absence*. Tests assert "this works"; almost
nothing asserts "this fake thing is gone." Fixtures, open routes, and dead
CTAs are all *absence* obligations, and absence is exactly what a green test
suite does not prove.

## The fix — three symmetric, enforced transforms

The mock must **declare** its scaffolding so the strip is mechanical, and a
**deterministic check** must fail the build when scaffolding survives — because
"no test caught it" is the whole problem, so the fix cannot itself be a test.

### 1. Declare (refine)

Extend the surface declaration from pure routing to routing + posture:

```yaml
surfaces:
  - route: /projects
    access: authed          # public | authed | role:<name>   (NEW, default authed)
    ctas:                    # (NEW) every actionable affordance names its real effect
      - { label: "New project", effect: "mutate:POST /api/projects" }
      - { label: "Connect a repo", effect: "deferred" }   # honest: no backend yet
```

`access` is the missing source of truth for **page gating** (distinct from
`auth_proposal`, which is API/RLS). `ctas[].effect` is the missing source of
truth for **what a button does** — `navigate:<path>`, `mutate:<METHOD path>`,
or `deferred` (explicitly no effect yet → renders an honest disabled state,
never a fake success).

### 2. Strip-and-replace (mock authoring + port + brew)

- **Mock author (vibe/plate):** all render data flows through
  `useScenarioFixture` (never inline `const` rendered in JSX); a `deferred`
  CTA renders disabled/"coming soon" **in the mock itself**, so honesty ports
  for free; a `mutate` CTA calls a stub the port rewrites.
- **port:** in addition to the data-seam rewrite, emit a route guard for every
  `access != public` surface.
- **brew:** plate-mode allowed paths include the route-guard/middleware layer;
  a `deferred` CTA is wired to an honest disabled state, never to fake success.

### 3. Enforce (`slowcook check prod-honesty`) — the backbone

A pure-disk, no-LLM static check, sibling to `mock-isolation`, that scans the
**ported production** tree and **fails CI** on any of:

- **A.** an inline fixture literal (array/object with ≥2 entries) rendered
  (`.map`/JSX) in a component that is not behind the data seam;
- **B.** a route whose surface is `access != public` with no auth guard on its
  page;
- **C.** an `onClick`/action handler whose body only calls `setState` with no
  `fetch`/navigation/declared-`deferred`.

This is the load-bearing piece. The declarations (1) and transforms (2) make
the check pass *by construction*; the check (3) guarantees that when they slip
— an inline fixture, a missed guard, a theatrical button — the build goes red
instead of the defect reaching a user. It is "audit every page for these three
problems", made permanent and automatic instead of a manual sweep.

## Delivery

- **refine** — `surfaces[].access` + `surfaces[].ctas[].effect` in the spec
  schema; prompt elicits them.
- **port** — emit route guards from `access`.
- **testgen** — one guest-access test per non-public surface; one effect test
  per CTA (deferred → disabled; mutate → calls endpoint).
- **brew** — allowed-paths include route guards; `deferred` = honest disabled.
- **`slowcook check prod-honesty`** — the deterministic backbone, runs in the
  brew ratchet + consumer CI.

Ship order: the check first (it retroactively finds the defect in every
already-built product), then the upstream declarations that make it pass by
construction.
