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
  monthly_budget_usd: z.number().positive(),
  /** 1-31. The day of the calendar month the budget resets. */
  monthly_start_day: z.number().int().min(1).max(31).default(1),
  /** Optional per-story ceiling (informational). */
  story_budget_usd: z.number().positive().optional(),
});

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
 * `at` falls inside the current monthly period. Story IDs are derived
 * from filenames (`story-<id>.cost.jsonl`).
 */
export function aggregateMonthSpend(
  repoRoot: string,
  config: BudgetConfig,
  now: Date = new Date()
): { usd: number; entryCount: number; storyCount: number } {
  const specsDir = join(repoRoot, "specs");
  if (!existsSync(specsDir)) return { usd: 0, entryCount: 0, storyCount: 0 };
  const periodStart = currentPeriodStart(config, now);
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
      if (Number.isFinite(at) && at >= periodStart.getTime()) {
        usd += e.usd;
        entryCount++;
        storyTouched = true;
      }
    }
    if (storyTouched) storyCount++;
  }
  return { usd, entryCount, storyCount };
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
 * Convenience: read config + aggregate spend + format gauge in one call.
 * Returns empty string when no budget.yaml exists (gauge disabled).
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
  try {
    const { usd } = aggregateMonthSpend(repoRoot, config, now);
    return formatFuelGauge({ currentUsd: usd, budgetUsd: config.monthly_budget_usd });
  } catch (e) {
    console.warn(`[fuel-gauge] aggregation failed: ${(e as Error).message}`);
    return "";
  }
}
