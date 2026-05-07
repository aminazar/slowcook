# Reporting a slowcook bug

Slowcook runs across several agents (refine / vibe / plate / testgen /
brew / chef / recon) and several surfaces (issues, PRs, workflow logs,
artifacts). When something goes wrong, the maintainer needs the full
reproduction context — but **we deliberately don't accept artifact
uploads or "report bundles."** Real-data fragments (database rows,
user emails, draft spec text) often live inside slowcook prompts; a
bundler is hard to verify against secret leakage. Instead we lean on
GitHub-native surfaces that you control.

> **Forge support today: GitHub only.** Slowcook's `forge` adapter
> currently has one implementation: `@slowcook-ai/forge-github`. GitLab,
> Bitbucket, etc. are architecturally possible (the core defines a
> `ForgeAdapter` interface) but no other adapter is published. If your
> consumer repo lives on GitLab, slowcook won't run today.

This doc covers how to file a bug for both **public OSS repos** and
**private repos** (both on GitHub).

---

## OSS / public repos (default path)

If your repo is public + Actions logs are public (the default),
**share four URLs** in a slowcook GitHub issue:

1. **Source-issue URL** — the issue that started the story (e.g.,
   `https://github.com/<you>/<repo>/issues/149`). This carries the
   full refine Q&A trail + every agent's `slowcook:cost` markers
   for the story.
2. **PR URL(s)** — whichever slowcook-bot PRs are involved
   (`/spec/`, `/mockup/`, `/tests/`, `/brew/`).
3. **Workflow run URL** — the specific failed run (e.g.,
   `https://github.com/<you>/<repo>/actions/runs/25381565696`).
   Logs are public; artifacts (`.brewing/chef/`, `.brewing/chef-drift-input/`,
   etc.) are downloadable.
4. **What you expected vs. what happened** — one-paragraph summary.

That's it. Maintainer reads the workflow log + downloads artifacts
without needing any access from you.

### Reproducing locally

You can reproduce the exact LLM input chef-drift saw by:

```bash
# 1. Download the chef-drift artifact from the failing run
gh run download <run-id> -n chef-drift-story-<id> -D /tmp/chef-drift-repro

# 2. Re-dispatch chef-drift locally with the captured input
cd <your-repo>
ANTHROPIC_API_KEY=... slowcook chef-drift \
  --story <id> \
  --trigger brew_halt_class \
  --trigger-detail "..." \
  --trigger-raw /tmp/chef-drift-repro/halt-trigger.json \
  --dry-run
```

Same input → same prompt → reproducible LLM output (modulo
inherent stochasticity, which Anthropic's `temperature=0` minimises).

---

## Private repos

If your repo is private, neither logs nor artifacts are visible to
the slowcook maintainer. Two options:

### Preferred: read-only triage role for the duration of the bug

In your GitHub repo settings → Collaborators → add **`@aminazar`**
(slowcook's maintainer today; check the [repo](https://github.com/aminazar/slowcook)
for the current owner) as a **Triage** role. That gives them:

- Read access to source, PRs, issues, workflow logs, artifacts
- No ability to push, merge, change settings, or run actions

When the bug is resolved (or after a fixed window — 7 days is a
reasonable default), revoke. @aminazar doesn't expect indefinite
access.

### Fallback: scoped read-only PAT

If you'd rather not add a collaborator, generate a fine-grained
Personal Access Token with **read-only** scope on **just that one
repo** + only the permissions slowcook needs:

- `Contents: Read`
- `Issues: Read`
- `Pull requests: Read`
- `Actions: Read`

Share via 1Password or a similar trusted channel. Maintainer uses it
for the bug investigation only + revokes when done.

---

## What slowcook does NOT accept

- **Artifact uploads / log bundles via email or chat.** Real-data
  fragments live inside agent prompts (a brew agent's prompt
  includes test fixture rows that may have realistic-looking user
  emails; a refine agent's prompt includes the spec body). A
  bundler can't verifiably scrub these. We won't accept the risk.
- **Auto-telemetry.** No slowcook command phones home or sends usage
  data to the maintainer. Cost / activity is visible to YOU via the
  `slowcook:cost` markers on your own GitHub issues + PRs;
  aggregating it for someone else is your call, not ours.
- **Direct API key sharing.** If a bug needs the maintainer to
  re-run an agent live (rare), they can run it under their own
  ANTHROPIC_API_KEY — never yours.

---

## Cost-marker recipe (handy for bug reports)

Every agent in the slowcook pipeline emits an HTML cost marker on
its comments. To see what your story cost / which agent did what:

```bash
gh issue view <issue-num> --comments | grep "slowcook:cost"
```

Output looks like:

```
<!-- slowcook:cost agent=refine usd=0.4630 round=questions ... -->
<!-- slowcook:cost agent=refine usd=0.6514 round=spec ... -->
<!-- slowcook:cost agent=testgen usd=0.6134 ... -->
<!-- slowcook:cost agent=brew usd=0.6291 iterations=3 halted=AGENT_STALLED_NO_EDITS ... -->
<!-- slowcook:cost agent=chef-drift usd=0.0123 decision=halt move=1 ... -->
<!-- slowcook:cost agent=chef-orchestrate usd=0.0123 kind=close pr=153 ... -->
```

When filing a bug, you can paste the relevant markers directly into
the issue — they're machine-readable + identify the involved agent
without any custom bundling.

---

## Where to file

- **Public bug reports**: <https://github.com/aminazar/slowcook/issues>.
  The bug-report issue template (auto-applied when you click "New issue")
  asks for the four URLs the maintainer needs.
- **Private bug reports** (when artifacts can't be public): same repo,
  **but file a public issue** with the description + your reproduction
  arrangement. Don't paste private logs into a public issue. The
  maintainer responds with the access path that works for your setup.

---

## What you'll see when a fix ships

When the maintainer ships a fix in a new alpha (e.g., `cli@0.19.0-alpha.X`),
expect a comment on your bug issue along these lines:

> Fixed in `cli@0.19.0-alpha.X`. Bump your `.brewing/slowcook-cli-version`
> and re-run. Close this issue if resolved; comment if not.
>
> `<!-- slowcook:fix-notice cli=0.19.0-alpha.X issue=N -->`

The issue stays **open** until you confirm the fix worked. You close it.
That gives the maintainer signal that the fix actually landed in your
context — not just in slowcook's own test suite.

If the fix didn't work, comment on the issue with what's still broken.
The maintainer reopens (if you closed) or continues debugging.

## Triage labels

The slowcook repo uses a small label set so you can filter for what's
actionable:

| Label | Meaning |
|---|---|
| `bug` | Confirmed bug. Auto-applied by the issue template. |
| `needs-info` | Maintainer needs more context (additional URL, runner output, etc.). |
| `confirmed` | Maintainer reproduced; working on a fix. |
| `regression-test-pending` | Fix landed but the regression test is still TODO. |
| `fixed-in-α.X` | Fix shipped in `cli@0.19.0-alpha.X`. Reporter to confirm + close. |
| `blocked-on-anthropic` | Bug is in the Anthropic API / SDK, not slowcook. |
| `wont-fix` | Out of scope or incompatible with architectural intent. |

Filter via GitHub's issue search, e.g.:
`gh issue list --repo aminazar/slowcook --label "fixed-in-α.13"`

---

*This doc is intentionally short. Read [AGENTS.md](./AGENTS.md) for
the slowcook architecture overview.*
