// QA replay (2026-07-16) — rerun a recorded manual QA session automatically. A
// plan is a sequence of steps (navigate / click / fill / assert / screenshot),
// the shape a QA breadcrumb trail reduces to. It runs through the driver seam,
// so the SAME plan can execute on Playwright (oracle) or rustwright (fast, light)
// and their pass/fail can be cross-checked. This is the workload where
// rustwright's footprint win is decisive — many short, isolated replays.
import type { BrowserDriver, DriverNeed } from "./driver.js";
import { selectDriver } from "./select.js";

export interface QaStep {
  action: "goto" | "click" | "fill" | "assert" | "screenshot" | "wait";
  /** goto */ url?: string;
  /** click/fill/assert */ selector?: string;
  /** fill */ value?: string;
  /** assert: a JS expression evaluated in the page; must be truthy (or === expect). */
  expr?: string;
  expect?: unknown;
  /** screenshot */ path?: string;
  /** wait */ ms?: number;
}

export interface QaPlan {
  name: string;
  /** prepended to a step's `url` when it's a path, not absolute. */
  baseUrl?: string;
  steps: QaStep[];
}

export interface StepResult { i: number; action: string; ok: boolean; detail?: string }
export interface ReplayResult {
  plan: string;
  driver: string;
  ok: boolean;
  ms: number;
  steps: StepResult[];
  /** the step that failed, if any. */
  failedAt?: number;
}

/** The capabilities a plan requires — only click+fill actions here, so "basic"
 *  suffices (rustwright fits); screenshots/evaluate are in both engines. */
export function planNeed(_plan: QaPlan): DriverNeed {
  return { actions: "basic" };
}

const abs = (base: string | undefined, url: string) =>
  /^[a-z]+:\/\//i.test(url) || url.startsWith("data:") ? url : `${(base ?? "").replace(/\/$/, "")}${url.startsWith("/") ? "" : "/"}${url}`;

/** Optional per-step hooks — the storyteller (vibe tell) runs page gates
 *  after each step; absent hooks change nothing. */
export interface ReplayHooks {
  /** Runs after a step SUCCEEDS, with the live page. Throwing fails the step. */
  afterStep?: (i: number, step: QaStep, page: import("./driver.js").DriverPage) => Promise<void>;
}

/** Replay a plan on a driver. Stops at the first failed step (like a real test),
 *  returns a per-step trace + total wall-time. */
export async function replayPlan(driver: BrowserDriver, plan: QaPlan, hooks?: ReplayHooks): Promise<ReplayResult> {
  const t0 = Date.now();
  const steps: StepResult[] = [];
  const session = await driver.launch();
  const page = await session.newPage();
  let ok = true;
  let failedAt: number | undefined;
  try {
    for (let i = 0; i < plan.steps.length; i++) {
      const s = plan.steps[i]!;
      try {
        switch (s.action) {
          case "goto": {
            const target = abs(plan.baseUrl, s.url ?? "");
            // already standing there (a click navigated honestly): a same-URL
            // goto would RELOAD and wipe the session's events — skip it.
            // Narrow ONCE. Casting to `{ url: () => string }` (required) does
            // not compile: DriverPage has no `url`, so TS rejects the assertion
            // outright (TS2352) — and the whole cli build fails with it. Only
            // the optional-shaped cast is legal; reuse it via a local.
            const pageUrl = (page as { url?: () => string }).url;
            if (typeof pageUrl === "function" && pageUrl.call(page) === target) break;
            await page.goto(target, { waitUntil: "load" });
            break;
          }
          case "click": await page.click(s.selector ?? ""); break;
          case "fill": await page.fill(s.selector ?? "", s.value ?? ""); break;
          case "wait": await page.waitFor(s.ms ?? 100); break;
          case "screenshot": await page.screenshot({ path: s.path, fullPage: true }); break;
          case "assert": {
            const got = await page.evaluate(s.expr ?? "false");
            const pass = "expect" in s ? JSON.stringify(got) === JSON.stringify(s.expect) : !!got;
            if (!pass) throw new Error(`assert failed: ${s.expr} → ${JSON.stringify(got)}${"expect" in s ? ` (expected ${JSON.stringify(s.expect)})` : ""}`);
            break;
          }
        }
        if (hooks?.afterStep) await hooks.afterStep(i, s, page);
        steps.push({ i, action: s.action, ok: true });
      } catch (e) {
        ok = false; failedAt = i;
        steps.push({ i, action: s.action, ok: false, detail: e instanceof Error ? e.message : String(e) });
        break; // stop at first failure
      }
    }
  } finally {
    await page.close().catch(() => { /* ignore */ });
    await session.close().catch(() => { /* ignore */ });
  }
  return { plan: plan.name, driver: driver.name, ok, ms: Date.now() - t0, steps, failedAt };
}

/** Replay a plan on the PROVEN-DEFAULT engine for QA replay: rustwright when it
 *  fits + is installed (the ~65%-lighter footprint that matters for a fleet),
 *  else Playwright (failover). Override with env SLOWCOOK_BROWSER. */
export async function replayPlanAuto(plan: QaPlan, env?: NodeJS.ProcessEnv): Promise<ReplayResult & { engine: string; failover: boolean }> {
  const sel = await selectDriver({ need: planNeed(plan), prefer: "rustwright", env });
  const r = await replayPlan(sel.driver, plan);
  return { ...r, engine: sel.driver.name, failover: !sel.usedPreferred };
}
