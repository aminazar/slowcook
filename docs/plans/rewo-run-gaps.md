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

## G7 — post-spawn EPIPE killed passes whose artifacts had already landed

- **surfaced by**: the three spec-emitting refine runs (#215/#216/#217,
  2026-08-20 ~15:35–15:47 CEST). Each run succeeded — spec written, branch
  pushed, draft PR opened (reworthy/app #218/#219/#220), trace recorded —
  and then the pass DIED with `HttpError: write EPIPE` applying the
  `agent:refined` result label.
- **root cause**: the worker's Octokit client sat idle through the
  multi-minute spawnSync; its keep-alive socket went stale, and the first
  post-spawn write hit the dead connection. Uncaught → exit 1 → the pass
  lost its result-label application and its own "processed" report (the
  journal grep for `processed` found nothing even though three specs had
  shipped — the log lied by omission while the traces told the truth).
- **fix**: `forgeMutate` — every post-spawn forge mutation gets a FRESH
  client per attempt and one retry on the transient class
  (EPIPE/ECONNRESET/ETIMEDOUT/5xx); a final mutation failure warns and
  the pass still completes (the artifacts and trace are already real —
  dying over a label reverses the truth hierarchy).
- **verified**: build + worker tests green; next live runs (recipe phase)
  exercise the path.

## G8 — a submitted spec-PR review was nobody's job

- **surfaced by**: Amin reviewing spec PR #218 and asking "was it picked up
  by agent? … it should not be picked up by you, what is the responsible
  agent?" — the session was about to be the transport, which is exactly
  what the plan forbids (§1: no human/session as transport layer).
- **root cause**: the worker derives workload from issue labels only. A
  submitted human review on an open spec PR is pipeline state — the spec's
  OWNER (refine, per the ratchet ownership rule) must answer it — but no
  derivation produced that job.
- **fix**: the worker now fetches open `slowcook/spec/*` PRs and derives a
  `refine --pr <n>` resubmit job whenever the newest SUBMITTED human review
  is newer than the PR's newest commit (feedback the spec hasn't answered).
  Derived jobs need no trigger label — the derivation is its own re-fire
  guard (once refine pushes, the review is older than the commit). PENDING
  (draft) reviews are excluded: GitHub shows them only to their author, so
  acting on one would leak invisible state (this bit tonight: the PM's
  review sat in PENDING and nothing could see it).
- **verified**: 3 new planner tests; live on #218 once the PM submits the
  pending review.

## G9 — refine resubmit amended the WRONG story (checkout branch ≠ PR)

- **surfaced by**: the first derived resubmit run (G8's feature, PR #218,
  2026-08-20 17:47 CEST): `refine --pr 218` (story-019) amended
  **story-021** and pushed "refine: resubmit story-021 per PR #218
  feedback" onto PR #220's branch — cross-pollution between two open PRs.
- **root cause**: `detectStoryIdFromBranch` trusted `git branch
  --show-current` with the comment "CLI workflow checks out the PR branch
  before invoking us" — true under GitHub Actions, FALSE under the box
  worker, where the shared checkout sat on the PREVIOUS run's branch.
  The Actions-era assumption became a landmine the moment the execution
  environment changed. (Same family as G1/O1: an environmental
  precondition assumed, not asserted.)
- **cleanup**: PR #220's branch force-pushed (with lease) back to its
  clean spec commit; pollution commit dropped.
- **fix**: the PR is authoritative — resubmit resolves the story from the
  PR's own head branch (`forge.getPullRequest`), and makes the checkout
  match before touching a file (fail-closed on a dirty tree). Legacy
  branch-detection kept only as fallback for adapters without
  getPullRequest. Worker mapper also now recognizes the resubmit output
  ("Spec amended:") instead of narrating it as "questions posted".
- **verified**: build + suite green (1679); live re-run on #218 after
  deploy (the review is still newer than the last commit, so the worker
  re-derives the job by itself).

## G10 (FIXED) — recipe has no review-response path

- **surfaced by**: taste's FIRST live review (PR #223, 2026-08-20 23:56):
  a substantive REQUEST_CHANGES — the generated schema test asserts DDL
  contradicting the spec's own migration, and the spec's mandated gap-log
  invariant is not verified. Correctly not merged.
