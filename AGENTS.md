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
| `slowcook recon` | Pre-brew structural backstop (renames + testid gaps + history conflicts + **migration gate** — 0.19.0-α.18). If spec proposes a table/column with no migration covering it, escalates with `missing_migration` gap. Auto-discovers Supabase `*.sql` or TypeORM `*.ts` migrations. | $0 / seconds |
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
| `slowcook garnish` | Local commit-gate for human tweaks on agent work — runs scoped tests, commits with `Tweaks-output-of:` trailers (learning signal for the upstream agent) | $0 |
| `slowcook run-mock <story> --garnish` | DevTools Workspaces flow — boots mock locally, disables overlay, prints Chrome pairing instructions, auto-watches saves + auto-commits via garnish on green | $0 (per-commit; LLM only if test infra needs one) |
| `slowcook eval --all` | Prompt-regression gate: replay each frozen fixture's prompt builder + assert substring contracts. Wired in `eval-gate.yml` on prompt PRs. See `CONTRIBUTING.md` for fixture format. | $0 / seconds |
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
- **Chef-drift exit 1 auto-chains to chef-orchestrate** in the
  reference consumer-side workflow shape. Mirror this if you wire your own.

### When something goes wrong

- **Read [REPORTING.md](./REPORTING.md)** (or `slowcook docs reporting`)
  before filing a bug. Don't bundle artifacts; share URLs.
- **Use `SLOWCOOK_READ_ONLY=1`** when reproducing a bug on someone else's
  repo. Blocks every GitHub-side write.

### Local-developer flow (alternative to the remote overlay)

- **`slowcook garnish`** is the right command when you (or another
  engineer) edits files on top of an agent's commit. It runs the
  relevant tests, commits on green with trailers that record which
  upstream agent's work you tweaked. Don't `git commit` by hand on
  top of agent work — you lose the learning-signal trailer.
- **`slowcook run-mock <story> --garnish`** is the right command if
  you want to edit the mock app via Chrome DevTools Workspaces.
  It prints the one-time Chrome setup, then auto-garnishes on save.
  The remote overlay is disabled in this mode — they're alternative
  feedback channels, not stacked.

### CI/CD posture (2026-05-12)

- `main` is branch-protected: no force-push, no deletion. Admin
  bypass is on, so solo merges still work. When you arrive as a
  contributor, expect PR + 1 approval to land.
- Dependabot opens weekly grouped PRs (anthropic / vitest /
  typescript / testing) and monthly GitHub Actions version PRs.
  Auto-merge is OFF; everything goes through a human glance.
- Open ops backlog lives at [`docs/plans/ci-cd-roadmap.md`](./docs/plans/ci-cd-roadmap.md).
  Two HIGH items are filed as GitHub issues; the rest are queued
  in the doc until they become pressing.

---

## What to read next

- [README.md](./README.md) — the marketing overview + status table
- [docs/EPSS.md](./docs/EPSS.md) — **the Epic·Persona·Scenario·State model.**
  Read before emitting/consuming `testing-surfaces.json`, writing `epic` or
  `acceptance_scenarios` on a spec, or generating the LCR review matrix. Defines
  why a scenario is a task (not a route) and why universal states (loading/error)
  get one Foundations home instead of a per-page repeat. **Design drives state:**
  when building or reviewing a mock, treat each affordance as a requirement and each
  affordance-variant as a State; never simplify a component without recording what you
  dropped — a "drifted from design" comment is a dropped requirement, not a cosmetic nit.
- [REPORTING.md](./REPORTING.md) — how to file a slowcook bug
- [docs/plans/](./docs/plans/) — the roadmap / design docs (if a story
  references one, read it before running the agent)

If anything in this doc is wrong or outdated, file a slowcook issue
following the REPORTING.md recipe.
