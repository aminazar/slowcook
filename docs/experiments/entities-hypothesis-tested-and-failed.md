# Entities-hypothesis tested + failed

**Date:** 2026-05-04
**Verdict:** Soft-prompted entity-import directives don't fire even with structural support. The hypothesis "promote domain entities to typed contracts → agents stop drifting on prop shape" doesn't hold under the conditions we built. Architectural pivot follows.

This is not a failure of the experiment. It's the result the experiment plan was designed to elicit. We have a definitive negative; we now know which direction NOT to keep investing in, and the data unblocks a different design.

## What we hypothesized

After story-018 burned $4 across four halted brew runs to discover and fix prompt-rails gaps, we framed the underlying question: are LLMs capable of maintaining structural alignment across stateless agent invocations using prompt-time rails alone, or do we need something architecturally different (typed contracts, AST reconciliation, JEPA-style world models)?

The entity-first hypothesis was the cheapest version of the "give them a typed contract" answer. Specifically:

> If `slowcook init entities` extracts the consumer's domain ERD into TypeScript interfaces + zod schemas at `src/lib/entities/<table>.ts`, and every agent prompt directs the agents to import canonical types from that barrel, the prop-shape drift class — `<Component profile=...>` vs `<Component owner=...>` — disappears. The compiler enforces what was previously a soft signal.

