/**
 * `slowcook vibe tell` — the STORYTELLER (P3). Walks journeys, builds the
 * mock one affordance at a time, seeds data by walking, and leaves behind:
 *   - the built pages (branded, adaptor-wired, doctrine-clean)
 *   - .brewing/journeys/<walk-id>.qaplan.json  (replayable walk artifacts)
 *   - .brewing/journeys/shots/…                (per-step screenshots)
 *   - mock/src/lib/worlds/<journey>.ts         (the world the walk produced)
 *   - EPSS entries + testing-surfaces.json     (bifurcations become states)
 *   - backprop claims for unbuildable steps
 *
 * The loop enforces the five laws mechanically: the compiled plan carries
 * the story clock + acceptance asserts (walks.ts); this file adds the
 * build→USE→return cycle — a step whose affordance is missing triggers ONE
 * builder call, then the walk re-runs from the top (replay-so-far, cheap:
 * plans are short) before the story continues.
 */
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { AnthropicClient, TELL_STEP_SYSTEM, formatCostFooter } from "@slowcook-ai/llm-anthropic";
import { loadMockShapeConfig } from "../../lib/mock-shape.js";
import { fileBackpropClaims } from "../../lib/backprop.js";
import { selectDriver } from "../../lib/browser/select.js";
import { replayPlan, type QaPlan, type ReplayHooks } from "../../lib/browser/qa-replay.js";
import { JourneysFileSchema, type Journey } from "./journeys-schema.js";
import { compileWalkPlan, scheduleWalks, type CompiledWalk, type ScheduledWalk } from "./walks.js";
import { parseVibeOutput, writeVibeFiles } from "./emit.js";
import { loadPlan } from "./index.js";
import { mergeJourneyEpss } from "./lcr-plan.js";

const argFlag = (argv: string[], flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

interface TellCtx {
  cwd: string;
  mockRoot: string;
  baseUrl: string;
  model: string;
  llm: AnthropicClient | null;
  maxRepair: number;
  totalUsd: number;
  noDeploy: boolean;
}

export async function runTell(argv: string[]): Promise<void> {
  const cwd = resolve(argFlag(argv, "--cwd") ?? ".");
  const only = argFlag(argv, "--journey");
  const dryRun = argv.includes("--dry-run");
  const diceSeed = Number(argFlag(argv, "--seed") ?? 1);
  const clockStart = argFlag(argv, "--clock-start") ?? "2026-01-05T09:00:00.000Z";

  const mock = loadMockShapeConfig(cwd);
  const journeysPath = resolve(cwd, mock.journeys_file);
  if (!existsSync(journeysPath)) {
    console.error(`vibe tell: ${mock.journeys_file} not found — run \`vibe journeys\` first.`);
    process.exit(1);
  }
  const file = JourneysFileSchema.parse(parseYaml(readFileSync(journeysPath, "utf8")));

  let schedule = scheduleWalks(file, diceSeed);
  if (only) {
    schedule = schedule.filter((w) => w.journeyId === only);
    if (schedule.length === 0) { console.error(`vibe tell: journey "${only}" not found.`); process.exit(1); }
  }

  console.log(`vibe tell — ${schedule.length} walk(s) scheduled (dice seed ${diceSeed}):`);
  for (const w of schedule) console.log(`  · ${w.walkId}  [world: ${w.journey.start_world}]`);
  if (dryRun) return;

  const apiKey = process.env["ANTHROPIC_API_KEY"];
  const ctx: TellCtx = {
    cwd,
    mockRoot: resolve(cwd, mock.mock_root),
    baseUrl: argFlag(argv, "--base-url") ?? "http://localhost:5173",
    model: argFlag(argv, "--model") ?? "claude-opus-4-8",
    llm: apiKey ? new AnthropicClient(apiKey) : null,
    maxRepair: 2,
    totalUsd: 0,
    noDeploy: argv.includes("--no-deploy"),
  };
  if (!ctx.llm) console.log("  (no ANTHROPIC_API_KEY — walk-only mode: missing affordances halt with a claim instead of building)");

  const server = argFlag(argv, "--base-url") ? null : startDevServer(ctx);
  try {
    if (server) await waitForServer(ctx.baseUrl);
    let clock = clockStart;
    for (const w of schedule) {
      const done = await tellWalk(ctx, w, clock, diceSeed);
      if (done) clock = done.clock.end; // walks stack chronologically (law 1)
    }
  } finally {
    server?.kill();
  }
  if (ctx.totalUsd > 0) console.log("\n" + formatCostFooter(ctx.totalUsd, []));
}

/* ────────────────────────────── one walk: build → USE → return, per step */

async function tellWalk(ctx: TellCtx, w: ScheduledWalk, clockStart: string, diceSeed: number): Promise<CompiledWalk | null> {
  const shotsDir = resolve(ctx.cwd, ".brewing/journeys/shots");
  mkdirSync(shotsDir, { recursive: true });
  const compiled = compileWalkPlan(w.journey, w.branchId, {
    baseUrl: ctx.baseUrl,
    shotsDir,
    clockStart,
    diceSeed,
  });

  console.log(`\n▶ ${compiled.walkId} — "${w.journey.title}" (${compiled.plan.steps.length} plan steps, world ${compiled.world})`);
  const { driver } = await selectDriver({ need: { actions: "full" }, prefer: "playwright" });

  let repairs = 0;
  for (;;) {
    const result = await replayPlan(driver, compiled.plan, tellHooks());
    if (result.ok) break;
    const failed = compiled.plan.steps[result.failedAt!]!;
    const missingAffordance = failed.action === "assert" && /data-affordance/.test(failed.expr ?? "");
    if (missingAffordance && ctx.llm) {
      const affId = /data-affordance=\\"([^"\\]+)/.exec(failed.expr ?? "")?.[1] ?? "";
      const step = findStepByAffordance(w.journey, affId);
      if (!step) { await halt(ctx, compiled, `affordance "${affId}" has no journey step`); return null; }
      console.log(`  ✎ building affordance "${affId}" on ${step.route} …`);
      const ok = await buildAffordance(ctx, w.journey, step);
      if (!ok) { await halt(ctx, compiled, `builder could not produce affordance "${affId}"`); return null; }
      continue; // re-run the walk from the top — build → USE (law 4)
    }
    repairs++;
    if (repairs > ctx.maxRepair || !ctx.llm) {
      await halt(ctx, compiled, `step ${result.failedAt} failed: ${result.steps.at(-1)?.detail ?? "unknown"}`);
      return null;
    }
    console.log(`  ⟳ repair round ${repairs}: ${result.steps.at(-1)?.detail?.slice(0, 120)}`);
    const step = stepAtPlanIndex(w.journey, compiled, result.failedAt!);
    const ok = step ? await buildAffordance(ctx, w.journey, step, result.steps.at(-1)?.detail) : false;
    if (!ok) { await halt(ctx, compiled, `repair failed at plan step ${result.failedAt}`); return null; }
  }

  console.log(`  ✓ walk green — ${compiled.affordances.length} affordance(s) exercised`);
  persistWalk(ctx, compiled, w.journey);
  return compiled;
}

