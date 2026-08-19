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

## O1 (observation) — /root/rewo drifted off main

The workload was derived while `/root/rewo` sat on `fix/mock-types-node`,
not `origin/main` (verified state from 2026-08-19 said main). Harmless in
dry-run, wrong for live runs: the worker records `gitSha` but nothing
asserts "the checkout is on the ref this workload claims to describe".
Doctor/worker check to add: expected-ref assertion per pass.
