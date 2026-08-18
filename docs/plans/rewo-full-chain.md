# Rewo full-chain autonomous run — plan

**Goal (stated priority order):** 1. exercise every part of slowcook — agents and
harness — and fix what breaks; 2. deliver stories + acceptances extracted from
rewo's PRD; 3. make rewo a PWA fit for later iOS/Android delivery.

**Standing rules for this run**
- The box always runs slowcook **HEAD**, built locally and rsynced — never npm.
- Every artifact change goes through its owning agent, driven by a labelled
  issue. No hand-edited specs or tests.
- brew escalates: **haiku → sonnet → opus**. Record which tier won.
- Dependencies are mocked/injected rather than blocking.
- Existing docs and the mock are reused, not rewritten.
- Every slowcook gap gets an issue, a fix, a local rebuild, and a resync.
- Logs under `/root/rewo-run/logs/` on the box; progress reported each iteration.

---

## Phase 0 — Foundations (no LLM spend)

0.1 **Sync slowcook to the box at HEAD.** rsync the monorepo, `pnpm install`,
    `pnpm build`, repoint `/usr/bin/slowcook` at the local dist. Ship
    `sync-slowcook.sh` so later fixes propagate in one command.
0.2 **Bring `/root/rewo` current.** Inspect the 32 dirty files before touching
    them — some may be real work. Then fast-forward to origin/main.
0.3 **Verify** `slowcook --version` reports HEAD, and `slowcook doctor`/`stories
    status` run clean against the real repo.

Exit: box runs HEAD; rewo checkout current; nothing destroyed.

## Phase 1 — Requirements → stories

1.1 **Add the PWA requirement to the PRD.** `docs/PRD.md` is unowned by any
    agent, so it is hand-editable — installability, offline shell, push-ready,
    app-store wrapping later.
1.2 **`slowcook menu --prd docs/PRD.md`** to decompose into stories. 30 specs
    already exist; menu must extend, not duplicate.
1.3 **Reconcile** new drafts against `specs/_index.yaml` (supersede chains).
1.4 **Raise one issue per new story**, labelled `needs-refinement`, so refine —
    not I — writes the spec.

Exit: issues filed and labelled; no spec written by hand.

## Phase 2 — Agent runners on the box

2.1 **`slowcook-agent-runner`**, modelled on the working `lcr-watch.mjs` +
    systemd pattern already on the box. Polls for label→agent work:

    | label | agent | produces |
    |---|---|---|
    | `needs-refinement` | refine | spec PR |
    | `spec-ready` (merged) | recipe | tests PR |
    | `tests-ready` (merged) | brew | implementation PR |
    | `needs-qa` | eye | fidelity verdict |

2.2 Run under systemd, restart-on-failure, one job at a time per repo (the
    working-tree lock from #414 makes concurrent brews impossible anyway).
2.3 **Per-agent identity in issues** — investigate and report (see §6).

Exit: agents idle in background, picking up labelled work unattended.

## Phase 3 — The chain, story by story

For each story: refine → spec PR → review/merge → recipe → tests PR → merge →
brew (haiku first) → implementation PR → **eye** QA → merge.

Escalation rule: brew retries with sonnet only after haiku halts, opus only
after sonnet halts. Record tier, iterations, spend per story.

## Phase 4 — PWA

Manifest, service worker, offline shell, install prompt, icon set — as stories
through the same chain, not as hand edits. `eye` verifies the installed shell
renders correctly across the viewport matrix.

## Phase 5 — Gap ledger

`docs/plans/rewo-run-gaps.md`: every slowcook failure, its diagnosis, the fix,
and the commit. This is the primary deliverable — the run exists to find these.

---

## 6. Per-agent identity in GitHub (the question to answer)

Today all slowcook comments arrive from one token, so every agent looks like the
same actor. Options, to be verified before recommending:

- **One GitHub App per agent** — each app has its own `name[bot]` identity, so
  comments read "slowcook-refine[bot]". Highest fidelity; N apps to install and
  N private keys to hold.
- **One App, many bot accounts** — not possible: an App has exactly one bot user.
- **Machine users with PATs** — real accounts, real avatars, but they consume
  seats and are weaker security posture.
- **Single App + a rendered header** — cheapest, no identity change; the comment
  body names the agent. Already partly true today.

Recommendation deferred until verified against the App's installation model.

---

## Risks I am carrying deliberately

- **The box checkout is 30+ commits stale with 32 dirty files.** Inspect before
  syncing; a destructive `reset --hard` could discard real work.
- **Cost.** Many stories × brew escalation. Cap per story and report running
  totals rather than discovering the bill at the end.
- **My own failure mode this session** has been claiming success from a log line
  instead of the artifact. Every phase exit is verified against the artifact.

---

# HANDOFF — state at end of Phase 0 (2026-08-18)

Phase 0 is **complete and verified**. Resume at Phase 1.

## Verified true right now

- **Box runs slowcook HEAD 0.33.0** from `/root/slowcook-head`, symlinked at
  `/usr/local/bin/slowcook` (precedes the stale npm 0.21.1 at `/usr/bin`).
  Re-sync after any local change with the script in this repo's history, or:
  `rsync -az --delete --exclude node_modules --exclude .git <local>/ rewo:/root/slowcook-head/`
  then `pnpm install && pnpm build` on the box.
- **`/root/rewo` is on `origin/main`**, clean, mock builds.
- **Box-only work is safe**: `preserve/box-wip-2026-08-18` (`da14095`) pushed to
  `reworthy/app`. 8 commits + personas/admin/rewowner/visitor trees +
  five `data-*.ts`. **It does not build** (overlay `docPaths` removed between
  0.6.0 and 0.25.6) — deliberately NOT merged.
- **reworthy/app#214** open: `@types/node` so the mock compiles. Merge it before
  QA — `eye` grades against the mock, and a mock that cannot build grades nothing.
- **slowcook#416** open: overlay has no breaking-change path. Policy call, not fixed.
- **slowcook `check printHelp`** fixed locally (was missing `ratchet-protection`),
  uncommitted at handoff.

## Next actions, in order

1. Merge reworthy/app#214.
2. Add a PWA section to `docs/PRD.md` (unowned doc, hand-editable): installable
   manifest, offline shell, icon set, push-ready, wrappable for iOS/Android.
3. `slowcook menu --prd docs/PRD.md` on the box. **30 specs already exist** —
   menu must extend `specs/_index.yaml`, not duplicate. Check supersede chains.
4. File one issue per NEW story, label `needs-refinement`. Do not hand-write specs.
5. Phase 2: build the agent runner (model it on `/root/ovl-lock/qa/ask/lcr-watch.mjs`
   + systemd, which already works on this box).

## Standing decisions taken

- Unambiguous mechanical fixes: made directly. Policy calls: filed as issues.
- brew escalation is **haiku → sonnet → opus**; record which tier won per story.
- The box must never run npm slowcook again.

## The pattern worth carrying forward

Three of Phase 0's four findings were **silent staleness** — stale box CLI, a
mock that could not build, an overlay prop removed under a consumer. Nothing
failed loudly; each looked fine until something used it. Same family as the
dovizir stub and the discarded greens. If this run yields one structural
recommendation, it is likely that the harness should assert its own
preconditions out loud instead of assuming them.
