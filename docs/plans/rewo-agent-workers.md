# Slowcook agent workers on GitHub — plan

> **STATUS: this is slowcook's default operating model, not a rewo scaffold.**
> Amin's ruling (2026-08-19): the pipeline runs itself and calls a human only at
> declared HITL gates. Rewo is the first consumer, not the reason. The worker
> therefore ships in slowcook (`packages/forge-github` templates + a
> `slowcook worker` command), never as a box-local script.

**What this is for.** Real workers on the rewo box, running slowcook agents via
the `claude` CLI, triggered by label changes on `reworthy/app` issues, advancing
outstanding work unattended — while I watch, and while they leave enough trace
that I can find *slowcook* bugs in the process.

**The primary deliverable is the bug ledger, not the shipped work.** Rewo
progress is how we generate evidence; the evidence is the point.

---

## 0. The failure mode this is designed to expose

Amin's framing, and it should shape the whole design:

> "…to find slowcook agent bugs (or lack of initial starting point, usually an
> output of another agent) in the processes."

That names the real defect class. Each agent consumes the previous agent's
output: refine needs an issue, recipe needs a merged spec, brew needs a merged
manifest, eye needs a deployed build. When a stage produces something subtly
wrong — or nothing — the *next* stage fails, far from the cause, and the log
blames the wrong agent. Every failure this week was this shape: the peel
premise, the `.env`, the RLS theory, the stale box CLI.

So the workers must record, per handoff, **what the next agent needed and what
it actually got**. That is the instrument. Everything else is plumbing.

---

## 1. The workload — derived state, not label state

**This corrects my first cut.** I had written "labels are the only state", which
makes the worker purely reactive: it sits waiting to be told. Amin's correction
(2026-08-19): the worker needs a WORKLOAD — every story (order), what state it
is actually in, and therefore what it needs next.

The difference matters because **labels are a projection of state, not state
itself**. A label can be stale, missing, or wrong; the artifacts cannot. So the
worker DERIVES each story's state from what exists on disk and on GitHub, and
uses labels only to publish that state and to let a human override it.

`slowcook stories status --json` is the existing seam for this and should grow
into the workload view rather than being reimplemented.

### State is per-story-per-surface, not a scalar

Amin's own examples show the state space is not a line:

| Question | Derived from |
|---|---|
| only a story? | issue exists, no merged spec |
| refined? | spec merged, parses, has invariants + scenarios |
| **needs re-refine because it changed?** | spec exists BUT its source (issue body, PRD anchor) changed after the spec froze |
| tests ready? | manifest exists, tests discoverable, red at baseline |
| brewed? | impl PR merged, story tests green |
| **brewed but needs the PWA frontend?** | backend surface satisfied, PWA surface not |

The last two rows are the ones a naive pipeline gets wrong. A story is not
"done" — it is done *for a surface*. Rewo's PWA work means a story can be
complete server-side and untouched client-side, and a scalar `status: done`
erases that. The workload therefore tracks **(story × surface) → state**.

### Drift is a first-class state, not an error

"needing new refine as it changed" deserves emphasis: it is the **staleness**
class that produced every serious failure this week — the stale box CLI, the
mock that could not build, the overlay prop removed under a consumer, the spec
that disagreed with its tests. In each case something looked fine because
nothing compared it to its source.

So the workload computes, per story, whether each artifact is still consistent
with what it was derived FROM (issue → spec → tests → code), by content hash.
A story whose issue changed after its spec froze is `spec-stale`, and that is a
workload item — not a silent inconsistency waiting to mislead a later stage.

### Labels publish the derived state

Each pass, the worker reconciles labels to the derived state so GitHub shows
the truth, and a human can still force a transition by relabelling (the worker
treats a human label as an override and records that it did).

| Trigger label | Worker runs | On success | On failure |
|---|---|---|---|
| `agent:refine` | `slowcook refine --issue N` | spec PR + `agent:refined` | `agent:failed` + report |
| `agent:recipe` | `slowcook recipe --spec ID` | tests PR + `agent:reciped` | `agent:failed` + report |
| `agent:brew` | `slowcook brew --story ID` (haiku→sonnet→opus) | impl PR + `agent:brewed` | `agent:failed` + report |
| `agent:eye` | `slowcook eye --story ID` | verdict comment + `agent:qa-pass`/`agent:qa-fail` | `agent:failed` + report |

