# Eye + mock: a live, watchable, behind-auth fidelity feedback loop

Status: proposal (consolidates #189, #191, #192 + the delgoosh dogfood findings).

The eye is most valuable as a **continuous** signal, not a one-shot gate at the end.
This doc specifies slowcook standing up + **keeping warm** the pieces that make
visual convergence a live feedback loop the refine and brew agents (and the PM)
use throughout a story — not just at brew's end.

## 1. Live HMR mock reference server — stood up + announced, kept running

- On `refine` start, slowcook starts the consumer mock in **HMR/dev** mode
  (`vite dev`/`next dev`, stable rotating port) and **announces the URL**
  (printed + PM-pushable): `mock (reference): https://…`.
- It is **kept running across refine → brew → eye** (not torn down per stage), so:
  - refine can open the exact mock surface it's writing a spec for;
  - brew can diff its candidate against the live mock continuously;
  - the PM watches convergence on a constant URL ("fun to watch").
- Refuse/​warn if eye is invoked with no live reference.

## 2. Warm eye / Playwright across the cycle (extends #189 `eye --watch`)

- Launch the Playwright browser **once per cycle** and **reuse** it for every
  re-eye (reference captured once; candidate reloaded each pass). No cold
  relaunch per check → re-eye is ~instant.
- Keep the warm eye **available during refine and brew**, not only at the end:
  brew can call `eye --watch` after each edit and get a live violation-delta;
  refine can sanity-check the surface it's spec'ing. Eye becomes the inner loop.
- Browser install is environment-resilient: run locally if Playwright is
  available; otherwise on the dev box (the delgoosh dogfood ran it locally with
  Playwright 1.60 `chrome-headless-shell`).

## 3. Behind-auth: dev-only preview seam (#192)

Most surfaces are gated; eye must reach them. A **dev-only, env-gated** seam,
scaffolded by `slowcook init` and documented in the managed agent-docs:
two independent gates (build-time flag never set in prod → dead-stripped, **+**
`?__preview`; backend NODE_ENV/origin check), a fake "Preview User" (no real
session/PII), render-only. Applies to **both** the candidate **and** the mock
reference (else you compare login-vs-page).

## 4. 1-1 comparison: shared canonical fixtures via a dev-only data adaptor

For eye to be 1-1 (only real UI drift, not data noise), **both** sides must
render the **same** data:

- A single **canonical fixtures** source (committed) is consumed by BOTH the
  mock's mock-data layer AND the candidate's **dev-only data adaptor**.
- The candidate's adaptor is **env-gated and excluded from the prod build** (it
  only feeds fixtures in preview mode; prod uses the real client).
- `eye … ?__preview&scenario=<name>` selects the same named fixture on both
  sides → deterministic, reproducible, **1-1** screenshots. Without this, eye
  noise is dominated by differing row counts / names (seen in the dogfood).

## 5. Orchestration summary

For a story's lifecycle slowcook keeps alive + announces:
`{ mock HMR reference, warm eye browser, candidate dev server }`, feeds both
sides the same fixtures, and runs eye as a **continuous** drift signal during
refine/brew + a **gate** at brew end. Tear down on story close.

### Provenance (delgoosh dogfood, 2026-06)
Validated piecemeal: local eye run (Playwright 1.60) caught real login drift;
a minimal #192 preview let eye render the authed `/patient/therapists`; the mock
needed the same `?__preview` bypass; and ad-hoc (non-shared) fixtures made the
comparison noisy — motivating §4.

## 6. Mode matrix must include locale / direction (not just viewport × scheme)

Today eye's matrix is `viewport × scheme` (≤4). Bilingual / RTL apps add a **third
axis — locale/direction** — so the full space is `viewport × scheme × locale`
(e.g. desktop/mobile × light/dark × fa/en = 8). RTL layouts drift independently
of LTR, so an en-LTR page can be broken while fa-RTL looks fine (and vice-versa).

- **First-class axis.** `eye` should accept `--locale fa,en` (and `spec.fidelity.modes`
  should express locale), driving the consumer's language the same dev way it drives
  auth/preview — via a query param (`?lang=`/`?__preview`) honored on **both** the
  candidate AND the mock reference. (A consumer that reads `?lang` only on one side
  yields a 100%-mirror false-diff — observed in the delgoosh dogfood: en run jumped
  to 1077 violations until the mock honored `?lang`, then collapsed to the fa baseline.)
- **Consumer-declared subset (not always all 2^N).** Exhaustive 2^N is often overkill;
  the consumer declares the *necessary* subset in `fidelity.modes`. delgoosh's call:
  **6 of 8** — primary language (fa) full incl. dark (4), secondary (en) light-only (2).
  eye runs exactly the declared cells.
