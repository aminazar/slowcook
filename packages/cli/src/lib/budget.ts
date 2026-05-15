/**
 * 0.19.0-α.34 (sc#66) — project-level fuel gauge.
 *
 * Consumer authors `.brewing/budget.yaml`:
 *
 *   schema_version: 1
 *   monthly_budget_usd: 50
 *   monthly_start_day: 1
 *
 * Aggregates spend by reading `specs/story-*.cost.jsonl` sidecars (sc#67)
 * — much cheaper than walking GH comments. Returns a markdown gauge line
 * that agents append to their existing cost footer:
 *
 *   ⛽ **Project this month:** $42.18 of $50.00 (84%)
 *   ⚠️ approaching budget — top up at https://console.anthropic.com/...
 *
 * Future work (NOT in MVP): halt-before-LLM-call at 95%, override label,
 * weekly slices, per-scope budgets. Today the gauge is informational.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { readCostTotal } from "../cost-store.js";

const BudgetConfigSchema = z.object({
  schema_version: z.literal(1),
  monthly_budget_usd: z.number().positive().optional(),
  /** 1-31. The day of the calendar month the budget resets. */
  monthly_start_day: z.number().int().min(1).max(31).default(1),
  /** Optional per-story ceiling (informational). */
  story_budget_usd: z.number().positive().optional(),
  /**
   * 0.19.0-α.35 — anthropic credit deposit tracking. Unlike
   * `monthly_budget_usd` (which resets each period), this models a
   * non-recurring credit deposit (e.g. you topped up $25). The gauge
   * subtracts ALL-TIME spend from this number, so once the sidecar
   * shows $24 of usage you're down to $1 remaining.
   *
   * Set via: slowcook budget set --credit 25
   *
   * Re-set whenever you top up: slowcook budget set --credit 50
   * (the all-time spend baseline is captured at the time of set, so
   * re-setting resets the gauge to "full" for the new deposit).
   */
  credit_balance_usd: z.number().positive().optional(),
  /**
   * ISO timestamp captured when `credit_balance_usd` was set / last
   * topped up. The gauge sums sidecar entries with `at >=` this value;
   * spend before this is presumed already paid for by an earlier
   * deposit. Written by `slowcook budget set --credit`; consumers
   * shouldn't author this by hand.
   */
  credit_baseline_at: z.string().optional(),
}).refine(
  (data) => data.monthly_budget_usd !== undefined || data.credit_balance_usd !== undefined,
  { message: "must set monthly_budget_usd or credit_balance_usd (or both)" }
);

export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

/**
 * Load `.brewing/budget.yaml`. Returns null when the file is absent —
 * gauge is opt-in. Throws on malformed YAML / schema violation so a
 * mis-authored config surfaces loudly instead of silently disabling.
 */
