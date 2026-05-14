# Dev-env checkpoint — end of Phase 3

## What's delivered (cumulative — Phases 1, 2, 3)

| Phase | Land site | Deliverable |
|---|---|---|
| 1 | delgoosh#632 | DevBanner component + idempotent seed + dev-deploy.yml workflow + setup docs |
| 2 | slowcook#51  | `slowcook dev-env` command with `push`/`switch` fully wired, `up`/`sync`/`reset` stubs, zod config schema, 9 tests |
| 3 | slowcook#TBD (this PR) | The wire-up pattern + workflow snippet for `slowcook dev-env push` invocation from consumer brew workflows |

## Phase 3 — the wire-up pattern

The load-bearing operation for Phase 3 is `slowcook dev-env push --branch <PR-head-ref> --story <id>`. It force-pushes the PR's HEAD to the `source_branch` configured in `.brewing/dev-env.yaml` (default: `dev`), which triggers the consumer's `dev-deploy.yml` workflow on that branch.

Adding auto-preview to a consumer-maintained brew workflow is a 6-line addition. Drop this step at the END of `slowcook-brew.yml` (after the agent commits + pushes, before the workflow exits):

```yaml
      - name: Auto-preview this PR on the dev URL
        if: hashFiles('.brewing/dev-env.yaml') != ''
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          STORY="${{ inputs.story }}"   # passed by slowcook-brew-auto dispatch
          BRANCH=$(git rev-parse --abbrev-ref HEAD)
          npx --yes "$SLOWCOOK_CLI" dev-env push --branch "$BRANCH" --story "$STORY"
```

What this does:
- `hashFiles('.brewing/dev-env.yaml') != ''` gates on config presence — no `dev-env.yaml` → no auto-preview (silent no-op, so the brew workflow stays usable in repos that don't use dev-env).
- After brew has done its work and committed/pushed the implementation, the step force-pushes that same branch to `dev` on origin.
- The consumer's separate `dev-deploy.yml` workflow fires on the `dev` branch push and refreshes the dev URL.

Reviewers open the brew PR → see new code AND see it running on the shared dev URL (banner shows `story-<id>`).

## Plate workflow — when to auto-preview, when not

Plate amends the SPEC PR's branch, not a runnable app branch. The spec PR contains spec YAML + mock fixtures only — nothing the dev URL can render. **Do not** wire auto-preview into plate.

Exception: if a future plate-like agent edits the mockup PR (vibe's output, which IS runnable as a mock), that one should auto-preview. Phase 4+ work — out of scope here.

## What's NOT yet delivered (deferred follow-ups)

These are the items the original Phase 3 ask implied but require live consumer brew workflows to land cleanly:

1. **A reference brew workflow** shipped via `slowcook init` that includes the auto-preview step. The current `forge-github/templates.ts` doesn't ship `slowcook-brew.yml` — it's consumer-maintained. A "starter brew workflow template" with the wire-up would let new consumers adopt auto-preview without writing the YAML themselves.
2. **`slowcook dev-env init`** scaffolder — generates `.brewing/dev-env.yaml` from detected apps + writes the matching `dev-deploy.yml` workflow. Manual today.
3. **Runtime subcommands** (`up`/`sync`/`reset` SSH-executed) — Phase 2.1.
4. **DevBanner as a slowcook package** — `@slowcook-ai/dev-banner` exporting `<DevBanner />`. Phase 2.1.
5. **Mockup PR auto-preview** — vibe + plate on the mockup PR could auto-preview (currently only the legacy mock-runtime PRs get preview deploys via the separate `slowcook-preview-deploy.yml`).

## Honest scope reality

Phase 3 ships **smaller than originally outlined**. The original Phase 3 ask was "wire into brew/plate workflows automatically" — but the brew workflow is consumer-maintained and doesn't exist in delgoosh yet, so there's no live workflow to edit. The deliverable here is the wire-up PATTERN as a documented snippet plus the supporting infrastructure (Phases 1 + 2) that makes the pattern trivial to drop in.

Once delgoosh (or any other consumer) authors their `slowcook-brew.yml`, copying the 6-line snippet above completes Phase 3 for that consumer. That's a 2-minute task for the consumer, not a slowcook-side change.

## Test coverage at end of Phase 3

- cli **809/809** tests passing (unchanged from Phase 2 — no new code in this PR, docs only).
- eval gate **2/2** fixtures green.

## Final state of the dev-env arc

Functioning today (after merging PRs delgoosh#632, slowcook#51, and this one):

- **PMs**: get a stable dev URL with a banner showing exactly what's deployed. Push to `dev` directly to refresh, or use `slowcook dev-env switch --story <id>` to swap branches.
- **Agents**: invoke `slowcook dev-env push --branch <pr-head> --story <id>` at the end of their workflow to auto-preview the PR they just opened. 6-line addition to the consumer's brew workflow.
- **Reviewers**: open a brew PR → see code AND see it running on the shared dev URL with the correct story banner. Click around. Find issues. Comment on the PR.
- **Operators (you)**: one yaml file (`.brewing/dev-env.yaml`), one workflow file (`dev-deploy.yml`), one Caddy snippet. Everything else is slowcook-shipped.

What's still on you for full adoption:
1. Add the 3 secrets in delgoosh (`DELGOOSH_DEV_SSH_KEY`, host, user).
2. Bootstrap `/opt/delgoosh-dev` on the box.
3. Caddy subdomains.
4. When delgoosh's brew workflow lands, paste the 6-line wire-up.
