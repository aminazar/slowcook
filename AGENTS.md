# slowcook for AI agents

You're an AI coding agent (Claude Code, Cursor, etc.) helping a human
ship features through slowcook. **This doc is the canonical entry
point.** Read it before running any `slowcook` command.

> Forge support today: **GitHub only.** No GitLab/Bitbucket adapter
> ships yet. If the consumer's repo is on a different forge, slowcook
> won't run — escalate that to the human.

---

## Decision tree (start here)

```
What is the human asking?

  ├── "set up slowcook on this repo"
  │     ├── greenfield (no src/)            → `slowcook init`
  │     └── brownfield (existing src/)      → `slowcook init from-prod`
  │                                            then `slowcook init entities`
  │
  ├── "ship a feature / story"
  │     ├── 1. Human files a GitHub issue describing the feature
  │     │     (you may help draft it; final wording is theirs)
  │     ├── 2. `gh workflow run slowcook-refine.yml -f issue=<num>`
  │     │     → refine asks clarifying questions on the issue
  │     ├── 3. Human answers; refine emits a spec PR
  │     ├── 4. Human merges spec PR; vibe + recipe (testgen) workflows
  │     │     auto-dispatch and open mockup + tests PRs
  │     ├── 5. Human merges mockup + tests; `slowcook brew` workflow
  │     │     auto-dispatches and opens a brew PR
  │     ├── 6. If brew halts: chef-drift auto-dispatches; if
  │     │     chef-drift exits 1 in --pr mode the workflow chains
  │     │     to chef-orchestrate (decides redispatch / rebase /
  │     │     escalate / close)
  │     └── 7. All-green brew PR ships
  │
  ├── "investigate a bug filed on the consumer's repo"
  │     ├── `slowcook investigate --issue <num>`  emits bug-profile
  │     └── then `slowcook recipe --regression`   emits a failing test
  │
  ├── "audit my codebase for refactors / dead stubs"
  │     ├── `slowcook recon --reuse-scan`           near-duplicate components
  │     ├── `slowcook recon --stub-scan`            stale @slowcook-stub markers
  │     └── `slowcook refactor`                     ranks proposals.json
  │
  └── "I'm reproducing a slowcook bug"
        → read REPORTING.md (or `slowcook docs reporting`)
        → set SLOWCOOK_READ_ONLY=1 before running anything on
          someone else's repo
```

---

## Pipeline at a glance

```
issue
  │
  ▼
refine ────────► spec PR ────────► (merge)
                                      │
                                      ├──► vibe   ────► mockup PR
                                      │                   │
                                      │                   ▼ (merge)
                                      │
                                      └──► recipe ────► tests PR
                                                          │
                                                          ▼ (merge)
                                                          │
                                                          ▼
                                                        port
                                                          │
                                                          ▼
                                                        recon (gate)
                                                          │
                                                          ▼
                                                        brew  ──┐
                                                          │     │
                                          (halt: AGENT_STALLED, │
                                          MOCKUP_DESIGN_CONFLICT,│
                                          MANIFEST_DRIFT, ...)   │
                                                          │     │
                                                          ▼     │
                                                    chef-drift ─┤
                                                  (exit 1?      │
                                                   auto-chains  │
                                                   to ...)      │
                                                          │     │
                                                          ▼     │
                                                  chef-orchestrate
                                                  ├── escalate (PM)
                                                  ├── close (superseded)
                                                  ├── rebase (BEHIND main)
                                                  └── redispatch_brew
                                                          │
                                                          ▼
                                                  back to brew or done
```

---

## Per-command quick reference

All commands accept `--help` for full flag listings. One-line summaries:

