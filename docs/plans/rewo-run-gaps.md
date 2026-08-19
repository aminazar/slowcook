# rewo agent-worker run — slowcook gap ledger

> The primary deliverable of the worker programme
> (docs/plans/rewo-agent-workers.md §4). Rewo progress is how we generate
> evidence; this file is the evidence. One entry per slowcook defect the run
> exposes. Every outcome cites the ARTIFACT (trace file, PR, gate output) —
> never a log line alone.

Entry format:

```
## G<n> — <one-line symptom>
- **surfaced by**: <agent / worker pass / trace path>
- **precondition**: <the named check that failed, if any>
- **root cause**: <the slowcook defect, not the rewo symptom>
- **fix**: <commit / PR>
- **verified**: <artifact that proves the fix, and how>
```

---

## G1 — box "build: Done" ran stale code (tsbuildinfo shipped, dist excluded)

- **surfaced by**: W0 deploy, 2026-08-19. Box `pnpm -r build` printed
  `packages/cli build: Done`, yet `slowcook worker` → "Unknown command" while
  `slowcook help` LISTED worker (help renders from the freshly-compiled
  manifest import; the dispatch switch lived in the stale `dist/cli.js`,
  mtime Aug 18).
- **precondition**: none named — that is the defect. The deploy path has no
  "installed CLI actually exposes the expected surface" assertion.
- **root cause**: the manual rsync ships `tsconfig.tsbuildinfo` (package
  root) but excludes `dist/`. `tsc -b` trusts the shipped buildinfo — which
  says everything is emitted — and skips emit. "Done" is a no-op against a
  dist it never looked at.
- **fix**: pending — this is the `slowcook deploy` capability (plan §9 row 1).
  Minimum viable: deploy must exclude `*.tsbuildinfo` AND end with a
  post-deploy assertion (`slowcook <new-command> --help` exits 0, or a
  content-hash check of dist against source). Workaround applied on the box:
  `tsc -b --force`.
- **verified**: after force-build, `slowcook worker --help` renders on the
  box (trace `/root/rewo-run/logs/2026-08-19T22-11-54-241Z-refine-34` was
  produced by the rebuilt binary).

## G2 — `worker systemd` template didn't survive contact with the box

- **surfaced by**: first `systemctl start slowcook-worker.service`,
  2026-08-20 00:12 CEST — exit 2, worker's own named refusal ("GITHUB_TOKEN /
  GH_TOKEN is not set") in the journal. Fail-closed worked; the template did
  not.
- **precondition**: the worker's auth check (named it correctly).
- **root cause**: two template assumptions false on a real box: (1) the
  operator env file is shell-format (`export X=…`), which systemd's
  `EnvironmentFile=` cannot parse; (2) systemd oneshot units get no `HOME`,
  so `gh auth token` finds no config and returns nothing.
- **fix**: `printSystemd` now emits the form that actually runs:
  `Environment=HOME=/root` + `bash -c` sourcing the env file, unsetting
  `ANTHROPIC_API_KEY`, exporting `GH_TOKEN=$(gh auth token)`.
- **verified**: hand-fixed unit on the box → pass exit 0, trace
  `2026-08-19T22-12-57-739Z-refine-34` with `backend: "claude-cli"` and env
  NAMES only.

## G3 — refine's default model was not in the pricing table (fail-closed guard caught it)

- **surfaced by**: the FIRST live worker pass (W1, 2026-08-20 00:28 CEST).
  Trace `/root/rewo-run/logs/2026-08-19T22-28-15-968Z-refine-34`: refine
  exited 78 in ~3s; worker honestly applied `agent:failed` + attributed
  comment on reworthy/app#34.
- **precondition**: none missed — this is a *different* guard working as
  designed: refine's own unpriced-model refusal ("a run whose cost cannot be
  computed also cannot be capped").
- **root cause**: `PRICING_PER_M_TOKENS` lacked `claude-opus-4-8` — refine's
  resolved default model — so the budget maths would have read $0. Bonus
  finding while fixing: the `claude-opus-4-7` entry carried Opus-4.1-era
  $15/$75 and over-reported spend ~3x (list is $5/$25).
- **fix**: added opus-4-8 / opus-4-6 at $5/$25, corrected opus-4-7 (pricing
  verified against platform.claude.com's table via the claude-api reference,
  2026-08-19). `slowcook cost reprice` settles past entries.
- **verified**: full workspace suite green; live re-run of refine on #34 after
  box resync (see run log below this entry when it lands).

## O1 (observation) — /root/rewo drifted off main

The workload was derived while `/root/rewo` sat on `fix/mock-types-node`,
not `origin/main` (verified state from 2026-08-19 said main). Harmless in
dry-run, wrong for live runs: the worker records `gitSha` but nothing
asserts "the checkout is on the ref this workload claims to describe".
Doctor/worker check to add: expected-ref assertion per pass.
