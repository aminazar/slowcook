/**
 * `slowcook recall <query>` — 0.28 — recall prior agent work before a task.
 *
 * Wraps the ctxrs/ctx CLI (Apache-2.0): searches local coding-agent session
 * histories and emits a compact "prior context" brief. The point is to stop
 * slowcook's brew/chef/refine agents from starting context-blind and burning
 * tokens re-deriving what a past session already settled.
 *
 *   slowcook recall "wallet flag DCE bug"        # by topic
 *   slowcook recall --file server/src/http.ts    # sessions that touched a file
 *   slowcook recall "brand board" --json         # structured (for loop injection)
 *
 * Best-effort: if ctx isn't installed, prints how to get it and exits 0 — recall
 * must never block a loop. Other commands import { recallBrief, ctxSearch } to
 * prepend the brief to an agent prompt (the loop-memory seam).
 */
import { ctxAvailable, ctxSearch, ctxSetup, type CtxSearchOpts } from "./ctx.js";
import { recallBrief } from "./brief.js";

const INSTALL_HINT =
  "ctx (the session-history index recall uses) isn't installed.\n" +
  "Install it (Apache-2.0): curl -fsSL https://ctx.rs/install | sh — or grab the\n" +
  "checksum-verified binary from https://github.com/ctxrs/ctx/releases. Then `ctx setup`.";

export async function recall(argv: string[], _version: string): Promise<void> {
  const opts: CtxSearchOpts = {};
  const terms: string[] = [];
  let json = false, setup = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--file") opts.file = argv[++i];
    else if (a === "--limit") opts.limit = Number(argv[++i]);
    else if (a === "--since") opts.since = argv[++i];
    else if (a === "--workspace") opts.workspace = argv[++i];
    else if (a === "--all-sessions") opts.includeCurrentSession = true;
    else if (a === "--all-events") opts.allEventTypes = true;
    else if (a === "--json") json = true;
    else if (a === "--setup") setup = true;
    else if (!a.startsWith("--")) terms.push(a);
  }
  opts.query = terms.join(" ") || undefined;
  if (!opts.query && !opts.file) {
    console.error("usage: slowcook recall <query> | --file <path>  [--limit n] [--since 30d] [--workspace <path>] [--json]");
    process.exitCode = 2;
    return;
  }
  // NOTE: recall searches ALL history by default — a decision learned building
  // one repo often helps another (e.g. a dash lesson while working in slowcook).
  // Pass --workspace <path> to scope to a single checkout.

  if (!ctxAvailable()) {
    if (json) { console.log(JSON.stringify({ available: false, results: [] })); return; }
    console.log(INSTALL_HINT);
    return; // exit 0 — best-effort
  }
  if (setup) ctxSetup();

  const results = ctxSearch(opts);
  if (json) {
    console.log(JSON.stringify({ available: true, query: opts.query ?? null, file: opts.file ?? null, results }, null, 2));
    return;
  }
  console.log(recallBrief(results, { label: opts.file ? opts.file : `"${opts.query}"`, max: opts.limit }));
}
