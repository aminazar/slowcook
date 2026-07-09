// Safe fire-and-forget. Every `void (async () => …)()` in a request handler is
// a silent-failure trap: an error there vanishes with a bare console.error and
// no context. bg() runs the task detached but captures failures WITH the
// spawning request's context (ids carried across the async boundary), logs
// them structured, and counts them — so "the responder fired but nothing
// happened" is never invisible again.
import { currentContext, runInContext } from "./context.js";
import { log } from "./logger.js";

let failures = 0;
export function bgFailureCount(): number { return failures; }

export function bg(label: string, fn: () => Promise<void>): void {
  const ctx = currentContext();
  const run = () =>
    Promise.resolve()
      .then(fn)
      .catch((err) => {
        failures++;
        log.error(`bg task failed: ${label}`, { label, err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
      });
  // preserve the request context inside the background task when present.
  if (ctx) void runInContext(ctx, run);
  else void run();
}