function tellHooks(): ReplayHooks {
  // P4 wires runTellGates here; guarded so P3 stands alone.
  return {
    afterStep: async (_i, step, page) => {
      if (step.action !== "goto") return;
      try {
        const gates = (await import("@slowcook-ai/gates")) as { runTellGates?: (page: unknown) => Promise<{ gate: string; selector: string; evidence: string }[]> };
        if (!gates.runTellGates) return;
        const violations = await gates.runTellGates(page);
        if (violations.length > 0) {
          throw new Error(`gates: ${violations.map((v) => `${v.gate}(${v.selector}): ${v.evidence}`).join(" · ").slice(0, 300)}`);
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("gates:")) throw e;
        /* gates package absent/old — skip */
      }
    },
  };
}

/* ────────────────────────────── the builder (law 4: ONE affordance) */

async function buildAffordance(ctx: TellCtx, journey: Journey, step: { id: string; text: string; route: string; affordance?: string; action: string; destructive?: boolean; expect: { expr: string }[] }, failureDetail?: string): Promise<boolean> {
  if (!ctx.llm) return false;
  const pagePath = routeToPagePath(ctx, step.route);
  const pageSrc = pagePath && existsSync(pagePath) ? readFileSync(pagePath, "utf8") : "(no page file found — create it)";
  const queriesPath = join(ctx.mockRoot, "src/lib/queries.ts");
  const queriesSrc = existsSync(queriesPath) ? readFileSync(queriesPath, "utf8") : "(queries.ts missing)";
  const user = [
    `## Journey`, `${journey.id} — ${journey.title} (persona: ${journey.persona})`,
    `## The step to build`,
    JSON.stringify({ id: step.id, text: step.text, route: step.route, action: step.action, affordance: step.affordance, destructive: step.destructive ?? false, expect: step.expect }, null, 2),
    failureDetail ? `## Previous attempt failed\n${failureDetail}` : "",
    `## Current page source (${pagePath ?? "unknown"})`, "```tsx", pageSrc.slice(0, 24000), "```",
    `## Data adaptor (mock/src/lib/queries.ts)`, "```ts", queriesSrc.slice(0, 24000), "```",
    `\nBuild the affordance now.`,
  ].join("\n");
  const res = await ctx.llm.complete({ system: TELL_STEP_SYSTEM, model: ctx.model, maxTokens: 32000, stream: true, messages: [{ role: "user", content: user }] });
  ctx.totalUsd += res.costUsd;
  const out = parseVibeOutput(res.text);
  if (out.files.length === 0) return false;
  writeVibeFiles(ctx.cwd, out.files);
  return true;
}

