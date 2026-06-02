# Pattern: non-destructive parallel port

> Surfaced from delgoosh dogfood, 2026-06-02 (epic #759). Captures
> the convention that emerged for "rewrite this app in a different
> framework alongside the existing one so PMs can compare and we can
> cherry-pick during cut-over."

## When to use

A PM asks: *migrate app X to framework Y, keep app X running for
side-by-side comparison.*

The naive read is "replace `apps/X/` with the new code." That's
destructive — you lose the comparison surface and PRs become massive
"rewrite everything" diffs that can't be reviewed incrementally.

The non-destructive parallel port keeps the existing app intact and
creates a new sibling.

## Convention

### Directory naming

| What you have | What you create | Why |
|---|---|---|
| `apps/X/` (current) | `apps/X-v2/` OR `apps/X-spa/` OR `apps/X-vite/` | Suffix indicates intent (versioned bump, technology, framework); leaves room for the eventual rename when the new one supersedes the old |
| ditto, integrated multi-role variant | `apps/Y/` where Y describes the role grouping (e.g. `apps/spa-patient` + `apps/spa-therapist`) | Lets you split or merge the routing model from the old shape |

### Port allocation

The new app(s) MUST listen on distinct host ports from the originals
so both run side-by-side. Reserve a range explicitly:

```
3001  apps/patient            (existing)
3002  apps/therapist          (existing)
3006  apps/spa-patient        (new)
3007  apps/spa-therapist      (new)
```

Document the table in a comment in the relevant `docker-compose.*.yml`
or `.brewing/serve.yaml`.

### Shared code

If the new apps share infrastructure (auth, design system, primitives),
prefer **pre-build sharing via path alias** over a workspace package
unless you need an enforced API boundary:

```yaml
# Each new app's vite.config.ts:
resolve:
  alias:
    '@shared': path.resolve(__dirname, '../../packages/shared-spa/src')
```

The shared dir is a plain code directory — no `package.json`, no
`workspace:*` deps. This avoids `pnpm install` churn and keeps the
mental model "files my app can import."

See `docs/patterns/pre-build-code-sharing.md` for the full rationale.

### What stays + what goes

- **Existing app code** — STAYS untouched. Don't even tidy it up
  during the migration; that confuses the diff.
- **Existing app's container + port** — STAYS in `docker-compose.production.yml`.
  The new app gets its own entry alongside.
- **CI** — both apps build; CI failures on either gate the PR.
- **README** — add a short note pointing at the parallel app + its
  reference issue so future contributors don't accidentally start work
  on the deprecated one.

### When to remove the old app

After the new app reaches feature parity AND has been in production
behind a feature flag or domain split for at least one release cycle.
A separate "remove `apps/X/`" PR closes the migration; don't combine
removal with the last visual-parity PR.

## brew prompt addendum

When refine emits a spec with `migration: parallel_port` set in the
manifest, brew should:

1. Refuse to modify the source app's files (`apps/X/**` is frozen for
   the duration of the migration story).
2. Default the new app's dir name to `apps/<source>-<framework>`
   unless the spec overrides.
3. Reserve a new port and document it in compose + serve.yaml.
4. Add a README entry to the new app's directory linking back to the
   source app + the epic issue.

## Open questions

- How long should the parallel state persist before the source app is
  removed? PM-decided; not a slowcook concern.
- What if the source app gets a bug fix during the migration? The fix
  also lands on the new app via cherry-pick — convention to be
  formalised as a separate doc.