| Command | What it does | Cost / time |
|---|---|---|
| `slowcook init` | Scaffold slowcook into a greenfield project (workflows, mock dir, etc.) | $0 / <1 min |
| `slowcook init from-prod` | Brownfield: emit `mock/` from `src/` per 4-strategy taxonomy | $0 / <1 min |
| `slowcook init entities` | Walk `supabase/migrations/*.sql` → emit per-table TS interface + zod schema | $0 / seconds |
| `slowcook init mock` | Add `mock/` skeleton + auto-wire pnpm workspace if applicable | $0 / seconds |
| `slowcook refine` | Read source issue, ask clarifying questions, emit spec yaml + PR | ~$0.50–1.50 |
| `slowcook vibe` | Read spec, emit mockup PR (mock-runtime React app) | ~$1–2 |
| `slowcook plate` | Apply `/plate <instruction>` PR-comment amendments to a mockup PR | ~$0.30–1.50 |
| `slowcook recipe` | (= `testgen`) emit tier-1 + tier-2 acceptance tests | ~$1–2 |
| `slowcook port` | Deterministic copy `mock/src/*` → `src/*`, rewrite mock-runtime imports | $0 / seconds |
| `slowcook recon` | Pre-brew structural backstop (renames + testid gaps + history conflicts) | $0 / seconds |
| `slowcook recon --reuse-scan` | Story-agnostic: flag near-duplicate components/APIs | $0 / seconds |
| `slowcook recon --stub-scan` | Find `@slowcook-stub` markers older than `--stub-max-age-days` | $0 / seconds |
| `slowcook brew [--with-navigator]` | Ratcheted implementation loop. `--with-navigator` adds pair-brew (~10–20% cost surcharge) | ~$0.50–3 |
| `slowcook brew --pair-sim` | Local-only pair-brew simulator (driver+navigator over a fixture) | varies |
| `slowcook chef --pr <n>` | Classify failing PR (self-fail / external / infra / out-of-date) | $0 (deterministic) |
| `slowcook chef-drift` | Surgical drift-fixer: triggered on mock-isolation / recon escalation / brew halt | ~$0.05–0.50/move |
| `slowcook chef-orchestrate --pr <n> --story <id>` | Decide redispatch_brew / rebase / escalate / close on a halted PR | ~$0.01–0.05 |
| `slowcook investigate --issue <n>` | Diagnose a bug from a GitHub issue, emit bug-profile JSON | ~$1–3 |
| `slowcook recipe --regression --bug-profile <path>` | Emit failing regression test for a sift'd bug | ~$0.50–1 |
| `slowcook sift --bug-profile <path>` | Narrow red→green ratchet for a bug fix, bounded by `fix_scope` | ~$0.50–2 |
| `slowcook refactor` | Read `.brewing/refactor/proposals.json`, rank by benefit/cost | $0 |
| `slowcook docs <topic>` | Print bundled doc (`reporting`, `agents`, `read-only`) | $0 |
| `slowcook help` | List all commands | $0 |

---

## Pitfalls memory (read this — saves real money + time)

These are empirical lessons from the consumer dogfood. Treat them as
non-negotiable defaults unless the user specifically overrides.

### Publishing / packaging

- **Always `pnpm publish`, never `npm publish`.** npm leaves
  `workspace:^` unresolved → consumers hit `EUNSUPPORTEDPROTOCOL`. Use
  `pnpm publish --tag alpha --no-git-checks` (or whichever tag).
- **Build before publish, every time.** `prepublishOnly: tsc -b` is
  the guard but verify `dist/` is fresh. Stale dist has shipped before.
- **Update README / CHANGELOG every point release.** Status table, line
  per release. Don't accumulate undocumented alphas.

### pnpm + Next.js

- For consumers using Next.js + pnpm workspace, set `node-linker=hoisted`
  in `.npmrc`. Default symlink layout breaks Next 16's turbopack root
  inference (`couldn't find next/package.json from project directory`).
- `slowcook init mock` auto-wires the workspace when it detects pnpm.
  npm/yarn consumers see a recommendation, not auto-migration (lockfile
  re-resolution risk).

### Chef stack

- **Chef never edits `tests/`, `vitest.config.*`, or `.brewing/auto-gen/`.**
  These are frozen. If the only fix requires a test edit, chef returns
  `pm_question`.
- **Chef-drift uses `search_replace` only**, never full-file regeneration.
  Find string must appear exactly once in target.
- **Chef-orchestrate prefers `escalate` on ties.** PM is the safety valve.

### Brew

- **Brew can't fix test infrastructure.** If the failure is in
  `vitest.config.*` or `tests/_setup/`, brew will halt repeatedly. The
  fix is upstream in slowcook, not in the consumer's code.
- **`--with-navigator` adds 10–20% spend** (a navigator LLM call per
  iteration). Skip it on simple stories; use it when soft-prompt steering
  needs hardening.

### Refine + spec

- **PM intent in the issue body + first refine answer is contractual.**
  Refine cannot silently weaken (e.g., "similar to feed" → "emoji is a
  later concern" is forbidden). Only an explicit later PM comment can.
- **Side-effects audit (0.18+):** when refine detects contradiction with
  a prior story, it enumerates the exact assertions that would need to
  flip. PM reviews granularly.

### Workflows

- **Self-hosted runners need `gh` CLI.** Slowcook's chef-drift workflow
  installs it via the no-sudo binary. If you write a new workflow, add
  the same step.
- **Chef-drift exit 1 auto-chains to chef-orchestrate** in the rewo
  reference workflow shape. Mirror this if you wire your own.

### When something goes wrong

- **Read [REPORTING.md](./REPORTING.md)** (or `slowcook docs reporting`)
  before filing a bug. Don't bundle artifacts; share URLs.
- **Use `SLOWCOOK_READ_ONLY=1`** when reproducing a bug on someone else's
  repo. Blocks every GitHub-side write.

---

## What to read next

- [README.md](./README.md) — the marketing overview + status table
- [REPORTING.md](./REPORTING.md) — how to file a slowcook bug
- [docs/plans/](./docs/plans/) — the roadmap / design docs (if a story
  references one, read it before running the agent)

If anything in this doc is wrong or outdated, file a slowcook issue
following the REPORTING.md recipe.
