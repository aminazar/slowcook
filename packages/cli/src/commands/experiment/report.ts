/**
 * `slowcook experiment report` — one row per story × arm, mean over seeds.
 *
 * Reads the run sidecars only; never rewrites them. Cost is repriced IN
 * MEMORY against the current table so two arms run days apart share one
 * price basis (the `cost reprice` lesson), and unpriced rows are counted,
 * never summed as $0.
 */
import type { CostEntry } from "../../cost-store.js";
import { repriceEntries, sumEntries } from "../../cost-store.js";
import type { LoadedRun } from "./records.js";
import type { LlmUsage } from "@slowcook-ai/core";

export type Verdict = "all-green" | "partial" | "red" | "no-verify";

export interface ReportRow {
  story: string;
  arm: string;
  n: number;
  /** Mean list-price cost of the runs that had NO unpriced rows; null if none did. */
  cost_usd: number | null;
  unpriced_rows: number;
  green: number;
  total: number;
  verdict: Verdict;
  /** Red story tests whose failure text names a missing testid/role/text hook. */
  selector_only_red: number;
  behavioural_red: number;
  /** Full-suite reds outside the story beyond the base's count. */
  new_full_suite_reds: number;
  typecheck_regressions: number;
  wall_min: number | null;
  iterations: number | null;
  halt_reasons: string[];
  models: string;
  classes: string[];
}

/**
 * A failing story test that only says "the hook the pipeline's test pins
 * is not there" — the plain arm could not know the testid/role/text the
 * tests assert on. Reported separately from behavioural failures (the
 * KNOWN BIAS of the issue-only arm). Pure; exported for tests.
 */