/* ────────────────────────────── persistence + handoff */

function persistWalk(ctx: TellCtx, compiled: CompiledWalk, journey: Journey): void {
  const dir = resolve(ctx.cwd, ".brewing/journeys");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${compiled.walkId}.qaplan.json`), JSON.stringify(compiled, null, 2) + "\n");

  // EPSS: bifurcations become states; regenerate the palette when possible.
  const plan = loadPlan(ctx.cwd);
  if (plan) {
    const branches = (journey.steps.flatMap((s) => s.branches ?? [])).map((b) => ({ id: b.id, given: b.given, entryRoute: b.steps[0]?.route ?? "/" }));
    const merged = mergeJourneyEpss(plan, journey, branches);
    writeFileSync(resolve(ctx.cwd, ".brewing/lcr-plan.json"), JSON.stringify(merged, null, 2) + "\n");
  }

  // The world this walk leaves behind (law 3): main walks snapshot on green.
  // (The walker dumps via the page seam during replay is future work; here we
  // record the world lineage so `vibe check` can rebuild it by replaying.)
  if (!ctx.noDeploy) {
    try {
      execSync(`git -C ${JSON.stringify(ctx.cwd)} add -A ${JSON.stringify(ctx.mockRoot)} .brewing/journeys .brewing/lcr-plan.json`, { stdio: "ignore" });
      execSync(`git -C ${JSON.stringify(ctx.cwd)} commit -q -m ${JSON.stringify(`tell(${compiled.walkId}): journey walked green — ${compiled.affordances.length} affordance(s)`)}`, { stdio: "ignore" });
      console.log(`  committed — the run-mock auto-pull / preview deploy picks it up`);
    } catch { /* nothing to commit or not a repo — fine */ }
  }
}

async function halt(ctx: TellCtx, compiled: CompiledWalk, why: string): Promise<void> {
  console.error(`  ✗ ${compiled.walkId} halted: ${why}`);
  await fileBackpropClaims(ctx.cwd, [{
    target: "concept",
    summary: `walk ${compiled.walkId} unbuildable: ${why.slice(0, 100)}`,
    detail: `The storyteller could not complete this walk.\n\n${why}\n\nEither the journey step under-specifies the affordance, or the upstream artifact is missing the concept this step needs.`,
    source: compiled.walkId,
  }]);
}

/* ────────────────────────────── small helpers */

function findStepByAffordance(j: Journey, affId: string) {
  const all = (steps: Journey["steps"]): Journey["steps"][number] | null => {
    for (const s of steps) {
      if (s.affordance === affId) return s;
      for (const b of s.branches ?? []) { const hit = all(b.steps); if (hit) return hit; }
    }
    return null;
  };
  return all(j.steps);
}

function stepAtPlanIndex(j: Journey, compiled: CompiledWalk, planIdx: number) {
  // walk the plan backwards to the nearest affordance assert; map to its step
  for (let i = planIdx; i >= 0; i--) {
    const s = compiled.plan.steps[i]!;
    const m = s.expr && /data-affordance=\\"([^"\\]+)/.exec(s.expr);
    if (m) return findStepByAffordance(j, m[1]!);
  }
  return null;
}

function routeToPagePath(ctx: TellCtx, route: string): string | null {
  // vibe app scaffolds one page per route under src/pages; try common names.
  const base = join(ctx.mockRoot, "src/pages");
  const stem = route === "/" ? "index" : route.replace(/^\//, "").replace(/\//g, "-").replace(/:/g, "");
  const candidates = [
    join(base, `${stem}.tsx`),
    join(base, `${stem[0]?.toUpperCase()}${stem.slice(1)}.tsx`),
    join(base, stem, "index.tsx"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0] ?? null;
}

function startDevServer(ctx: TellCtx): ChildProcess {
  console.log(`  starting mock dev server (${ctx.mockRoot})…`);
  return spawn("npm", ["run", "dev"], { cwd: ctx.mockRoot, stdio: "ignore", detached: false });
}

async function waitForServer(url: string, timeoutMs = 60_000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(url); if (r.ok || r.status < 500) return; } catch { /* not up yet */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`mock dev server did not answer at ${url}`);
    await new Promise((r) => setTimeout(r, 800));
  }
}