- **the gap**: nothing answers taste on a tests PR. Spec PRs have refine's
  resubmit derivation (G8); tests PRs have no `recipe --pr N` amend path,
  so changes-requested findings sit for a human. The taste→author-agent
  conversation only closes for half the pipeline.
- **fix**: (1) `slowcook recipe --pr N` — tests-PR resubmit: PR-authoritative
  checkout (G9 pattern), feedback = timeline comments + human inline
  comments, model amends ONLY needed test files via a confined file-block
  protocol (writes locked to `tests/`), commits to the same branch, replies.
  (2) taste now posts changes-requested findings as a TIMELINE comment too —
  review bodies are an API surface resubmit paths never read. (3) unified
  author-resubmit derivation: ANY submitted review (taste or human) newer
  than the code routes spec PRs→refine, tests PRs→recipe. (4) BOUNDED
  ROUNDS: past MAX_REVIEW_ROUNDS(4) submitted reviews, both taste and the
  author agents stand down and the PM (cc'd on every changes-request)
  arbitrates — two models politely burning money is not a conversation.
- **verified**: parser + derivation tests (round cap, spec→refine,
  tests→recipe routing); live on #221–#223 after deploy.

## G11 — the worker wedged itself over branch-switch residue

- **surfaced by**: every pass from ~00:55 to ~02:48 (2026-08-21) failing
  with "checkout has uncommitted changes: ?? .brewing/diagrams/ ?? mock/".
  Refine's #129 resubmit had checked out a months-old spec branch;
  `reset --hard` there turned main's tracked `mock/` and
  `.brewing/diagrams/` into UNTRACKED leftovers, and the fail-closed dirt
  check refused every later pass. Self-inflicted denial of service.
- **root cause**: one dirt rule for two different situations. Modified
  tracked files are real uncommitted work; untracked-only residue is what
  switching to an older branch leaves behind — and since agents commit+
  push within their jobs, between-jobs untracked = debris by definition.
- **fix**: ensureBaseCheckout splits the cases — modified files still
  hard-stop; untracked-only triggers `checkout -f base` + `git clean -fd`
  (history-index preserved) with a logged note. Box manually unwedged the
  same way.
- **verified**: suite green; the wedge scenario replays on every old-branch
  resubmit and next passes proceed.

## G12 — recipe's resubmit amended tests without re-recording the manifest

- **surfaced by**: taste's round-3/4 verdicts on #221–#223 (2026-08-21
  ~03:15–03:31): summaries PRAISED the suites while a blocking finding
  recurred — amended/added test files (e.g. story-020-rls-and-constraints)
  absent from `.brewing/manifests/story-020.json`. The manifest is the
  ratchet's green gate, so unmanifested tests would be silently
  unenforced; taste was RIGHT to block, and the agent conversation could
  never converge — #222/#223 burned to the MAX_REVIEW_ROUNDS cap.
- **root cause**: `recipe --pr` wrote amended test files but never
  re-recorded the story manifest (and edited test titles orphaned old
  manifest ids).
- **fix**: resubmit runs `manifest record --story <id>` after writing
  files, committing files + manifest together.
- **arbitration**: #222/#223 sit at the cap by a now-fixed defect — the
  operator manually re-runs recipe --pr + taste --pr --merge on those two;
  #221 (3 reviews) converges automatically.

## G13 — brew derivation re-implemented already-shipped work

- **surfaced by**: minutes after "go brew" was enabled, the worker started
  `brew --story 001` — a story shipped months before the worker existed.
  Killed at ~2 min spend; aborted branch discarded. (Also defused: the
  stale W0 test label `agent:brew` on #43/story-005 became a live trigger
  the moment brew entered LIVE_STAGES.)
- **root cause**: brew-readiness was derived from timeless artifacts
  (spec + manifest + open unsettled issue) — true for every old-era story,
  whose issues predate the worker's labels. "Already implemented" is not
  visible in the index (old stories are `status: active`).
- **fix**: brew candidates must carry `agent:reciped` — the label the
  worker's OWN recipe stage publishes. Brew follows recipe in this chain;
  state the worker didn't publish is state it must not assume.
- **verified**: derivation test updated; workload on the box shows only
  worker-era stories as brew candidates.

## O2 (observation) — agent comments post as the operator, not as an agent

