# @slowcook-ai/observe

Observability + live-debugging substrate for slowcook backends: request-scoped
tracing (AsyncLocalStorage), structured pino logs that auto-carry request/
QA-session ids, safe background tasks (`bg()`), runtime verbosity, build
identity, and breadcrumb+trace bundles an agent can diagnose from without a
repro. Framework-agnostic core + a Hono adapter. See
[docs/engineering/live-debugging.md](../../docs/engineering/live-debugging.md).