### The trigger table (what each derived state asks for)

Rules:
- The worker **removes its trigger label** before starting. Crash-safe: a stuck
  job never re-fires in a loop.
- `agent:failed` is terminal until a human relabels. No silent retries.
- **Advancement is automatic EXCEPT at a declared gate.** My first cut said "no
  auto-advance across merges, a human applies the next label." That was too
  blunt, and it was wrong: it makes a human the transport layer for every step,
  which is precisely what this is meant to remove. slowcook already has the
  right instrument — `slowcook gate check --stage <refine|plate|brew> --pr <n>`,
  where a stage advances only once a HUMAN in the required role approves on the
  PR, and bot/agent reviews never satisfy it.

  So: the worker advances the chain by itself, and where a spec declares a gate
  for a stage, it stops and waits for that approval. Gates are the human
  touchpoints; everything between them is automatic. A project that declares no
  gates runs end to end unattended — that is a legitimate configuration, and its
  risk is the project's to choose, not the worker's to override.

### Order of work

With a workload the worker can choose, rather than taking whatever was labelled
last. Default policy, and it should be configurable:

1. **unblock before advance** — a `precondition-missing` or `spec-stale` story
   is worked before a fresh one, because staleness compounds;
2. then by declared story priority / release label;
3. then oldest first.

A workload also makes the run *reportable*: "31 stories — 12 done, 4 awaiting a
gate, 3 stale, 2 failed, 10 untouched" is the thing to publish each iteration,
and it is impossible to say from labels alone.

## 2. Worker anatomy (one dispatcher, not four daemons)

`/opt/slowcook-worker/worker.mjs`, modelled directly on the box's working
`lcr-watch.mjs`:

- **systemd timer**, `Type=oneshot`, every 3 minutes. Not a long-lived daemon —
  the proven pattern on this box, and it cannot leak state between runs.
