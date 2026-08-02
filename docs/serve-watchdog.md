# serve watchdog — dev servers that are up but not serving

Field origin: the delgoosh blank-portal incident (2026-08-02). A large sync
burst floods a vite dev server with HMR updates; vite restarts itself
mid-flood; afterwards the server answers `/` (static index.html) with 200
while **every module request** hangs past the reverse proxy's timeout → 504.
`docker ps` reports healthy the whole time; the product renders a blank root.

Two consequences drive the design:

1. **Detection must probe the transform pipeline.** Any healthcheck on `/`
   is structurally blind to this state. The probe path must force
   resolve → transform → serve — for vite, the entry module:

   ```yaml
   # .brewing/serve.yaml
   profiles:
     dev:
       apps:
         web:
           mode: vite-dev
           port: 3010
           probe_path: /src/main.tsx          # transform pipeline, not "/"
           recover_clear:
             - apps/web/node_modules/.vite    # the pre-bundle cache
   ```

2. **Recovery is clear-cache + restart, twice.** A plain restart after a
   wedge has come back wedged: the first boot re-optimizes deps against a
   browser-poisoned module graph. The second boot from a clean cache is the
   state that stays healthy. (`recover_restarts: 2` is the default; tune
   down for apps where one restart suffices.)

## Running it

```bash
slowcook serve dev watchdog        # resident loop — run under systemd/pm2 on the box
slowcook serve dev watchdog-once   # one probe round; exit != 0 iff something is wedged
```

The resident loop probes every `probe_interval_s` (default 30s), tolerates
`probe_strikes - 1` consecutive failures (default threshold 2 — one blip
never restarts anything), and after a recovery leaves the app alone for
`recover_cooldown_s` (default 300s) so a genuinely broken build cannot
restart-loop.

Suggested systemd unit on the box:

```ini
[Unit]
Description=slowcook serve watchdog
After=docker.service

[Service]
ExecStart=/usr/bin/env slowcook serve dev watchdog
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

## Making the storm smaller in the first place (vite recipe)

The watchdog is the backstop; these vite config settings shrink the storm
that causes the wedge (all verified in the delgoosh field deployment):

```ts
// vite.config.ts
server: {
  watch: {
    // test files are not in the dev module graph, yet each one triggered a
    // full page reload during the incident's storm
    ignored: ['**/*.test.*'],
    // coalesce an rsync burst into few HMR events instead of one per write
    awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
  },
},
optimizeDeps: {
  // don't hold every request until the crawl ends after a restart — behind
  // a proxy timeout that hold is exactly what turns into mass 504s
  holdUntilCrawlEnd: false,
},
```

One thing no config can prevent: a change to `vite.config.ts`, `.env*`,
`package.json` or the lockfile **forces** a vite self-restart by design.
Dependency bumps will keep doing it — the watchdog exists for exactly the
case where that restart comes back wedged.
