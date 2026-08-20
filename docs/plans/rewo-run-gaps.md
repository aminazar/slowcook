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

## G4 — agents disagree on the forge-token env var name

- **surfaced by**: the second live worker pass (retry after G3, 2026-08-20
  00:34 CEST). Trace `2026-08-19T22-34-51-248Z-refine-34`: refine exited 2 in
  ~6s with "GITHUB_TOKEN environment variable is not set." Worker applied
  `agent:failed` + attributed comment (which is how this was diagnosed —
  the box's sshd went unreachable minutes later, and the comment carried the
  stderr tail anyway; the instrument survived losing the box).
- **precondition**: none named — an environment contract gap, the doctor
  class again: refine hard-requires `GITHUB_TOKEN`; the worker unit exports
  `GH_TOKEN` (gh's own convention); the worker itself accepts either.
- **root cause**: the worker resolved a forge identity but did not hand it to
  the agent it spawned — it inherited raw `process.env` and each agent reads
  a different var name.
- **fix**: worker passes its resolved token to the child under BOTH names
  (`GITHUB_TOKEN` + `GH_TOKEN`). One identity, one authority, no per-agent
  env guessing.
- **verified**: live re-run of refine on #34 after box resync (pending —
  box ssh currently refused, likely fail2ban after tonight's connection
  burst).

## G5 — worker misread `--no-require-label` ("waive = skip", not "act anyway")

- **surfaced by**: the third live pass (2026-08-20 00:40 CEST, trace
  `2026-08-19T22-40-36-786Z-refine-34`): refine built its full history index
  (~11s), then printed `Noop: issue is not labeled needs-refinement
  (precondition waived by --no-require-label)` and exited 0. The worker
  consumed the trigger and — worse — described the run as "questions posted",
  which never happened.
- **precondition**: refine's own, by design (dovizir handover §4): the
  `needs-refinement` label IS the act/skip gate; the flag only converts a
  hard-fail (exit 3) into a quiet skip (exit 0).
- **root cause**: a worker bug, not a refine bug — W1 assumed the flag meant
  "proceed without the label". Also a naming/UX note for slowcook: a flag
  whose waiver still blocks the action invites exactly this misreading.
- **fix**: (1) the worker now publishes `needs-refinement` before spawning
  refine — a human's `agent:refine` trigger *declares* that state, so this is
  the plan-§1 label reconciliation, not a repair; the flag is dropped.
  (2) `mapRefineOutcome` recognizes `Noop:` lines and reports them verbatim
  instead of narrating fictitious progress.
- **verified**: unit test on the noop mapping + live re-run on #34 (pending).

## G6 — the PM's 👍 was invisible, and an approved split stayed manual labor

- **surfaced by**: Amin reacting 👍 to refine's multifurcation proposal on
  reworthy/app#34 (comment 5348900683) — and nothing happening. Reported by
  Amin directly: "I responded with thumbs-up, refine didn't pick it up."
- **precondition**: none — a design gap, twice over: (1) no agent reads
  comment reactions, so the cheapest possible PM gesture (the one the
  proposal's own instructions suggest!) is not a signal; (2) even the
  documented 👍 path told the PM to *file each sub-issue by hand* — against
  the standing ruling that everything manual should be in slowcook.
- **root cause**: the multifurcation flow was written PM-executes; the worker
  programme needs it slowcook-executes with the 👍 as the HITL gate.
- **fix**: forge grows optional `listCommentReactions` (+ `createIssue` on
  the interface); refine, re-run on a proposal-labeled issue, reads the
  decision — 👍 → executes the split itself (files non-overlapping
  sub-issues with "Split from #N" lineage + needs-refinement, releases the
  parent, $0/no LLM), 👎 or a human "keep as one" reply → single-spec path,
  nothing → honest "awaiting PM" noop (previously it would have produced the
  mega-spec the proposal warned against!). New proposals embed a
  machine-readable sub-issue marker; a markdown fallback parser recovers
  pre-marker proposals like #34's. The worker maps `Split executed:` and
  carries the chain onto the sub-issues (`agent:refine` on each — the 👍 was
  the gate; labeling children is transport).
- **verified**: 11 new unit tests (marker round-trip, #34-shape markdown
  fallback, decision rules incl. bot-echo guard, worker advance mapping);
  live: split execution on #34 after deploy (pending below).

## O2 (observation) — agent comments post as the operator, not as an agent

Amin's UX note: worker/agent comments on reworthy/app show `aminazar` as
the author (the box's gh login). Plan §5 anticipated this — the in-body
attribution header is the zero-setup tier. The visible-author fix needs an
identity only Amin can create: a machine account (simplest: create account,
grant repo access, `gh auth login` as it on the box) or a GitHub App
(`slowcook-agent[bot]`; needs slowcook support for App-token minting —
a real feature). Awaiting Amin's pick.

## O1 (observation) — /root/rewo drifted off main

The workload was derived while `/root/rewo` sat on `fix/mock-types-node`,
not `origin/main` (verified state from 2026-08-19 said main). Harmless in
dry-run, wrong for live runs: the worker records `gitSha` but nothing
asserts "the checkout is on the ref this workload claims to describe".
Doctor/worker check to add: expected-ref assertion per pass.
