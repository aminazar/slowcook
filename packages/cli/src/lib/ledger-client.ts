/**
 * EVERY STAGE WRITES ITS OWN COST ROW (2026-10-24, swarm-vs-plain WP1).
 *
 * Before this, only brew and refine appended to `specs/story-<id>.cost.jsonl`.
 * testgen, vibe, plate, taste, chef and the navigator spent real money that
 * reached the ledger only through PR-comment markers — or not at all. An
 * experiment that compares arms on cost cannot be run on a ledger that
 * records two stages out of seven.
 *
 * `withLedger` wraps any `LlmClient`: each `complete()` appends one row,
 * priced by the caller-supplied `priceFor` (list price; `null` for an
 * unpriced model — never 0), with the call's wall-clock bounds. The wrapped
 * client is otherwise transparent, and bookkeeping never fails the work.
 */
import type { LlmClient, LlmRequest, LlmResponse, LlmUsage } from "@slowcook-ai/core";
import { appendCostEntry, type CostEntry } from "../cost-store.js";

export interface LedgerOptions {
  repoRoot: string;
  storyId: string;
  /** Row `agent` — the stage name as `slowcook cost report` groups it. */
  agent: string;
  /** Optional finer label (e.g. "round-2"); a per-call counter is appended
   *  when omitted so rows stay distinguishable. */
  round?: string;
  /** List-price function. `null` = unpriced (recorded as unknown). */
  priceFor: (model: string, usage: LlmUsage) => number | null;
  /** Injectable for tests. */
  append?: (repoRoot: string, storyId: string, entry: CostEntry) => void;
  now?: () => Date;
}

/** Build the row for one completed call. Pure; exported for tests. */
export function ledgerRow(
  opts: Pick<LedgerOptions, "agent" | "priceFor">,
  call: { model: string; usage: LlmUsage; round: string; startedAt: Date; finishedAt: Date }
): CostEntry {
  return {
    agent: opts.agent,
    usd: opts.priceFor(call.model, call.usage),
    model: call.model,
    round: call.round,
    at: call.finishedAt.toISOString(),
    tokens_in: call.usage.inputTokens,
    tokens_out: call.usage.outputTokens,
    cache_read: call.usage.cacheReadTokens,
    cache_create: call.usage.cacheCreateTokens,
    started_at: call.startedAt.toISOString(),
    finished_at: call.finishedAt.toISOString(),
  };
}

export function withLedger(inner: LlmClient, opts: LedgerOptions): LlmClient {
  const append = opts.append ?? appendCostEntry;
  const now = opts.now ?? (() => new Date());
  let calls = 0;
  return {
    async complete(args: LlmRequest): Promise<LlmResponse> {
      const startedAt = now();
      const response = await inner.complete(args);
      calls += 1;
      try {
        append(
          opts.repoRoot,
          opts.storyId,
          ledgerRow(opts, {
            model: response.model || args.model,
            usage: response.usage,
            round: opts.round ?? `call-${calls}`,
            startedAt,
            finishedAt: now(),
          })
        );
      } catch {
        /* bookkeeping must never fail the work */
      }
      return response;
    },
  };
}