export function loadBudgetConfig(repoRoot: string): BudgetConfig | null {
  const path = join(repoRoot, ".brewing", "budget.yaml");
  if (!existsSync(path)) return null;
  const raw = YAML.parse(readFileSync(path, "utf8"));
  const parsed = BudgetConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid .brewing/budget.yaml: ${parsed.error.issues.map((i) => i.message).join("; ")}`
    );
  }
  return parsed.data;
}

/** ISO-8601 date of the current monthly budget period start, given config. */
export function currentPeriodStart(
  config: Pick<BudgetConfig, "monthly_start_day">,
  now: Date = new Date()
): Date {
  const day = config.monthly_start_day;
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const candidate = new Date(Date.UTC(y, m, day));
  // If today is before this month's reset day, the period started LAST month.
  if (now.getTime() < candidate.getTime()) {
    return new Date(Date.UTC(y, m - 1, day));
  }
  return candidate;
}

/**
 * Sum cost entries across ALL story sidecars in `specs/` whose entry
 * `at` is >= `since`. Story IDs are derived from filenames
 * (`story-<id>.cost.jsonl`). Used by both:
 *   - monthly_budget_usd gauge (since = period start)
 *   - credit_balance_usd gauge (since = credit_baseline_at)
 */
export function aggregateSpendSince(
  repoRoot: string,
  since: Date
): { usd: number; entryCount: number; storyCount: number } {
  const specsDir = join(repoRoot, "specs");
  if (!existsSync(specsDir)) return { usd: 0, entryCount: 0, storyCount: 0 };
  let usd = 0;
  let entryCount = 0;
  let storyCount = 0;
  for (const f of readdirSync(specsDir)) {
    const m = /^story-(.+)\.cost\.jsonl$/.exec(f);
    if (!m || !m[1]) continue;
    const storyId = m[1];
    const { entries } = readCostTotal(repoRoot, storyId);
    let storyTouched = false;
    for (const e of entries) {
      const at = Date.parse(e.at);
      if (Number.isFinite(at) && at >= since.getTime()) {
        usd += e.usd;
        entryCount++;
        storyTouched = true;
      }
    }
    if (storyTouched) storyCount++;
  }
  return { usd, entryCount, storyCount };
}

/**
 * Back-compat wrapper for the period-based aggregation.
 */
export function aggregateMonthSpend(
  repoRoot: string,
  config: BudgetConfig,
  now: Date = new Date()
): { usd: number; entryCount: number; storyCount: number } {
  const periodStart = currentPeriodStart(config, now);
  return aggregateSpendSince(repoRoot, periodStart);
}

export interface FuelGaugeArgs {
  currentUsd: number;
  budgetUsd: number;
  /** GIF rendered when status === "warn" or "halt". Defaults to fuel-empty. */
  gifUrl?: string;
}

export type BudgetStatus = "ok" | "warn" | "halt";

const FUEL_GIF =
  "https://media0.giphy.com/media/v1.Y2lkPTc5MGI3NjExMTVveDJ4bmNuY3dsa2hrNnVweTd6MWhpbXIxc3pvajhsN3Q5b21vdyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/8CMmJ6F8hTxqX7Ts5k/giphy.gif";

export function classifyBudgetStatus(currentUsd: number, budgetUsd: number): BudgetStatus {
  if (budgetUsd <= 0) return "ok";
  const ratio = currentUsd / budgetUsd;
  if (ratio >= 0.95) return "halt";
  if (ratio >= 0.8) return "warn";
  return "ok";
}

/**
 * Render the fuel-gauge markdown block. Empty string when budget <= 0
 * (defensive — the config schema rejects this). Always returns a
 * trailing newline so callers can concatenate without thinking.
 */
export function formatFuelGauge(args: FuelGaugeArgs): string {
  const { currentUsd, budgetUsd } = args;
  if (budgetUsd <= 0) return "";
  const pct = Math.round((currentUsd / budgetUsd) * 100);
  const status = classifyBudgetStatus(currentUsd, budgetUsd);
  const lines: string[] = [];
  lines.push(
    `\n\n⛽ **Project this month:** $${currentUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} (${pct}%)`
  );
  if (status === "warn") {
    lines.push(
      `⚠️ approaching monthly budget — consider topping up at https://console.anthropic.com/settings/billing`
    );
    lines.push(`![fuel low](${args.gifUrl ?? FUEL_GIF})`);
  } else if (status === "halt") {
    lines.push(
      `🛑 monthly budget exceeded — add the \`override-budget\` label to allow agents to continue, or top up at https://console.anthropic.com/settings/billing`
    );
    lines.push(`![fuel empty](${args.gifUrl ?? FUEL_GIF})`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Render the credit-balance gauge (sc#66 0.19.0-α.35). Reports remaining
 * USD on a one-shot Anthropic deposit (no auto-recharge). Spends counted
 * since `baselineAt`; remaining = `deposit - spent`.
 */
export function formatCreditGauge(args: {
  depositUsd: number;
  spentUsd: number;
  baselineAt: string;
  gifUrl?: string;
}): string {
  const remaining = Math.max(0, args.depositUsd - args.spentUsd);
  const ratio = args.depositUsd <= 0 ? 0 : args.spentUsd / args.depositUsd;
  const pctSpent = Math.round(ratio * 100);
  const pctLeft = Math.max(0, 100 - pctSpent);
  let status: BudgetStatus = "ok";
  if (ratio >= 0.95) status = "halt";
  else if (ratio >= 0.8) status = "warn";

  const lines: string[] = [];
  lines.push(
    `\n\n🪙 **Anthropic credit:** $${remaining.toFixed(2)} of $${args.depositUsd.toFixed(2)} remaining (${pctLeft}%) — spent $${args.spentUsd.toFixed(2)} since ${args.baselineAt.slice(0, 10)}`
  );
  if (status === "warn") {
    lines.push(
      `⚠️ approaching empty — top up at https://console.anthropic.com/settings/billing before pipeline runs halt with 402.`
    );
    lines.push(`![fuel low](${args.gifUrl ?? FUEL_GIF})`);
  } else if (status === "halt") {
    lines.push(
      `🛑 credit nearly exhausted — pipeline will halt on 402 imminently. Top up at https://console.anthropic.com/settings/billing.`
    );
    lines.push(`![fuel empty](${args.gifUrl ?? FUEL_GIF})`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Convenience: read config + aggregate spend + format gauge(s) in one
 * call. Returns empty string when no budget.yaml exists (gauge disabled).
 * Renders BOTH gauges when both fields are set in the config.
 * Best-effort: a parse failure or aggregation error logs to console.warn
 * and returns "" rather than blocking the agent's comment.
 */
export function fuelGaugeFromRepo(repoRoot: string, now: Date = new Date()): string {
  let config: BudgetConfig | null;
  try {
    config = loadBudgetConfig(repoRoot);
  } catch (e) {
    console.warn(`[fuel-gauge] config load failed: ${(e as Error).message}`);
    return "";
  }
  if (!config) return "";
  let out = "";
  try {
    if (config.monthly_budget_usd !== undefined) {
      const { usd } = aggregateMonthSpend(repoRoot, config, now);
      out += formatFuelGauge({ currentUsd: usd, budgetUsd: config.monthly_budget_usd });
    }
    if (config.credit_balance_usd !== undefined && config.credit_baseline_at) {
      const baseline = new Date(config.credit_baseline_at);
      const { usd } = aggregateSpendSince(repoRoot, baseline);
      out += formatCreditGauge({
        depositUsd: config.credit_balance_usd,
        spentUsd: usd,
        baselineAt: config.credit_baseline_at,
      });
    }
  } catch (e) {
    console.warn(`[fuel-gauge] aggregation failed: ${(e as Error).message}`);
    return "";
  }
  return out;
}
