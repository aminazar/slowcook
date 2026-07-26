/**
 * `slowcook vibe check` — the MOCK-CHECKER (P5). After the storyteller
 * exhausts the journeys:
 *
 *  1. SCORE the affordances (coverage × inverted red-route rank) and select
 *     the top 20% — the computed "most used" set, never a guess.
 *  2. GENERATE ×3 world variants (sparse / dense / adversarial briefs
 *     through the standing SEED_SYSTEM prompt; cached, deterministic).
 *  3. REPLAY each selected affordance's shortest containing walk in every
 *     generated world (world_sensitive asserts skipped in foreign worlds —
 *     structure must hold even when the data differs), page gates on.
 *  4. UX-OPTIMISE the critical journeys: two questions — fewer clicks?
 *     which repetition folds into defaults? — grounded in measured step
 *     counts and recurring patterns; mock-level proposals are queued for
 *     tell, structural ones become backprop claims.
 *  5. Emit .brewing/journeys/check-report.json; failures file claims.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AnthropicClient, SEED_SYSTEM, UX_OPTIMISE_SYSTEM, formatCostFooter } from "@slowcook-ai/llm-anthropic";
import { loadMockShapeConfig } from "../../lib/mock-shape.js";
import { fileBackpropClaims, type BackpropClaim } from "../../lib/backprop.js";
import { selectDriver } from "../../lib/browser/select.js";
import { replayPlan, type QaPlan } from "../../lib/browser/qa-replay.js";
import { scoreAffordances, selectTopAffordances, type AffordanceScore, type CompiledWalk } from "./walks.js";

const argFlag = (argv: string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

const WORLD_BRIEFS: Record<string, string> = {
  "gen-a": "SPARSE world: a brand-new account a few days in — minimal rows, several entities still empty, nothing archived. Every list must render its designed empty/near-empty state.",
  "gen-b": "DENSE world: a mature account months in — long lists (20+ rows where plausible), pagination-worthy volumes, several completed/archived items, multiple actors.",
  "gen-c": "ADVERSARIAL-EDGE world: legal but awkward data — longest plausible names/titles, zero-and-maximum numeric values, boundary dates, unicode text, entities mid-transition between states.",
};

interface CheckRun {
  walk: string;
  world: string;
  ok: boolean;
  failedAt?: number;
  detail?: string;
}

export interface CheckReport {
  scored: AffordanceScore[];
  selected: AffordanceScore[];
  runs: CheckRun[];
  optimisations: { journey: string; kind: string; proposal: string; evidence: string; level: "mock" | "structural" }[];
  claims: number;
}

export async function runCheck(argv: string[]): Promise<void> {
  const cwd = resolve(argFlag(argv, "--cwd") ?? ".");
  const dryRun = argv.includes("--dry-run");
  const regenWorlds = argv.includes("--regen-worlds");
  const mock = loadMockShapeConfig(cwd);
  const jdir = resolve(cwd, ".brewing/journeys");
  if (!existsSync(jdir)) { console.error("vibe check: no walk artifacts — run `vibe tell` first."); process.exit(1); }

  const walks: CompiledWalk[] = readdirSync(jdir)
    .filter((f) => f.endsWith(".qaplan.json"))
    .map((f) => JSON.parse(readFileSync(join(jdir, f), "utf8")) as CompiledWalk);
  if (walks.length === 0) { console.error("vibe check: no .qaplan.json walk artifacts — run `vibe tell` first."); process.exit(1); }

  const scored = scoreAffordances(walks);
  const selected = selectTopAffordances(scored);
  console.log(`vibe check — ${walks.length} walk(s), ${scored.length} affordance(s); top 20% = ${selected.length}:`);
  for (const s of selected) console.log(`  · ${s.id} (score ${s.score} — ${s.coverage} walk(s), best rank ${s.bestRank})`);
  if (dryRun) return;

  const apiKey = process.env["ANTHROPIC_API_KEY"];
  const llm = apiKey ? new AnthropicClient(apiKey) : null;
  const model = argFlag(argv, "--model") ?? "claude-opus-4-8";
  let totalUsd = 0;

  // 2. generated worlds (cached unless --regen-worlds)
  const worldsDir = resolve(cwd, mock.worlds_dir);
  mkdirSync(worldsDir, { recursive: true });
  const schemaPath = resolve(cwd, mock.mock_root, "src/lib/schema.ts");
  const schemaTs = existsSync(schemaPath) ? readFileSync(schemaPath, "utf8") : "";
  for (const [world, brief] of Object.entries(WORLD_BRIEFS)) {
    const p = join(worldsDir, `${world}.ts`);
    if (existsSync(p) && !regenWorlds) continue;
    if (!llm) { console.log(`  (no ANTHROPIC_API_KEY — world ${world} not generated; replays limited to existing worlds)`); continue; }
    console.log(`  generating world ${world}…`);
    const res = await llm.complete({
      system: SEED_SYSTEM,
      model,
      maxTokens: 32000,
      stream: true,
      messages: [{ role: "user", content: `## Generated Drizzle schema\n\`\`\`ts\n${schemaTs}\n\`\`\`\n\n## WORLD BRIEF (override the default density guidance)\n${brief}\n\nWrite seed.ts now — but name the exported function seedWorld and import type { DB } from "../db" (this file lives in src/lib/worlds/).` }],
    });
    totalUsd += res.costUsd;
    writeFileSync(p, res.text.replace(/```(?:ts|typescript)?\n?/g, "").replace(/```/g, ""));
  }

  // 3. replays: each selected affordance's shortest walk × each generated world
  const walkById = new Map(walks.map((w) => [w.walkId, w]));
  const baseUrl = argFlag(argv, "--base-url") ?? "http://localhost:5173";
  const { driver } = await selectDriver({ need: { actions: "full" }, prefer: "playwright" });
  const runs: CheckRun[] = [];
  const claims: BackpropClaim[] = [];
  const generatedWorlds = Object.keys(WORLD_BRIEFS).filter((w) => existsSync(join(worldsDir, `${w}.ts`)));
  const toReplay = new Set(selected.map((s) => s.shortestWalk));
  for (const walkId of toReplay) {
    const w = walkById.get(walkId);
    if (!w) continue;
    for (const world of generatedWorlds) {
      const plan = retargetPlan(w, world, baseUrl);
      const result = await replayPlan(driver, plan);
      runs.push({ walk: walkId, world, ok: result.ok, failedAt: result.failedAt, detail: result.steps.at(-1)?.detail?.slice(0, 200) });
      console.log(`  ${result.ok ? "✓" : "✗"} ${walkId} @ ${world}${result.ok ? "" : ` — ${result.steps.at(-1)?.detail?.slice(0, 80)}`}`);
      if (!result.ok) {
        claims.push({
          target: "wire",
          summary: `walk ${walkId} breaks in a fresh ${world} world`,
          detail: `Replaying the walk in a generated world variant failed at plan step ${result.failedAt}: ${result.steps.at(-1)?.detail}\n\nThe UI holds for the story-built data but not for ${world}'s shape (${WORLD_BRIEFS[world]}). The layout/affordance likely assumes the walked data.`,
          source: `check:${walkId}:${world}`,
        });
      }
    }
  }

  // 4. ux-optimising — the two questions, measured
  let optimisations: CheckReport["optimisations"] = [];
  if (llm) {
    const critical = [...new Set(selected.map((s) => walkById.get(s.shortestWalk)?.journeyId).filter(Boolean))] as string[];
    const clickCost = (jid: string) => walks.filter((w) => w.journeyId === jid).map((w) => ({ walk: w.walkId, interactions: w.plan.steps.filter((s) => s.action === "click" || s.action === "fill").length }));
    const patterns = repeatedPatterns(walks);
    const user = critical.map((jid) => `## Journey ${jid}\nclick cost: ${JSON.stringify(clickCost(jid))}\nrecurring step patterns (across ALL walks): ${JSON.stringify(patterns.slice(0, 8))}`).join("\n\n");
    const res = await llm.complete({ system: UX_OPTIMISE_SYSTEM, model, maxTokens: 8000, stream: true, messages: [{ role: "user", content: user + "\n\nAnswer the two questions per journey now." }] });
    totalUsd += res.costUsd;
    try {
      optimisations = JSON.parse(res.text.replace(/```(?:json)?\n?/g, "").replace(/```/g, "").trim()) as CheckReport["optimisations"];
    } catch { console.log("  (ux-optimise output was not valid JSON — skipped)"); }
    for (const o of optimisations.filter((o) => o.level === "structural")) {
      claims.push({ target: "concept", summary: `ux-optimise: ${o.proposal.slice(0, 90)}`, detail: `${o.proposal}\n\nEvidence: ${o.evidence}\n\nStructural — needs a ruling on the ${"concept"}/wireframe before the mock can apply it.`, source: `check:ux:${o.journey}` });
    }
  }

  const filed = claims.length > 0 ? await fileBackpropClaims(cwd, claims) : { mirrored: 0, issued: 0, skippedDuplicates: 0 };
  const report: CheckReport = { scored, selected, runs, optimisations, claims: filed.mirrored };
  writeFileSync(join(jdir, "check-report.json"), JSON.stringify(report, null, 2) + "\n");

  const failed = runs.filter((r) => !r.ok).length;
  console.log(`\nvibe check — ${runs.length} replay(s), ${failed} failure(s); ${optimisations.length} optimisation proposal(s) (${optimisations.filter((o) => o.level === "mock").length} mock-level for tell, ${optimisations.filter((o) => o.level === "structural").length} structural → claims); ${filed.mirrored} claim(s) filed`);
  console.log(`  report: .brewing/journeys/check-report.json`);
  if (totalUsd > 0) console.log("\n" + formatCostFooter(totalUsd, []));
  if (failed > 0) process.exit(1);
}

/** Same plan, different world: swap the ?world= on the entry goto and drop
 *  world-sensitive data asserts (structure must hold; this world's rows differ). */
