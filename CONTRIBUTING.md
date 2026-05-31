# Contributing to slowcook

Slowcook is pre-1.0; the architecture itself iterates in public. PRs
welcome — but read this first to align on conventions that have paid
back empirically across the consumer dogfood.

## Reporting a bug

See [REPORTING.md](./REPORTING.md). Don't bundle artifacts; share
URLs. The bug-report issue template enforces the minimum context
maintainer needs.

## Bug-fix PRs: regression test required

Every bug-fix PR **must** add at least one test that locks the fix
in. Pattern:

- The test lives in the agent module's existing `*.test.ts` (e.g.,
  `packages/cli/src/commands/chef/drift-fix.test.ts`).
- It exercises a pure helper when possible. If the helper doesn't
  exist yet, extract one from the bug site rather than testing the
  full LLM-bound execution path.
- The test name names the bug shape: e.g., `it("doesn't blow up when
  the trigger detail uses a relative path with no leading slash")`.

If the bug shape can only be reproduced via a real pipeline run
(not a unit test), add a fixture under `packages/cli/eval/fixtures/`
once the eval-harness ships (TBD; deferred until the first such bug
warrants it).

## Pull request shape

- One concern per PR. Bundling unrelated fixes makes review hard +
  bisection impossible.
- Title: `<scope>: <short summary>` — e.g., `chef-drift: handle TS
  path aliases beyond @/`.
- Body: explain the WHY (what was broken, what's the user-visible
  consequence). The diff explains WHAT.
- Link the issue: `Closes #<n>`.

## Versioning

- Pre-1.0 + active development. Breaking changes are expected
  between alpha versions.
- Bump scheme: `0.X.Y-alpha.N` for alpha cuts; `0.X.0` for stable
  cuts.
- Always `pnpm publish --tag alpha --no-git-checks` (npm leaves
  `workspace:^` unresolved → consumers hit `EUNSUPPORTEDPROTOCOL`).
- `prepublishOnly: tsc -b` is wired; verify `dist/` is fresh after
  any package.json bump before publishing.
- **After every publish run, run `scripts/smoke-install.sh
  --since-publish`** in a clean shell. It spins up a temp dir per
  workspace package and `npm install`s the just-published version.
  Catches the slowcook#23 class of bug: workspace `package.json`
  bumps that are committed but never `pnpm publish`-ed, leaving cli
  releases with unresolvable transitive deps. The same script also
  runs in CI on push-to-main + nightly via
  `.github/workflows/smoke-install.yml`.

## Drafting a release CHANGELOG entry

When cutting a release, run the changelog draft generator and paste the output into both the new CHANGELOG.md section and the release PR body:

```bash
scripts/changelog-draft.sh --since <last-release-sha> --next-version 0.19.3
```

The script walks merged PRs between two refs (default: last git tag → HEAD), groups them by conventional-commit type (`feat` / `fix` / `docs` / etc.), and emits a scaffolded markdown section. You then flesh out the WHY-prose per the existing CHANGELOG style — the script handles the boilerplate (PR list + grouping).

Smoke test: `bash scripts/changelog-draft.test.sh` (asserts against this repo's own 0.19.1 → 0.19.2 range).

## After a fix lands

When a fix ships in `cli@0.19.0-alpha.X`:

1. Add a CHANGELOG entry referencing the closed issue.
2. Comment on the bug issue (template below):

   ```
   Fixed in `cli@0.19.0-alpha.X`. Bump your `.brewing/slowcook-cli-version`
   and re-run. Close this issue if resolved; comment if not.

   <!-- slowcook:fix-notice cli=0.19.0-alpha.X issue=<n> -->
   ```

3. Apply the `fixed-in-α.X` label to the issue (replace `X` with the
   alpha number).
4. Leave the issue OPEN until the reporter confirms. They close.

## Code conventions

- TypeScript strict mode. No `any` unless interfacing with an
  untyped npm dep — and even then, narrow at the boundary.
- Pure helpers when possible. The bug-fix-test pattern relies on
  this: extract from the bug site rather than mock the world.
- One emoji per file maximum, and only when the user is the
  audience (e.g., a cli stdout banner). Code comments stay plain.
- Small commits, frequent pushes. Long-lived branches drift.
- **Cost markers in PM-facing comments.** Any new agent that posts
  comments on GitHub issues / PRs MUST emit a `<!-- slowcook:cost … -->`
  marker. See [`docs/cost-marker-format.md`](./docs/cost-marker-format.md)
  for the wire format + example emissions. The cost-aggregator pipeline
  walks these markers to produce the per-story rollup.

## Prompt-regression fixtures (eval gate)

PRs that touch `packages/llm-anthropic/src/prompts/**` run through
the eval gate (`.github/workflows/eval-gate.yml`). The gate replays
each fixture's prompt builder + asserts substring contracts —
catches the regression class where a prompt edit silently drops
critical context.

Fixture format: `packages/cli/eval/fixtures/<id>/fixture.json`

```json
{
  "id": "kebab-case-slug",
  "agent": "chef-orchestrate",
  "description": "What this fixture asserts and why.",
  "captured_from": {
    "pr": 153,
    "date": "2026-05-07",
    "context": "Short note on the real-world halt this models."
  },
  "input": { /* the exact args passed to build<Agent>Prompt */ },
  "expected_prompt_includes": [
    "story-153",
    "Chef-drift ledger"
  ],
  "expected_prompt_excludes": [
    "TODO",
    "FIXME"
  ]
}
```

Supported agents (the `agent` field): `chef`, `chef-orchestrate`,
`investigate`, `navigator`, `plate`, `sift`, `vibe`. See
`packages/cli/src/commands/eval/index.ts` for the builder map.

Running locally:

```bash
slowcook eval --list
slowcook eval --all
slowcook eval --fixture chef-orchestrate-close-on-incomplete-halt
```

Add a fixture when:

- A real consumer halt would have been caught by a prompt-shape
  assertion (e.g., the chef-drift path-alias miss, the typed-entity
  falsification).
- A prompt PR refactors context — capture the pre-refactor includes
  as a regression baseline before merging.

Author the fixture's `input` blob from the matching agent's
TypeScript args interface (`packages/llm-anthropic/src/prompts/*.ts`).
Run `slowcook eval --fixture <id>` locally; iterate the asserts until
they capture the contract you care about.

## Workflows + CI

- Self-hosted runners need `gh` CLI. Slowcook's chef-drift workflow
  installs it via the no-sudo binary; mirror this in any new
  workflow.
- Workflows that mutate the consumer's GitHub state must respect
  `SLOWCOOK_READ_ONLY=1` if running in maintainer-replay mode (see
  `slowcook docs read-only`).
- Test against real consumer data when possible. The dogfood loop is
  what turns architecture into something that works.

## License

MIT — see [LICENSE](./LICENSE).
