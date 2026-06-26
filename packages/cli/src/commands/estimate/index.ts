/**
 * `slowcook estimate` — the post-`menu` budget. Reads active specs, computes a
 * 3-point dual-currency estimate per story (countable drivers ⊕ the LLM `effort`
 * block), and rolls the backlog up to portfolio percentiles via Monte-Carlo.
 *
 * This is the earliest, highest-decision-value point on the cone of uncertainty;
 * dash consumes this output for the Forecast/roadmap surfaces. See
 * dash docs/BUDGETING-AND-ROADMAP.md.
 */
import { resolve } from "node:path";
import { listActiveSpecs } from "../refine/spec-yaml.js";
import { estimateStory, monteCarloPortfolio, SEED_CALIBRATION, type StoryEstimate } from "./model.js";

function argFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

const usd = (cents: number) => `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const hrs = (h: number) => `${h.toFixed(1)}h`;
const tok = (t: number) => (t >= 1_000_000 ? `${(t / 1_000_000).toFixed(1)}M` : `${Math.round(t / 1000)}k`);

export async function runEstimate(argv: string[]): Promise<void> {
  const cwd = resolve(argFlag(argv, "--cwd") ?? ".");
  const asJson = argv.includes("--json");
  const byEpic = argv.includes("--by-epic");
  const iterations = Number(argFlag(argv, "--iterations") ?? "10000");

  const specs = listActiveSpecs(cwd);
  if (specs.length === 0) {
    console.error("estimate: no active specs under specs/ — run `menu` first.");
    process.exit(1);
  }
  const estimates = specs.map((s) => estimateStory(s, SEED_CALIBRATION));
  const portfolio = monteCarloPortfolio(estimates, iterations);
  const withEffort = specs.filter((s) => s.effort).length;

  if (asJson) {
    process.stdout.write(JSON.stringify({ estimates, portfolio, calibration: "seed", withEffort }, null, 2) + "\n");
    return;
  }

  console.log(`slowcook estimate — ${estimates.length} stories · ${withEffort} carry an \`effort\` block · seed calibration\n`);

  const rows = byEpic ? groupByEpic(estimates) : [{ label: null as string | null, items: estimates }];
  for (const group of rows) {
    if (group.label !== null) console.log(`\n  ▟ ${group.label}`);
    for (const e of group.items) {
      const flags = [e.risk !== "low" ? `risk:${e.risk}` : "", e.confidence < 0.6 ? `conf:${e.confidence}` : "", ...e.qualitativeDrivers]
        .filter(Boolean).join(" ");
      console.log(
        `  story-${e.storyId}  ${usd(e.costCents.m).padStart(8)} p50  ${usd(e.costCents.p).padStart(8)} p-hi` +
        `   ${hrs(e.hours.m).padStart(7)} · ${tok(e.tokens.m).padStart(5)} tok   ${e.title.slice(0, 46)}` +
        (flags ? `\n              ↳ ${flags}` : "")
      );
    }
  }

  const P = portfolio;
  console.log(`\n  ── Portfolio (Monte-Carlo, ${P.iterations.toLocaleString()} runs over ${P.stories} stories) ──`);
  console.log(`  Cost     p50 ${usd(P.costCents.p50)}   p85 ${usd(P.costCents.p85)}   p95 ${usd(P.costCents.p95)}   (Σ-deterministic ${usd(P.deterministic.costCents)})`);
  console.log(`  Labor    p50 ${hrs(P.hours.p50)}   p85 ${hrs(P.hours.p85)}   p95 ${hrs(P.hours.p95)}`);
  console.log(`  Compute  p50 ${tok(P.tokens.p50)}   p85 ${tok(P.tokens.p85)}   p95 ${tok(P.tokens.p95)} tokens`);
  console.log(`\n  p85 is the commitment threshold. The cone narrows as vibe/brew actuals replace these assumptions.`);
}

function groupByEpic(estimates: StoryEstimate[]): { label: string | null; items: StoryEstimate[] }[] {
  const map = new Map<string, StoryEstimate[]>();
  const order: string[] = [];
  for (const e of estimates) {
    const k = e.epic ?? "(no epic)";
    if (!map.has(k)) { map.set(k, []); order.push(k); }
    map.get(k)!.push(e);
  }
  return order.map((label) => ({ label, items: map.get(label)! }));
}