export function retargetPlan(w: CompiledWalk, world: string, baseUrl: string): QaPlan {
  const worldSensitive = new Set(
    w.plan.steps
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.action === "assert" && /__slowcook\.data\./.test(s.expr ?? "") )
      .map(({ i }) => i),
  );
  return {
    name: `${w.plan.name}@${world}`,
    baseUrl,
    steps: w.plan.steps
      .filter((_, i) => !worldSensitive.has(i))
      .map((s) => (s.action === "goto" && s.url?.includes("world=")
        ? { ...s, url: s.url.replace(/world=[^&]+/, `world=${encodeURIComponent(world)}`) }
        : s.action === "screenshot"
          ? { ...s, path: s.path?.replace(/\.png$/, `.${world}.png`) }
          : s)),
  };
}

/** Recurring interaction patterns across walks: consecutive (route,affordance)
 *  pairs seen in ≥2 walks — the fold-into-defaults signal. */
export function repeatedPatterns(walks: CompiledWalk[]): { pattern: string; walks: number }[] {
  const counts = new Map<string, Set<string>>();
  for (const w of walks) {
    const seq = w.affordances.map((a) => `${a.route}#${a.id}`);
    for (let i = 0; i + 1 < seq.length; i++) {
      const key = `${seq[i]} → ${seq[i + 1]}`;
      (counts.get(key) ?? counts.set(key, new Set()).get(key)!).add(w.walkId);
    }
  }
  return [...counts.entries()]
    .map(([pattern, ws]) => ({ pattern, walks: ws.size }))
    .filter((p) => p.walks >= 2)
    .sort((a, b) => b.walks - a.walks);
}
