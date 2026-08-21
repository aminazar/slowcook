# Unattended operation — worker, taste, and gates

slowcook's pipeline commands (`refine`, `recipe`, `brew`) can be driven by
hand, one at a time. This page documents the layer that runs them **without
a human driving**: a worker that derives what to do from the state of your
repo, a reviewer agent with bounded authority, and a gate file that declares
which decisions stay human.

## The worker — `slowcook worker run`

The worker is a poll-driven loop (typically a systemd timer; `slowcook
worker systemd` prints ready-to-install units). Each pass it:

1. **Derives a workload** from artifacts, not from memory: trigger labels
   (`agent:refine`, …), merged specs with no tests PR (→ recipe), open
   agent PRs with no submitted review (→ taste), reviews newer than the
   PR's last commit (→ the author agent resubmits), specs + manifests with
   the `agent:reciped` label (→ brew). Labels only *publish* state — the
   workload is always re-derived from what actually exists.
2. **Checks preconditions out loud** — each job's preconditions are
   tri-state and name the upstream agent responsible when unmet.
3. **Runs one job per pass** (highest priority first: resubmits, then
   taste, then recipe, then brew), writing a trace tree per job under the
   logs directory.

```
slowcook worker run --enable refine,recipe,taste,brew \
  --job-timeout-mins 25 --cwd /path/to/repo --logs-dir /var/log/slowcook
```

`--dry-run` prints the derived workload and does nothing.

## Agent identity — `slowcook app init`

Agents should not post as a person. `slowcook app init` walks the GitHub
App-Manifest flow (one click in the browser): it creates a repo-scoped
GitHub App, saves the private key and the two env vars the worker needs,
and prints the installation URL. With the App configured, every comment,
PR, and merge is authored by `your-app[bot]` — and if the App is
configured but broken, the worker refuses to run rather than falling back
to a personal token.

## The reviewer agent — `slowcook taste`

```
slowcook taste --pr <n> [--merge]
```

`taste` reviews an agent-authored PR **against its full lineage**: the
source issue and its PM Q&A thread, the frozen spec, the PR's own
discussion thread (where rulings land during review rounds), and the
diff. It returns a structured verdict — `approve` or `request_changes`
with severity-tagged findings — posted as a review under the agent
identity, with changes-requested findings also posted as a timeline
comment so the author agent can consume them.

Authority is deliberately narrow and fail-closed:

- It merges **only** with `--merge`, only on approve, and only when the
  artifact's gate is declared `agent` (see gates below).
- An unparseable verdict exits non-zero and posts nothing — it never
  merges what it could not read.
- A blocking finding can never ride an approve.
- A merge failure leaves the review standing and cc's the PM.

The worker derives taste jobs automatically: any open agent PR without a
submitted review gets reviewed — the PR itself is the trigger.

### Review rounds

When taste requests changes, the worker routes the findings back to the
author agent (`refine --pr` for specs, `recipe --pr` for tests), which
amends the PR; taste then re-reviews. These rounds are bounded
(`MAX_REVIEW_ROUNDS = 4`); past the cap the PM is cc'd to arbitrate, so
two agents can never argue forever.

## Gates — `.brewing/gates.yaml`

Each artifact kind declares who closes its gate:

```yaml
gates:
  spec: agent    # taste may merge on approve
  tests: agent
  brew: human    # taste reviews and advises — the merge is the PM's
  vibe: human
  eye: human
```

`agent` means taste's approve may merge (when invoked with `--merge`).
`human` means agents still review and advise, but **the merge belongs to
a person** — `--merge` never overrides a human gate, and an approve at a
human gate cc's the PM so the handoff notifies them.

Defaults (no file, or an invalid value) are conservative: `spec` and
`tests` are agent-mergeable, everything else is human. A typo can only
make a gate *more* human, never less.

## Honesty mechanisms worth knowing about

These exist because unattended loops fail differently than humans do —
each was added after a real failure (the full record lives in
`docs/plans/rewo-run-gaps.md`):

- **Discovery gate**: amended tests that fail test discovery are reverted
  and the error is posted as PR feedback the next round *can see*; two
  consecutive failures stop the loop for a human.
- **Discovery hygiene**: manual `recipe` runs refuse to certify a tree
  with modified/untracked files under `src/` or `tests/` — residue can
  make a broken PR pass discovery. Worker workspaces are auto-cleaned
  each pass instead.
- **Fossil branches**: regenerating an artifact never reuses the branch
  of a merged round; an open PR routes to the resubmit path instead.
- **Fail-closed identity and pricing**: unknown model pricing, broken App
  credentials, or a dirty checkout stop the pass loudly rather than
  proceeding on assumptions.
