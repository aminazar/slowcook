# Live backend debugging — practice for the slowcook stack {#live-debugging}

*Researched 2026-07-09 against the real stack (dash as consumer #1) and this
week's actual incident log. The stack: Node/TypeScript via `tsx` under
systemd, Postgres in Docker, Cloudflare in front (100 s edge timeout), LLM via
the `claude` CLI subprocess, deploys by rsync + restart. No APM, logging =
`console.*` → journald.*

## The incidents that motivate this (evidence, not hypotheticals)

| Incident | Why it was hard to debug |
|---|---|
| LCR responder failed silently | fire-and-forget `void (async …)` with a bare `console.error` — found only by ssh + journalctl grep |
| Cloudflare 524 on digs/mock-gen/curates | the edge lies: the server keeps working, the client sees failure; no job state to query |
| "unreproducible 200" on a pending-hat probe | deploy-window ambiguity — no way to ask the server *which build* answered |
| garnish test gate failed | env drift (npx-cached vitest without jsdom), not a code fault |
| dash_mock down | long-lived vite dev process with a stale resolve cache — restart fixed it, logs said "resolve error" without saying *since when* |

The pattern: we debug by **ssh + grep + psql + curl probes** — workable for one
operator, opaque for two, impossible for a team.

## The design scenario: a QA-pill bug report the agent can actually diagnose

The loop we're building for: **a QA reviewer on a QA/staging deployment (built
code, not dev mode) hits a bug and reports it live through the QA pill. The
investigate agent must diagnose — today it would guess.** Two capabilities, in
order of preference:

### A. Observe the FIRST occurrence (no repro needed)

The report should carry the backend truth of what already happened:

1. **QA-session correlation.** The pill's timed session already has an id and
   bounds. The pill injects `X-QA-Session: <id>` (and keeps `X-Request-Id`
   responses) on every app fetch during the session. Backend logs carry both
   ids. "Everything that happened in that session" becomes ONE query over
   journald — after the fact.
2. **Client breadcrumbs in the report.** The pill keeps a small ring buffer —
   last ~50 API calls (method, path, status, request-id, ms), console errors,
   route changes — and attaches it to the LCR issue automatically. The
   investigate agent joins breadcrumbs → request ids → server log slices and
   reconstructs the incident without asking the human anything. This is the
   Sentry/Session-Replay pattern rebuilt custody-free (nothing leaves our
   infra; it rides the issue the founder already owns).
3. **Server-side request traces.** Request-id middleware + AsyncLocalStorage
   context so every log line, DB query timing, upstream call and error within
   a request shares the id. On ERROR (or when `X-QA-Session` is present),
   persist the request's event buffer — a `request_trace` row — so the agent
   reads a structured timeline, not grep output.

### B. Instrument live and ask for ONE repro (fallback)

When the first-occurrence record isn't enough:

4. **Agent-driven logpoints via the inspector protocol.** The sanctioned
   inspector (localhost-only + SSH tunnel / runner verb) isn't just for
   humans: CDP (`Debugger.setBreakpoint` with a log expression) sets
   NON-BREAKING logpoints on built code (source maps resolve TS) — the
   investigate agent plants them at suspect lines, asks QA to repeat once,
   collects values, removes them. Rookout-style live debugging, self-hosted,
   zero third parties.
5. **Dynamic verbosity per session.** Pino level is mutable at runtime: the
   agent flips the QA session (or one route) to debug-level via an
   owner-gated endpoint, QA repeats, verbosity reverts. Cheapest repro path —
   no process restart, works on built code.

Both A and B assume the Tier-1 basics below; A is why they're not optional.

## Tier 1 — adopt now (near-zero cost, no new infra)

1. **Structured logs: pino + request IDs.** JSON lines through the existing
   journald pipe (no new infra; `journalctl -u dash-server -o cat | jq` becomes
   a query language). One request-id middleware (Hono has one); the id goes in
   every log line **and back to the client as `X-Request-Id`** — a founder bug
   report then carries the exact needle. Pino, not Winston: worker-thread
   transports, ~7× faster, the 2026 default.
2. **A `bg()` wrapper for fire-and-forget work.** Every `void (async …)` gets
   `bg("lcr-responder", ctx, fn)`: failures log structured with their context
   and a counter — silent-failure class deleted in one helper.
3. **`GET /api/debug/build`** → `{ sha, built_at, started_at }`. Kills
   deploy-window ambiguity forever: every probe can confirm *which code*
   answered. (The deploy script stamps the sha.)
