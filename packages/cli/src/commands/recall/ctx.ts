/**
 * `ctx` wrapper — slowcook's bridge to the ctxrs/ctx CLI (Apache-2.0), which
 * indexes local coding-agent session histories (Claude Code + others) into a
 * private SQLite store and searches them token-efficiently.
 *
 * slowcook agents start context-blind: each brew/chef/refine run re-investigates
 * what a prior session already decided or tried. `ctx` gives them recall. This
 * module shells out to the binary (never vendors it) and is best-effort by
 * design — if ctx isn't installed, recall degrades to "no prior context",
 * never blocking a loop.
 */
import { execFileSync } from "node:child_process";

export interface CtxResult {
  itemType: string; // "session_result" | "session" | "event"
  label: string; // "message" | "tool output" | "session" | …
  sessionId: string;
  eventId?: string;
  provider: string; // "claude" | "cursor" | …
  title?: string;
  snippet: string;
  timestamp?: string;
  sourcePath?: string;
  rank?: number;
  sessionImportance?: number;
}

export interface CtxSearchOpts {
  query?: string;
  file?: string; // sessions that touched a file
  limit?: number;
  since?: string; // e.g. "30d"
  workspace?: string; // scope to a repo checkout
  includeCurrentSession?: boolean; // default false — recall wants PRIOR work
  allEventTypes?: boolean; // default false — recall wants DECISIONS (messages),
  //                          not command echoes / tool output noise
}

/** how to run ctx — injectable so tests never touch the real binary. */
export type CtxRunner = (args: string[]) => string;

const defaultRunner: CtxRunner = (args) =>
  execFileSync(process.env["CTX_BIN"] || "ctx", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });

/** is the ctx binary reachable? (best-effort recall degrades gracefully if not). */
export function ctxAvailable(run: CtxRunner = defaultRunner): boolean {
  try { run(["--version"]); return true; } catch { return false; }
}

interface RawResult {
  item_type?: string; label?: string; session_id?: string; event_id?: string;
  provider?: string; title?: string; snippet?: string; timestamp?: string;
  source_path?: string; rank?: number; session_importance?: number;
}

/** run `ctx search --json` and return normalized results (empty on any failure). */
export function ctxSearch(opts: CtxSearchOpts, run: CtxRunner = defaultRunner): CtxResult[] {
  // positional query = ctx's ranked/fuzzy search; --term is strict AND-match
  // (extra words zero it out), so recall uses the positional form.
  const args = ["search", "--json"];
  if (opts.query) args.push(opts.query);
  if (opts.file) args.push("--file", opts.file);
  args.push("--limit", String(opts.limit ?? 6));
  if (opts.since) args.push("--since", opts.since);
  if (opts.workspace) args.push("--workspace", opts.workspace);
  if (opts.includeCurrentSession) args.push("--include-current-session");
  // recall surfaces DECISIONS by default — assistant/user messages, not the
  // command-echo + tool-output noise that drowns out the signal.
  if (!opts.allEventTypes) args.push("--event-type", "message");
  let out: string;
  try { out = run(args); } catch { return []; }
  try {
    const parsed = JSON.parse(out) as { results?: RawResult[] };
    return (parsed.results ?? [])
      .filter((r) => r.item_type !== "session") // keep the richer session_result/event rows
      .map((r) => ({
        itemType: r.item_type ?? "", label: r.label ?? "", sessionId: r.session_id ?? "",
        eventId: r.event_id, provider: r.provider ?? "", title: r.title,
        snippet: (r.snippet ?? "").replace(/\s+/g, " ").trim(),
        timestamp: r.timestamp, sourcePath: r.source_path, rank: r.rank, sessionImportance: r.session_importance,
      }))
      .filter((r) => r.snippet.length > 0);
  } catch { return []; }
}

/** one-time index of local sessions (idempotent; ctx also auto-refreshes on search). */
export function ctxSetup(run: CtxRunner = defaultRunner): boolean {
  try { run(["setup"]); return true; } catch { return false; }
}
