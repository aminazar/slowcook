# Dev-env checkpoint — end of Phase 2

## What's delivered (Phase 1 + Phase 2)

### Phase 1 (delgoosh-only, PR delgoosh#632)

| File | What it does |
|---|---|
| `apps/patient/src/components/DevBanner.tsx` | Fixed yellow strip at the top of every page when `NEXT_PUBLIC_DEV_ENV=1`. Shows branch + commit + story baked in at build time. |
| `apps/patient/src/app/layout.tsx` | Wires `<DevBanner />` into the patient app's root layout. |
| `scripts/seed-dev-data.ts` | Idempotent seed: 5 patients, 3 therapists, ~30 `patient_tickets` across FREE/RESERVED/COMPLETED. Preserves PM-added rows. `--reset` wipes only seed-owned rows. |
| `.github/workflows/dev-deploy.yml` | Push to `dev` branch → SSH to delgoosh-box → rebuild + restart patient app with banner env vars → run seed. |
| `docs/dev-env-setup.md` | One-time SSH-key + Caddy + checkout bootstrap; daily-flow recipes. |

### Phase 2 (slowcook upstreaming, PR slowcook#TBD)

| File | What it does |
|---|---|
| `packages/cli/src/commands/dev-env/config.ts` | Zod schema for `.brewing/dev-env.yaml`. Declares apps + their mode (`dev`/`start`/`nest-watch`/`static`/`none`), ports, optional SSH target, persistence volumes, seed script. |
| `packages/cli/src/commands/dev-env/config.test.ts` | 9 tests — happy paths (minimal + full configs, every mode) + failures (missing file, malformed YAML, unknown mode, negative port, wrong schema_version, incomplete ssh_target). |
| `packages/cli/src/commands/dev-env/index.ts` | `slowcook dev-env <subcmd>` command. `push --story <id>` (load-bearing for Phase 3) + `switch --story <id>` fully implemented; `up`, `sync`, `reset` print canonical shell-outs for the consumer to wire (Phase 2.1 will fill in the SSH-driven runtime path). |
| `packages/cli/src/cli.ts` | Routes `slowcook dev-env ...` to the new command. |
| `packages/cli/package.json` | Cli version bumped 0.19.0-α.20 → α.21. |

## What's NOT yet delivered (deferred to Phase 2.1)

1. **Runtime subcommands** — `up`, `sync`, `reset` currently print the canonical shell command instead of executing it via SSH. The mechanics live in delgoosh's `dev-deploy.yml` workflow for now; Phase 2.1 generalises by having `slowcook dev-env up` SSH to the configured `ssh_target` and run the equivalent.
2. **Per-app mode dispatch.** The config schema accepts `mode: dev | start | nest-watch | static | none` but no subcommand consumes the mode yet — Phase 2.1 wires it into a per-app docker-compose snippet generator.
3. **DevBanner as a slowcook-shipped React module.** Phase 1 keeps the component local to `apps/patient/`. Phase 2.1 extracts it to `@slowcook-ai/dev-banner` so all consumers can `<DevBanner />` by import.
4. **`slowcook dev-env init`.** Scaffolds `.brewing/dev-env.yaml` from detected apps in the consumer's repo. Not implemented; consumers hand-author the file for now (see `apps/patient` shape in delgoosh's docs).

## How a consumer adopts this today (Phase 2 cut)

1. Author `.brewing/dev-env.yaml` (schema in `packages/cli/src/commands/dev-env/config.ts`):

   ```yaml
   schema_version: 1
   source_branch: dev
   seed_script: scripts/seed-dev-data.ts
   ssh_target:
     host: my-dev-box
     user: deploy
     checkout_dir: /opt/my-app-dev
     key_secret: MY_APP_DEV_SSH_KEY
   apps:
     web:
       mode: dev
       port: 3000
   ```

2. Build their own `dev-deploy.yml` workflow that pushes to `source_branch` triggers an SSH redeploy (delgoosh's `dev-deploy.yml` is the reference shape).

3. From any agent or local dev: `slowcook dev-env push --story <id>` force-pushes the current branch to `dev` → dev-deploy fires.

Phase 3 (next) wires this push into the brew + plate workflows automatically.

## Test coverage

- cli **809/809** tests passing (was 800; +9 for `dev-env/config.test.ts`).
- eval gate **2/2** fixtures green (untouched by this PR; no prompts changed).

## Open questions for Phase 3+

- Should `dev-env switch` also handle non-PR branches? (E.g., a hand-authored experimental branch with no open PR.)
- Per-app deploy targets: a story might only touch `patient`, no need to rebuild `therapist`/`admin`. Currently the deploy is all-or-nothing; Phase 2.1 could introduce `--only <app>`.
- Stop-other-running-agents semantics — does a `dev-env push` from brew cancel a previous push from plate, or queue? Concurrency policy needs a config knob.
