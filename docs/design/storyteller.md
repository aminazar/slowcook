# The Storyteller — journey-driven mock building

*(canonical design; shipped across `vibe journeys` / `vibe tell` / `vibe check`)*

A mock built screen-by-screen becomes a screen catalog: statically seeded,
journey-less, leaking process voice. The storyteller inverts the unit of
work: **the journey walk builds the mock**. UI affordances exist because a
persona's story needed them; data exists because the walk created it; EPSS
scenarios exist because the story bifurcated. The transition is generic —
ANY wireframe to ANY mock; no product vocabulary lives in this machinery.

## The five laws (binding on every walker)

1. **Timely** — a story clock advances per step (`window.__slowcook.clock`);
   every datum is stamped with believable, chronological time. Worlds grow
   the way a real product's history grows.
2. **Dice when the road forks wide** — >3 pending walks → the next is picked
   by a seeded die (recorded in the artifact; replays reproduce the exact
   traversal). Exhaustion still holds.
3. **Empty states first** — the story starts at NOTHING (first-run/sign-up).
   There are no hand-written seeds: `empty` is the only primordial world;
   every other world is a snapshot a walk left behind.
4. **One step at a time: build → USE → return** — the builder creates exactly
   ONE affordance (`data-affordance="<id>"`), the walk immediately uses it,
   and control returns to the storyteller. Never build ahead.
5. **The state checker asserts the ACCEPTANCE** — after using an affordance,
   the adaptor must have changed *as the acceptance's Then specifies*
   (compiled `expect` asserts); mere change is only the floor.

## The loop

```
vibe journeys   .brewing/journeys.yaml — machine-executable steps
                (deterministic from concept.yaml; LLM synthesis from specs;
                 executability gaps file backprop claims upstream)
vibe tell       walk by walk: replay → missing affordance? build ONE →
                replay again → per-page gates (button doctrine · voice ·
                brand presence · contrast et al) → qaplan artifact + EPSS
                merge + commit (the review handoff) — per-journey review
vibe check      top-20% affordances (coverage × inverted red-route rank)
                replayed ×3 generated worlds (sparse/dense/adversarial) +
                UX-OPTIMISING: two measured questions — fewer clicks?
                which repetition folds into configs/defaults?
```

Backprop claims (`backprop-claim` + `backprop:prd|stories|concept|wire`)
fire at ANY point a gap belongs upstream; mirrored offline-safe in
`.brewing/backprop-claims.json`; `greenfield status` counts them.

## DOM conventions (the machine-executability contract)

- `data-affordance="<id>"` — the walkable control (never CSS selectors).
- `data-price` — the ONLY sanctioned place money appears near a verb.
- `data-confirm-step` — destructive/spend actions surface this; the walk
  exercises it before the mutation.
- `data-doc` — sanctioned long-prose areas exempt from the voice gate.

## Button doctrine (gate-enforced)

A button is a VERB: ≤3 words, no sentence punctuation, price only in
`data-price`, destructive/spend actions confirm. Context explains
consequences; labels never do.

## Statefulness (the adaptor contract)

All UI I/O flows through the typed `DataSource` (queries.ts): reads render
real state; every affordance calls a MUTATION (api_contract-derived) that
writes the in-browser SQLite, stamped by the story clock. The identical
interface is what production implements — the mock front-end is the real
front-end awaiting a data-source swap (`window.__slowcook` is the walker
seam: `{data, world, clock, snapshot, dumpSql}`).