- **Lockfile** at `/run/slowcook-worker.lock`; one job at a time. brew's own
  working-tree lock (slowcook #414) is the second line of defence.
- **Identity**: the box's `gh auth token`. Inert until `gh` is logged in, so the
  write identity is exactly whoever the operator authenticated.
- **Model backend is a seam, not a choice baked in.** `SLOWCOOK_LLM=claude-cli`
  runs on a subscription; `ANTHROPIC_API_KEY` runs on the API. Both already work
  for refine and brew (the MCP bridge, #393), and spend is recorded at list
  price either way so cost reporting is identical. The worker reads whichever is
  configured and states which it used in every job's `cmd` record. Neither is
  the default — the operator's environment decides.
- **Isolation**: each job in its own `git worktree` under `/root/rewo-work/<id>`,
  removed on completion. Never the shared checkout.
- **Budget**: hard `--budget-usd` per job, and a daily ceiling the worker
  refuses to exceed. Reports spend per job.

## 3. Tracing — the actual instrument

Per job, `/root/rewo-run/logs/<ts>-<agent>-<issue>/`:

```
cmd            exact argv, env names (never values), model, cwd, git sha
preconditions  what this agent REQUIRED and whether it was present:
                 refine -> issue body non-empty? labels sane?
                 recipe -> spec merged? spec parses? invariants non-empty?
                 brew   -> manifest exists? tests discoverable? red at baseline?
                 eye    -> mock builds? deployed URL responds?
stdout/stderr  full
artifacts      PRs opened, files written, sha of each
outcome        success | failed | precondition-missing
handoff        what it produced for the NEXT agent, and a hash of it
```

**`preconditions` and `handoff` are the two files that find slowcook bugs.**
A `precondition-missing` outcome names the *upstream* agent that under-delivered
— that is exactly the "lack of initial starting point" class, made visible at
the point of the gap instead of three stages downstream.

The worker **must not** repair a missing precondition. It records and stops.
Repairing hides the very defect we are hunting.

## 4. What I do while they run

- Poll the log tree and the issue timeline every loop iteration.
- For each `failed` / `precondition-missing`: diagnose, file a slowcook issue,
  fix at HEAD, `sync-slowcook.sh` to the box, relabel to retry.
- Maintain `docs/plans/rewo-run-gaps.md` — the ledger. Per entry: symptom,
  which agent, which precondition, root cause, fix commit, verification.
- Report each iteration: jobs run, outcomes, spend, gaps found, gaps fixed.

## 5. Per-agent GitHub identity

Verified constraint: **a GitHub App has exactly one bot user**, so one App
cannot post as several agents.

| Option | Identity | Cost |
|---|---|---|
| One App per agent | true `slowcook-refine[bot]` etc. | N apps, N keys, N installs |
| Machine users + PAT | real avatars | seats, weaker posture |
| One token + header | body says which agent | free, works today |

**Recommendation: start with the header.** Every comment opens with
`**slowcook-refine** · issue #N · run <id>`, which gives full attribution in the
trace for zero setup. Move to one-App-per-agent only if the visual identity
matters to you — it is a real cost and buys nothing for debugging.

## 5a. What "almost automatic" requires that does not exist yet

Being honest about the gap between this plan and the ruling:

1. **Auto-advance on merge.** Something must apply the next trigger when a spec
   or tests PR merges. Cleanest as a slowcook workflow
   (`on: pull_request: types: [closed]`) that labels the issue — not worker
   polling, so the transition is atomic with the merge.
2. **Gate declaration is per-spec today.** For a default operating model it
   needs a project-level default (`.brewing/gates.yaml`: which stages gate, which
   role) so a repo opts in once rather than per story.
3. **`agent:failed` is terminal by design.** Under "almost automatic" that needs
   a bounded retry — one retry on a transient class (network, rate limit, API
   5xx), never on a substantive failure. A halt that means "the spec contradicts
   itself" must never be retried.
4. **Escalation ladder must be declared, not hardcoded** — haiku→sonnet→opus is
   right for brew and wrong for refine. Belongs in config.

These are the difference between a rewo scaffold and slowcook's default mode,
and each is a slowcook change, not a worker script.

## 6. Phasing

- **W0** — auth (below), then a **dry-run** worker: reads labels, writes logs,
  runs nothing. Proves the trigger/lock/trace path with zero spend.
- **W1** — enable `agent:refine` only. One issue end to end.
- **W2** — add recipe, then brew (haiku first), then eye. One stage at a time;
  each stage's handoff contract verified before the next is enabled.
- **W3** — steady state: I watch, diagnose, fix, resync.

Never enable a stage whose upstream handoff has not produced a verified artifact.

---

## 7. Amin: the login step

Two credentials on the box, both interactive — I cannot and should not do these
for you.

**1. Claude CLI** (the agents' model access)

```
ssh rewo
claude setup-token          # browser flow; prints sk-ant-oat01-...
echo 'export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...' >> /root/.slowcook-worker.env
```

Three traps, all hit this week:
- `setup-token` **prints** a token, it does not save one. Closing the terminal
  loses it.
- A stale `ANTHROPIC_API_KEY` in the environment **outranks** the OAuth token
  and yields an opaque `error_during_execution`. The worker env must
  `unset ANTHROPIC_API_KEY`.
- Verify before walking away:
  `ssh rewo '. /root/.slowcook-worker.env; unset ANTHROPIC_API_KEY; claude -p "say READY" --output-format json'`
  — expect `"is_error": false`.

**2. GitHub** (the workers' write identity)

```
ssh rewo
gh auth login --scopes repo,workflow      # choose the account the bot posts as
gh auth status                            # confirm the account + scopes
```

Whichever account you pick is the visible author of every agent comment and PR.
A dedicated machine account gives cleaner attribution than your own.

**Nothing runs until both are present.** The worker is inert without them — by
design, not by accident.

---

## 8. Risks I am carrying

- **Cost.** Many issues × brew escalation. Per-job cap + daily ceiling + spend
  reported every iteration, never discovered at the end.
- **A bad spec propagating.** Mitigated by no auto-advance across merges.
- **Worker bugs masquerading as slowcook bugs.** The worker stays deliberately
  thin — spawn, capture, label. Logic in the worker is logic that can lie.
- **My own repeated failure this week**: claiming a result from a log line
  instead of the artifact. Every outcome in the ledger cites the artifact.
