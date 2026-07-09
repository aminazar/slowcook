// @slowcook-ai/observe — observability + live-debugging substrate for slowcook
// backends. Request-scoped tracing (AsyncLocalStorage), structured pino logs
// that auto-carry request/QA-session ids, safe background tasks, runtime
// verbosity control, build identity, and breadcrumb+trace bundles an agent can
// diagnose from without a repro. Framework-agnostic core + a Hono adapter.
export { runInContext, currentContext, trace, type RequestContext, type TraceEvent } from "./context.js";
export { log, setLogLevel, getLogLevel, _setBaseLogger } from "./logger.js";
export { bg, bgFailureCount } from "./bg.js";
export { requestContext, type CompletedTrace, type RequestIdOptions } from "./hono.js";
export { buildInfo, type BuildInfo } from "./build-info.js";