4. **Sanctioned live inspector, tunnel-only.** When logs aren't enough:
   systemd drop-in adds `NODE_OPTIONS=--inspect=127.0.0.1:9229`, restart,
   `ssh -L 9229:localhost:9229 <box>`, attach VS Code/Chrome DevTools —
   breakpoints on live prod code. **Never** `--inspect=0.0.0.0` (unauthenticated
   RCE); never leave the flag on after the session. `tsx` passes the flag
   through and serves source maps, so TS frames resolve.
5. **Global safety nets**: `unhandledRejection`/`uncaughtException` handlers
   that log structured (with request id when known) before exiting — the most
   common Node prod failure is an unhandled rejection nobody saw.

## Tier 2 — next (small infra, custody-compatible)

6. **Self-hosted GlitchTip** for error aggregation. Sentry-SDK-compatible,
   runs in ~512 MB–2 GB (fits the existing box), and — decisive for slowcook's
   custody philosophy — founders' error payloads (which can embed doc excerpts
   and prompts) never leave our infrastructure. Sentry-SaaS is ruled out on
   custody grounds (and its 2024 train-on-customer-errors episode); full
   self-hosted Sentry (ClickHouse et al.) is overkill below ~millions of
   events/month.
7. **The async-job pattern** (the standing 524 debt) *is* an observability
   fix: a `job` row per long operation (dig, mock-gen, curate) with
   status/started/finished/error + the request id. The client polls; the
   operator queries. One table replaces four flavors of "the edge timed out,
   did it work?".
8. **OpenTelemetry traces — when there are two services.** The 2026-mature
   pattern is pino + `pino-opentelemetry-transport` so every log line carries
   `traceId` automatically. Adopt when dash's flows genuinely span services
   (dash ↔ consumer CI ↔ claude-cli); premature for a single process where
   request-id correlation already answers "what happened".

## Explicitly rejected

- **SaaS APM / SaaS live-debuggers** (Datadog, Rookout-style set-a-breakpoint
  services): they ship founders' request payloads to third parties — a custody
  violation, not a tooling preference.
- **`--inspect` exposed beyond localhost** — a shell for anyone who can reach
  the port.
- **Winston/console.log continuation** — unqueryable at exactly the moment
  queries matter.

## Build order for the QA-pill loop

Ship with the QA pill itself (they're one feature): request-id + pino +
`bg()` + `/api/debug/build` (Tier 1) → session header + client breadcrumbs in
the pill → `request_trace` on error/QA-session → investigate-agent tooling
(journald slice queries + CDP logpoints via the runner). GlitchTip and OTel
slot in later without redesign because everything is keyed by the same ids.

## slowcook OSS angle

dash is consumer #1, but every brewed backend inherits the same needs. Roadmap
candidates: `slowcook init server` scaffolds pino + request-id + `bg()` +
`/api/debug/build` by default, and the brew agents' prompts treat "structured
log with request id" the way they now treat the styling contract — a
convention checked, not hoped for.

## Sources

- [Node.js best practices (goldbergyoni, July 2026)](https://github.com/goldbergyoni/nodebestpractices)
- [Debugging JavaScript in production — practical guide](https://debugg.ai/resources/debugging-javascript-in-production-practical-guide)
- [Node.js logging best practices (Better Stack)](https://betterstack.com/community/guides/logging/nodejs-logging-best-practices/)
- [Structured logging with Pino 9 + OTel (2026 guide)](https://1xapi.com/blog/structured-logging-nodejs-pino-opentelemetry-2026)
- [Pino logger guide (Dash0)](https://www.dash0.com/guides/logging-in-node-js-with-pino)
- [Self-host Sentry or GlitchTip (2026)](https://danubedata.ro/blog/self-host-sentry-glitchtip-error-tracking-2026)
- [GlitchTip vs Exceptionless vs Sentry (2026)](https://www.pistack.xyz/posts/2026-04-23-glitchtip-vs-exceptionless-vs-sentry-self-hosted-error-tracking-2026/)
- [GlitchTip](https://glitchtip.com/)
- [Node.js debugging docs](https://nodejs.org/learn/getting-started/debugging)
- [How a single flag gives attackers a shell (--inspect risk)](https://medium.com/@anantjoshi_62684/the-ghost-in-the-machine-how-a-single-flag-can-give-attackers-a-shell-on-your-node-js-server-dfe9a6155387)
- [Remote debugging with SSH tunnels (Render)](https://render.com/blog/ssh-vscode-remote-debugging)
