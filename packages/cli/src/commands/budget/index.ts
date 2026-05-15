/**
 * 0.19.0-α.35 (sc#66 follow-up) — `slowcook budget` subcommand.
 *
 *   slowcook budget                              # show config + month-to-date spend
 *   slowcook budget set --monthly 50             # set monthly_budget_usd
 *   slowcook budget set --monthly 50 --start-day 15 --story 10
 *   slowcook budget rm                           # delete config (disables gauge)
 *
 * Writes/reads `.brewing/budget.yaml`. Idempotent: `set` merges into
 * existing config; absent flags keep their current values; missing
 * monthly_budget_usd on a brand-new config defaults nothing (must be
 * supplied at least once).
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import {
  loadBudgetConfig,
  aggregateMonthSpend,
  aggregateSpendSince,
  currentPeriodStart,
  classifyBudgetStatus,
  type BudgetConfig,
} from "../../lib/budget.js";

interface BudgetArgs {
  cwd: string;
  action: "show" | "set" | "rm";
  monthly?: number;
  startDay?: number;
  story?: number;
  credit?: number;
  /** ISO timestamp override — defaults to "now" when `--credit` is set. Mostly for tests. */
  creditBaselineAt?: string;
}

function parseArgs(argv: string[]): BudgetArgs {
  const args: BudgetArgs = { cwd: process.cwd(), action: "show" };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--cwd" && next) {
      args.cwd = next;
      i++;
    } else if (arg === "--monthly" && next) {
      args.monthly = Number(next);
      i++;
    } else if (arg === "--start-day" && next) {
      args.startDay = Number(next);
      i++;
    } else if (arg === "--story" && next) {
      args.story = Number(next);
      i++;
    } else if (arg === "--credit" && next) {
      args.credit = Number(next);
      i++;
    } else if (arg === "--credit-baseline" && next) {
      args.creditBaselineAt = next;
      i++;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg && !arg.startsWith("--")) {
      positional.push(arg);
    }
  }
  const verb = positional[0];
  if (verb === "set" || verb === "rm") args.action = verb;
  else if (verb && verb !== "show") {
    throw new Error(`Unknown budget action: ${verb}. Use show | set | rm.`);
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook budget — manage the project budget(s) for the fuel gauge

Two independent gauges, both optional, both opt-in:

  monthly_budget_usd     A per-period cap that resets each month.
  credit_balance_usd     A non-recurring credit deposit (e.g. you topped
                         up $25 on Anthropic and DON'T have auto-recharge);
                         the gauge subtracts ALL-TIME spend from this.

Usage:
  slowcook budget                                    Show current config + spend
  slowcook budget set --monthly <usd>                Set the monthly cap
  slowcook budget set --monthly 50 --start-day 15    Non-1st reset day
  slowcook budget set --credit <usd>                 Track a one-shot deposit
  slowcook budget set --story <usd>                  Optional per-story ceiling
  slowcook budget rm                                 Delete .brewing/budget.yaml

Flags:
  --monthly <usd>      Monthly budget in USD. Resets each period.
  --start-day <1-31>   Calendar day the monthly budget resets. Default 1.
  --credit <usd>       One-shot credit deposit. Captures the date of set as
                       a baseline; spend tracked from there. Re-run to top up.
  --story <usd>        Optional per-story informational ceiling.
  --cwd <path>         Project root. Defaults to current working dir.

When set, every refine comment appends:
  ⛽ Project this month: $X of $Y  (monthly cap)
  🪙 Anthropic credit:   $X of $Y  (credit balance)

Both fire ⚠️ at 80% and 🛑 at 95%.

Top-up workflow (no auto-recharge):
  $ slowcook budget set --credit 25         # at the start of $25 deposit
  ... burn through credit ...
  $ slowcook budget set --credit 50         # after topping up to $50 (new baseline)
`);
}

function configPath(cwd: string): string {
  return join(cwd, ".brewing", "budget.yaml");
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export async function budget(argv: string[]): Promise<void> {
  let parsed: BudgetArgs;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }

  if (parsed.action === "rm") {
    const p = configPath(parsed.cwd);
    if (!existsSync(p)) {
      console.log(`No .brewing/budget.yaml — nothing to remove.`);
      return;
    }
    unlinkSync(p);
    console.log(`Removed ${p}. Fuel gauge now disabled.`);
    return;
  }

  if (parsed.action === "set") {
    // Merge into existing config; allow updating individual fields.
    let existing: BudgetConfig | null = null;
    try {
      existing = loadBudgetConfig(parsed.cwd);
    } catch (e) {
      console.error(`Existing config is invalid — fix or rm first: ${(e as Error).message}`);
      process.exit(2);
    }
    const monthly = parsed.monthly ?? existing?.monthly_budget_usd;
    if (monthly !== undefined && (!Number.isFinite(monthly) || monthly <= 0)) {
      console.error(`--monthly must be a positive number, got ${parsed.monthly}`);
      process.exit(2);
    }
    const startDay = parsed.startDay ?? existing?.monthly_start_day ?? 1;
    if (!Number.isInteger(startDay) || startDay < 1 || startDay > 31) {
      console.error(`--start-day must be an integer 1-31, got ${parsed.startDay}`);
      process.exit(2);
    }
    const story = parsed.story ?? existing?.story_budget_usd;
    if (story !== undefined && (!Number.isFinite(story) || story <= 0)) {
      console.error(`--story must be a positive number, got ${parsed.story}`);
      process.exit(2);
    }
    // Credit handling — a fresh --credit captures "now" as the
    // baseline. Re-running --credit (top-up) refreshes the baseline so
    // the gauge tracks ONLY spend from the new deposit forward.
    let credit: number | undefined = existing?.credit_balance_usd;
    let creditBaselineAt: string | undefined = existing?.credit_baseline_at;
    if (parsed.credit !== undefined) {
      if (!Number.isFinite(parsed.credit) || parsed.credit <= 0) {
        console.error(`--credit must be a positive number, got ${parsed.credit}`);
        process.exit(2);
      }
      credit = parsed.credit;
      creditBaselineAt = parsed.creditBaselineAt ?? new Date().toISOString();
    }

    if (monthly === undefined && credit === undefined) {
      console.error(
        `Set at least one of --monthly or --credit. Try: slowcook budget set --credit 25`
      );
      process.exit(2);
    }

    const next: BudgetConfig = {
      schema_version: 1,
      monthly_start_day: startDay,
      ...(monthly !== undefined ? { monthly_budget_usd: monthly } : {}),
      ...(story !== undefined ? { story_budget_usd: story } : {}),
      ...(credit !== undefined ? { credit_balance_usd: credit } : {}),
      ...(creditBaselineAt !== undefined ? { credit_baseline_at: creditBaselineAt } : {}),
    };

    const p = configPath(parsed.cwd);
    mkdirSync(join(parsed.cwd, ".brewing"), { recursive: true });
    writeFileSync(p, YAML.stringify(next, { lineWidth: 0 }), "utf8");
    const verb = existing ? "Updated" : "Wrote";
    console.log(`${verb} ${p}`);
    console.log(readFileSync(p, "utf8"));
    return;
  }

  // show
  let config: BudgetConfig | null;
  try {
    config = loadBudgetConfig(parsed.cwd);
  } catch (e) {
    console.error(`Config at ${configPath(parsed.cwd)} is invalid: ${(e as Error).message}`);
    process.exit(2);
  }
  if (!config) {
    console.log(`No .brewing/budget.yaml — fuel gauge disabled.`);
    console.log(`Set one with:  slowcook budget set --credit 25      (one-shot deposit)`);
    console.log(`         or:  slowcook budget set --monthly 50     (recurring cap)`);
    return;
  }
  const now = new Date();
  console.log(`Config: ${configPath(parsed.cwd)}`);
  if (config.monthly_budget_usd !== undefined) {
    console.log(`  monthly_budget_usd:  ${fmtUsd(config.monthly_budget_usd)}`);
    console.log(`  monthly_start_day:   ${config.monthly_start_day}`);
  }
  if (config.story_budget_usd !== undefined) {
    console.log(`  story_budget_usd:    ${fmtUsd(config.story_budget_usd)}`);
  }
  if (config.credit_balance_usd !== undefined) {
    console.log(`  credit_balance_usd:  ${fmtUsd(config.credit_balance_usd)}`);
    console.log(`  credit_baseline_at:  ${config.credit_baseline_at ?? "(unset)"}`);
  }
  console.log(``);
  if (config.monthly_budget_usd !== undefined) {
    const period = currentPeriodStart(config, now);
    const spend = aggregateMonthSpend(parsed.cwd, config, now);
    const status = classifyBudgetStatus(spend.usd, config.monthly_budget_usd);
    const pct = Math.round((spend.usd / config.monthly_budget_usd) * 100);
    const icon = status === "halt" ? "🛑" : status === "warn" ? "⚠️" : "⛽";
    console.log(`Period start: ${period.toISOString().slice(0, 10)}`);
    console.log(
      `${icon} Spent this period: ${fmtUsd(spend.usd)} of ${fmtUsd(config.monthly_budget_usd)} (${pct}%)`
    );
    console.log(
      `   ${spend.entryCount} entr${spend.entryCount === 1 ? "y" : "ies"} across ${spend.storyCount} stor${spend.storyCount === 1 ? "y" : "ies"}.`
    );
    if (status === "warn") {
      console.log(`   ⚠️  approaching monthly budget — consider topping up.`);
    } else if (status === "halt") {
      console.log(`   🛑 over budget — agents will halt without the override-budget label.`);
    }
    console.log(``);
  }
  if (config.credit_balance_usd !== undefined && config.credit_baseline_at) {
    const baseline = new Date(config.credit_baseline_at);
    const spend = aggregateSpendSince(parsed.cwd, baseline);
    const status = classifyBudgetStatus(spend.usd, config.credit_balance_usd);
    const remaining = Math.max(0, config.credit_balance_usd - spend.usd);
    const pctLeft = Math.max(
      0,
      100 - Math.round((spend.usd / config.credit_balance_usd) * 100)
    );
    const icon = status === "halt" ? "🛑" : status === "warn" ? "⚠️" : "🪙";
    console.log(`Credit baseline: ${config.credit_baseline_at.slice(0, 10)}`);
    console.log(
      `${icon} Anthropic credit: ${fmtUsd(remaining)} of ${fmtUsd(config.credit_balance_usd)} remaining (${pctLeft}%)`
    );
    console.log(
      `   Spent ${fmtUsd(spend.usd)} since baseline. ${spend.entryCount} entr${spend.entryCount === 1 ? "y" : "ies"}.`
    );
    if (status === "warn") {
      console.log(
        `   ⚠️  approaching empty — top up at https://console.anthropic.com/settings/billing.`
      );
      console.log(
        `       Then: slowcook budget set --credit <new-total>     # captures fresh baseline`
      );
    } else if (status === "halt") {
      console.log(`   🛑 credit nearly exhausted — pipeline will halt on 402 imminently.`);
      console.log(
        `       Top up + re-run: slowcook budget set --credit <new-total>`
      );
    }
  }
}