Amin's UX note: worker/agent comments on reworthy/app show `aminazar` as
the author (the box's gh login). Ruling: slowcook is not rewo-only — the
identity must scale per-consumer, via GitHub. **Fix shipped**: GitHub App
support in `@slowcook-ai/forge-github` (`appAuthConfigured` /
`mintInstallationToken`, named errors for not-installed / bad-key) + the
worker prefers the App identity, records `forgeIdentity` in every trace,
and hard-stops if the App is configured but cannot mint (silent operator
fallback would defeat the point). Each consumer org registers/installs a
"slowcook-agent" App once; agents post as `<app-slug>[bot]`. The adapter
was already installation-token-ready (`botUsername` handles the App 403).
Remaining: Amin's one-time App registration + install on reworthy/app +
APP_ID/PEM into the box env; later, an App-manifest-flow helper
(`slowcook worker init-app`) to automate registration for any consumer.

## O1 (observation) — /root/rewo drifted off main

The workload was derived while `/root/rewo` sat on `fix/mock-types-node`,
not `origin/main` (verified state from 2026-08-19 said main). Harmless in
dry-run, wrong for live runs: the worker records `gitSha` but nothing
asserts "the checkout is on the ref this workload claims to describe".
Doctor/worker check to add: expected-ref assertion per pass.

## G14 — follow-up amendment branched from the frozen pre-merge branch

- **surfaced by**: after spec PR #218 merged, a PM ruling comment spawned
  follow-up amendment PR #224 — built on the OLD `slowcook/spec/story-019`
  branch (pre-merge freeze). The diff re-created the whole spec file,
  dropped post-review fixes, and the amendment itself arrived truncated
  mid-line (`- "RLS: n"`) at the 8192-token cap.
- **root cause**: two faults. (1) Resubmit reconstructed the original
  branch name and reused it even when the PR was already merged — the
  branch is a fossil once squash-merge lands; the CURRENT spec lives on
  base. (2) `maxTokens: 8192` silently truncated a full-spec rewrite.
- **fix**: merged PRs amend the CURRENT spec on a fresh
  `story-<id>-amend-<ts>` branch off base; amendment calls use
  `maxTokens: 32000, stream: true`. #224 closed, branch deleted.
- **verified**: PR #225 (the redo) shows a clean incremental diff on base.

## G15 — amend-branch names broke the storyId regex

- **surfaced by**: `refine --pr 225` failed with ENOENT on
  `specs/story-019-amend-1787…yaml` — the greedy
  `story-(.+)$` capture swallowed the `-amend-<ts>` suffix into the id.
  Taste had the same regex and would have refused the PR as unowned.
- **root cause**: G14's new branch naming was invented without updating
  the two consumers that parse story ids out of branch names. A naming
  convention IS an interface; its parsers must ship in the same change.
- **fix**: non-greedy capture with an optional suffix:
  `story-(.+?)(?:-amend-\d+)?$` in refine resubmit AND taste (PR #442).
- **verified**: box run BOX_G15_OK; refine + taste both resolve story-019
  from the amend branch.

## G16 — resubmit pushed the amendment to a dead branch

- **surfaced by**: `refine --pr 225` reported success but PR #225 never
  changed — the push went to a freshly reconstructed
  `slowcook/spec/story-019` (the merged fossil name), resurrecting it as
  a stray remote branch while the real head `story-019-amend-…` sat
  untouched. Taste then re-reviewed an unchanged diff.
- **root cause**: checkout learned PR-authoritative branch resolution in
  G9, but the PUSH target was still computed from the story id. Read and
  write paths must resolve the branch the same way — one authority.
- **fix**: `prHeadBranch` hoisted and used as the push target whenever
  the PR is open (PR #443); stray remote branch deleted.
- **verified**: next resubmit pushed to
  `slowcook/spec/story-019-amend-1787311921017` — PR #225 updated.

## §5a shipped — gate declarations (`.brewing/gates.yaml`)

Not a gap — the plan's gate-declaration item, made real on PM request
("keep some vibe and qa gates for me"). Each artifact kind declares who
closes its gate: `agent` (taste may merge on approve) or `human` (taste
reviews and advises; the merge is the PM's — `--merge` never overrides).
Conservative defaults: spec/tests agent, brew/vibe/eye human; invalid
values fall back to defaults, never fail open. Approve-at-human-gate
cc's the PM. Shipped PR #444; rewo declares its gates in
`.brewing/gates.yaml` on main (71b7c21).

## G17 — taste cannot see the PR's own discussion thread

- **surfaced by**: three review rounds on rewo #225 in a row flagged
  "PM ruling not visible in the provided lineage" — while the rulings sat
  as comments ON THE VERY PR taste was reviewing. Its lineage was source
  issue + Q&A + spec + diff; the PR thread (where relays and corrections
  land during review rounds) was the one venue it never read.
- **root cause**: lineage was designed before review ROUNDS existed —
  the PR thread only became a decision venue when resubmit cycles and
  PM relays arrived (G10+). The reviewer's evidence set didn't grow with
  the process it polices.
- **fix**: TasteContext.prThread — last 8 PR comments (taste's own
  findings excluded, so past verdicts never count as evidence), with a
  supersession note (later comment wins).
- **verified**: next taste round on #225 stopped flagging the relay as
  unverifiable.

## G18 — testgen regeneration trips over the previous round's fossil branch

- **surfaced by**: `recipe --spec 019` after the spec amendment (#225
  merged): `fatal: a branch named 'slowcook/tests/story-019' already
  exists` — the local branch from the merged #221 round was never
  cleaned, and `createBranch` uses `checkout -b`.
- **root cause**: same disease as G14, testgen edition — agent branch
  names are deterministic per story, but nothing distinguished "fresh
  run" from "fossil of a merged round". The collision guard that
  protects parallel runs also blocked legitimate regeneration.
- **fix**: PR-authoritative fossil clearing before branch creation: an
  open PR on the branch routes to `recipe --pr N` (resubmit, exit 2);
  no open PR → the branch is a fossil, deleted locally and remotely,
  fresh branch starts from base.
- **verified**: rerun of `recipe --spec 019` on the box cleared the
  fossil and opened the regenerated tests PR.

## G19 — the discovery gate's feedback was filtered out of its own loop

- **surfaced by**: two consecutive resubmit rounds on tests PR #226 made
  the IDENTICAL mistake (bare import of `@/lib/supabase/admin`, a module
  brew hasn't created) despite the gate posting the exact error as PR
  feedback after round one. Round two hit the 2-strike terminal stop.
- **root cause**: the gate posts its error as a `### slowcook ·` comment
  — and the resubmit's feedback gatherer excludes ALL `### slowcook ·`
  comments as "own chatter". The gate wrote into a channel its own
  reader filters out; the model never saw the error it was told to fix.
- **fix**: `isFeedbackComment` — own chatter stays excluded EXCEPT
  comments carrying the discovery-gate marker.
- **verified**: third resubmit round on #226 switched to the committed
  throwing-stub pattern and passed discovery.

## G20 — discovery certified the worktree, not the committed artifact

- **surfaced by**: tests PR #226 was broken as committed (imported
  `@/lib/supabase/admin`, no stub in the PR) yet passed generation-time
  discovery — untracked residue from earlier rounds resolved the import.
  The residue even contained a README documenting BOTH needed stubs;
  only one was staged. Resubmit could not heal it (it may only write
  under tests/; stubs live in src/) — recovered by hand-committing the
  stub to the PR branch.
- **root cause**: discovery runs against the worktree; the "untracked =
  ok" dirt rule let residue accumulate that shadowed the committed tree.
  A gate that certifies an artifact must see ONLY that artifact.
- **fix**: discovery hygiene — manual `recipe` runs fail closed (exit 2)
  when modified/untracked files exist under src|tests, listing them;
  worker workspaces keep being auto-cleaned each pass.
- **verified**: unit tests (untracked-dir collapse caught via -uall);
  clean-tree rerun of `recipe --pr 226` recorded an honest manifest.

## G21 — brew derived as runnable while the story's tests were being revised

- **surfaced by**: the FIRST run of the new `slowcook workload` command
  (eleven-defects D5, dogfooding its own build): brew·story-019 showed
  "runnable" while tests PR #226 was open mid-review-loop. With the
  timer on, one taste request-changes round would have let the next
  pass brew against the contested old manifest on main.
- **root cause**: brew-readiness facts checked for an open BREW PR but
  not an open TESTS PR — "manifest exists on main" was read as settled
  when a revision of that very manifest was in flight.
- **fix**: `openTestsPr` fact; a contested story derives a BLOCKED brew
  job with named precondition `tests-settled` (upstream: taste) — still
  visible in the workload, never spendable.
- **verified**: box workload after deploy shows brew·019 BLOCKED on
  tests-settled while #226 is open; 020/021 stay runnable.