export function isSelectorOnlyFailure(message: string | undefined): boolean {
  if (!message) return false;
  return /Unable to find (an|any) (accessible )?element|data-testid|getBy(TestId|Role|Text|LabelText|PlaceholderText|AltText)|TestingLibraryElementError|Found multiple elements|expected .* to be in the document|toBeInTheDocument/i.test(
    message
  );
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function verdictFor(green: number, total: number, hasVerify: boolean): Verdict {
  if (!hasVerify) return "no-verify";
  if (total > 0 && green === total) return "all-green";
  if (green > 0) return "partial";
  return "red";
}

/** The numbers of ONE run, before averaging. Pure; exported for tests. */
export function summarizeOne(
  run: LoadedRun,
  priceFor: (model: string, usage: LlmUsage) => number | null
): {
  cost_usd: number | null; unpriced_rows: number; green: number; total: number; verdict: Verdict;
  selector_only_red: number; behavioural_red: number; new_full_suite_reds: number; typecheck_regressions: number;
  wall_ms: number | null; iterations: number | null; halt_reason?: string; model?: string; cls?: string;
} {
  const repriced = repriceEntries(run.cost, priceFor).entries;
  const { totalUsd, unpricedCount } = sumEntries(repriced);
  // A plain arm has no ledger rows; its own record carries the price.
  const plainUsd = run.plain ? (run.plain.unpriced ? null : run.plain.usd) : undefined;
  const cost_usd = plainUsd !== undefined ? plainUsd : unpricedCount > 0 ? null : totalUsd;
  const unpriced_rows = unpricedCount + (run.plain?.unpriced ? 1 : 0);
  const sc = run.verify?.story_contract;
  const green = sc?.green ?? 0;
  const total = sc?.total ?? 0;
  const reds = sc?.red ?? [];
  const selector_only_red = reds.filter((r) => isSelectorOnlyFailure(r.message)).length;
  const baseOutside = run.baseVerify?.full_suite?.red_outside_story ?? 0;
  const outside = run.verify?.full_suite?.red_outside_story ?? 0;
  const wall_ms = run.record.wall_ms ?? run.summary?.wall_ms ?? run.plain?.wall_ms ?? null;
  return {
    cost_usd,
    unpriced_rows,
    green,
    total,
    verdict: verdictFor(green, total, Boolean(sc)),
    selector_only_red,
    behavioural_red: reds.length - selector_only_red,
    new_full_suite_reds: Math.max(0, outside - baseOutside),
    typecheck_regressions: run.verify?.typecheck?.regressions.length ?? 0,
    wall_ms,
    iterations: run.summary?.iterations ?? run.halt?.iterations_run ?? (run.plain ? run.plain.turns : null),
    halt_reason: run.summary?.halt_reason ?? run.halt?.halt_reason ?? (run.plain ? `plain:${run.plain.stop}` : undefined),
    model: run.summary?.model ?? run.halt?.model ?? run.record.models["brew"] ?? run.record.models["plain"],
    cls: run.classification?.confirmed_class ?? (run.classification ? `${run.classification.draft_class}?` : undefined),
  };
}

/** story × arm rows, mean over seeds. Pure; exported for tests. */
export function aggregateRuns(
  runs: LoadedRun[],
  priceFor: (model: string, usage: LlmUsage) => number | null
): ReportRow[] {
  const groups = new Map<string, LoadedRun[]>();
  for (const r of runs) {
    const k = `${r.record.story}\u0000${r.record.arm}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const rows: ReportRow[] = [];
  for (const [k, rs] of groups) {
    const [story, arm] = k.split("\u0000") as [string, string];
    const ones = rs.map((r) => summarizeOne(r, priceFor));
    const priced = ones.map((o) => o.cost_usd).filter((c): c is number => c !== null);
    const greens = ones.map((o) => o.green);
    const totals = ones.map((o) => o.total);
    const walls = ones.map((o) => o.wall_ms).filter((w): w is number => w !== null);
    const iters = ones.map((o) => o.iterations).filter((i): i is number => i !== null);
    const green = Math.round((mean(greens) ?? 0) * 10) / 10;
    const total = Math.max(0, ...totals);
    rows.push({
      story,
      arm,
      n: rs.length,
      cost_usd: priced.length ? Math.round((mean(priced) ?? 0) * 10000) / 10000 : null,
      unpriced_rows: ones.reduce((a, o) => a + o.unpriced_rows, 0),
      green,
      total,
      verdict: verdictFor(green, total, ones.some((o) => o.verdict !== "no-verify")),
      selector_only_red: ones.reduce((a, o) => a + o.selector_only_red, 0),
      behavioural_red: ones.reduce((a, o) => a + o.behavioural_red, 0),
      new_full_suite_reds: Math.max(0, ...ones.map((o) => o.new_full_suite_reds)),
      typecheck_regressions: Math.max(0, ...ones.map((o) => o.typecheck_regressions)),
      wall_min: walls.length ? Math.round(((mean(walls) ?? 0) / 60000) * 10) / 10 : null,
      iterations: iters.length ? Math.round((mean(iters) ?? 0) * 10) / 10 : null,
      halt_reasons: [...new Set(ones.map((o) => o.halt_reason).filter((h): h is string => Boolean(h)))],
      models: [...new Set(ones.map((o) => o.model).filter((m): m is string => Boolean(m)))].join(","),
      classes: ones.map((o) => o.cls).filter((c): c is string => Boolean(c)),
    });
  }
  return rows.sort((a, b) => a.story.localeCompare(b.story) || a.arm.localeCompare(b.arm));
}

/** Models seen across the runs with the prices used — the report's price basis. */
export function priceBasis(
  runs: LoadedRun[],
  priceFor: (model: string, usage: LlmUsage) => number | null
): Array<{ model: string; in_per_m: number | null; out_per_m: number | null }> {
  const models = new Set<string>();
  for (const r of runs) {
    for (const e of r.cost) if (e.model) models.add(e.model);
    for (const m of Object.values(r.record.models)) models.add(m);
  }
  const unit = (m: string, k: "in" | "out"): number | null => {
    const usage: LlmUsage = { inputTokens: k === "in" ? 1_000_000 : 0, outputTokens: k === "out" ? 1_000_000 : 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
    return priceFor(m, usage);
  };
  return [...models].sort().map((model) => ({ model, in_per_m: unit(model, "in"), out_per_m: unit(model, "out") }));
}

export function renderMarkdown(rows: ReportRow[], basis: ReturnType<typeof priceBasis>): string {
  const lines: string[] = [];
  lines.push("| story | arm | n | cost $ | green/total | verdict | selector-only | behavioural | new reds | tsc regr | wall min | iters | halts | models | class |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const cost = r.cost_usd === null ? `? (${r.unpriced_rows} unpriced)` : `${r.cost_usd.toFixed(2)}${r.unpriced_rows ? ` (+${r.unpriced_rows} unpriced)` : ""}`;
    lines.push(
      `| ${r.story} | ${r.arm} | ${r.n} | ${cost} | ${r.green}/${r.total} | ${r.verdict} | ${r.selector_only_red} | ${r.behavioural_red} | ${r.new_full_suite_reds} | ${r.typecheck_regressions} | ${r.wall_min ?? "?"} | ${r.iterations ?? "?"} | ${r.halt_reasons.join(" ") || "-"} | ${r.models || "-"} | ${r.classes.join(" ") || "-"} |`
    );
  }
  lines.push("");
  lines.push("price basis (list, $/M tokens): " + (basis.length ? basis.map((b) => `${b.model} ${b.in_per_m ?? "?"}/${b.out_per_m ?? "?"}`).join(" · ") : "(no models)"));
  return lines.join("\n");
}

/** Re-exported for `report --json` consumers that want the raw rows too. */
export type { CostEntry };