If true: the plate-mode `@slowcook-port-from` carve-out (task #68) and the recon prop-shape detector (task #70) become smaller or unnecessary; the type system retires whole rail classes.

## What we built

Across cli@0.18.0-α.6 and α.7 + llm-anthropic@0.14.1 and 0.14.2, we shipped:

1. **`slowcook init entities`** — walks `supabase/migrations/*.sql` via the existing `parseDdl`, emits `src/lib/entities/<table>.ts` with `interface <Entity>` + `<Entity>Schema = z.object({...})`, plus a barrel.
2. **DDL parser fixes** — handles `add column IF NOT EXISTS`; dedupes columns when later migrations re-add the same field defensively.
3. **Mock-side bridge shim** — when `mock/` exists, also writes `mock/src/lib/entities.ts` re-exporting from the consumer's prod path, so `@/lib/entities` resolves under both tsconfigs.
4. **Agent prompt updates** — refine, vibe, plate, testgen, brew each got an "Entities are the typed contract" section directing them to import from `@/lib/entities` and never redeclare entity shape inline.
5. **Project-context digest** — `readEntitiesDigest()` lists every entity + columns; appended to the projectContext block all agents see.

Validated on rewo: 10 entities extracted from 20 migrations, files typecheck cleanly under the consumer's strict tsconfig, the mock-side shim resolves under mock's separate tsconfig.

## What we measured

Three dispatches, all with the entity layer reachable:

| run | agent | result | inline interfaces | entity imports |
|---|---|---|---|---|
| brew #155 (α.6, entity prompt + digest, OLD tests + OLD mock) | brew | success, $0.64, 3 iters, 35/35 green | 9 | 0 |
| vibe #156 (α.6 regenerate=true, no shim yet) | vibe | files written, label-add 502 | 8 | 0 |
| vibe #157 (α.6 regenerate=true, shim present) | vibe | files written, mock-isolation tripped on missing PinnedRewosStrip | 3 | 0 |

Across two distinct agents (brew + vibe) and three runs, **zero entity imports**. Every domain prop type was inline-declared, even with the shim making `@/lib/entities` resolvable from mock-side and the prompt explicitly directing the import.

## Why the agents skipped — and why it's reasonable

The vibe-emitted `MemberReactionsPage.tsx` declared `ProfileSummary` as a 5-field local interface, when the canonical `Profiles` entity has 16 fields. The agent saw the entity (the digest was in its context) and chose a slimmer projection on purpose:

- The component renders avatar, name, bio, handle, display name. It needs 5 fields.
- Importing the full `Profiles` type means every test fixture, mock scenario, and seed data must produce all 16 fields (`phone_hash`, `discovery_score`, `kyc_status`, `invite_code_used`, `invites_remaining`, etc.) just to typecheck.
- A 5-field local interface is cleaner.

This isn't drift. It's reasonable engineering: **components consume views/projections, not full database rows.** The agent made the right local call. The hypothesis was wrong about the unit at which the typed contract should bind.

We thought the contract should be the entity. The agents implicitly chose the contract should be the per-component view. They're correct.

## What this falsifies

- **Soft-prompted "import the entity" directive does not fire** even when (a) the prompt says so explicitly, (b) the bridge exists structurally, (c) the entities digest is in context, (d) all of the above at once. Across two agents and three runs, the consistency was 0/3.
- **Full-entity import is the wrong granularity.** The agents will keep declaring local views as long as components use subsets of entity columns — which is most components.
- **Adding more rails won't fix this.** We could escalate to harder enforcement (type-level forbidding inline declarations, recon-side rejection of any non-imported domain shape) — but that fights against legitimate engineering instinct, and the failure mode is consistent enough that the rail won't hold.

## What this does NOT falsify

- **The entity layer still has value as supporting infrastructure.** Refactor codemods, schema sync, deterministic naming for tables/columns, surface the database vocabulary to refine — these all work. We just shouldn't treat entities as a load-bearing rail for agent convergence.
- **Per-component generated view types might still work.** `MemberReactionsPageProfile = Pick<Profiles, "id" | "handle" | "display_name" | "avatar_url" | "bio">` — refine specifies which fields each component reads, codegen emits the projection, the agent imports its component's OWN view. Names are deterministic; consistency is per-component. That's a different + bigger experiment.
- **AST-driven reconciliation remains untested.** Different entirely; could still work. Out of scope today.

## What changes architecturally

The user's read of the empirical result was the right one: **lift the rails. The only limit on brew should be passing tests; tests should consist of behavioral contract + UI shape.**

This pivot:

- Removes plate-vs-legacy mode distinction (brew is one mode).
- Removes `allowed_paths` enforcement (only `tests/` + vitest config + auto-gen artifacts stay frozen).
- Removes the `@slowcook-port-from` carve-out (task #68 deleted from queue — no longer needed if there's no UI freeze to carve out).
- Removes most "you may not touch X" prompt rules.
- Keeps the full-suite test gate (cross-story regression catches drift) and the iteration ratchet.
- Promotes recon shape tests from supporting check to load-bearing UI contract — this is where the real work moves.

Brew converges to the way a human engineer would behave: read the tests, write what's needed, iterate, halt cleanly when stuck. Tests + recon shape tests + the full-suite gate are the rails.

The entity layer stays in place but demoted to "supporting infra." Useful for refactors, schema discipline, and surface vocabulary in refine prompts. Not load-bearing.

## What we'd do differently if revisiting

If we wanted to re-test the entity hypothesis under stricter conditions:

1. **Per-component view generation** — refine declares `Component reads: [profiles.id, profiles.handle, profiles.display_name, ...]`. Codegen emits `<Component>Props = Pick<Profiles, ...>`. Agent imports its specific view. Tests against this would actually fire.
2. **Compiler-enforced inline rejection** — eslint rule that rejects any inline interface declaration for a name that overlaps with an entity. Hard signal, not soft. Fights against legitimate use; might be a worse cure than disease.
3. **Mock-side typecheck integration with prod entities** — make the redeclaration TYPECHECK-fail. Currently mock has its own tsconfig and inline declarations don't conflict with prod entities.

(1) is the most promising. (2) and (3) would add friction; (1) gives the agent a typed contract that matches its natural granularity.

We don't have plans to ship any of these yet. The current pivot — strip the rails, let tests be the gate — is the cheaper, falsifiable next move.

## Telemetry to keep watching

When the post-strip brew runs land, watch:

- **Cross-story regressions caught by full-suite gate.** If frequent, the gate is too coarse; we'd need finer scope. If rare, the architecture is healthy.
- **Diff coherence per PR.** Are brew's diffs human-shaped (focused on the story) or sprawling (touched 15 files for one ration badge)? Sprawling = signal that brew is over-refactoring; we might need a softer diff-size hint in the prompt.
- **Iteration count + cost.** If they go DOWN vs the pre-strip baseline, the rails were taxing brew. If they go UP, there's friction we haven't surfaced.

## Reference data

For the next experiment that wants to check entities-as-rails, baseline:

- 10 entities extracted from 20 rewo migrations cost $0 (deterministic; no LLM).
- Mock-side shim adds ~10 lines, no friction.
- Cli α.6 + α.7 + llm-anthropic 0.14.1 + 0.14.2 published; reverting prompt directives is a future cli α.8 task.
- 3/3 dispatches across vibe + brew showed 0 entity imports. n=3 is small, but the consistency across two distinct agent personalities is decent signal.

If a future experiment runs ANY entity-import-positive result against rewo without the per-component-view trick, that would update this finding. Until then, treat the entity-prompt-directive approach as empirically falsified.
