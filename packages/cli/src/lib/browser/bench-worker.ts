// Benchmark worker (2026-07-16) — runs ONE engine's workload in THIS fresh
// process and prints a single JSON line. It MUST be its own process: peak RSS
// doesn't shrink after an engine loads, so measuring two engines in one process
// makes the footprint order-dependent (the trap that made an early micro-bench
// read a false 65%… which, measured per-process, turned out true anyway — but
// only because it's measured honestly here). argv: engine kind N [planJson].
// NOTE: the drivers are imported LAZILY (dynamic import of only the engine under
// test) — a static import of both would load Playwright's heavy client into the
// rustwright worker too, inflating its RSS and hiding the footprint difference.
import type { BrowserDriver } from "./driver.js";
import type { QaPlan } from "./qa-replay.js";

const EYE_URL = "data:text/html,<style>body{font-family:sans-serif}</style><h1>Eye</h1>" + "<p>row of content</p>".repeat(80);
const DEFAULT_PLAN: QaPlan = {
  name: "login smoke",
  steps: [
    { action: "goto", url: "data:text/html,<input id=e><button id=g onclick=\"window.__ok=true\">g</button>" },
    { action: "fill", selector: "#e", value: "a@b.c" },
    { action: "click", selector: "#g" },
    { action: "assert", expr: "window.__ok===true", expect: true },
    { action: "screenshot" },
  ],
};

async function main() {
  const engine = process.argv[2] === "rustwright" ? "rustwright" : "playwright";
  const kind = process.argv[3] === "qa" ? "qa" : "eye";
  const N = Number(process.argv[4] ?? 8);
  const plan: QaPlan = process.argv[5] ? JSON.parse(process.argv[5]) as QaPlan : DEFAULT_PLAN;
  const driver: BrowserDriver = engine === "rustwright"
    ? (await import("./rustwright-driver.js")).rustwrightDriver()
    : (await import("./playwright-driver.js")).playwrightDriver();

  const abs = (u: string) => /^[a-z]+:\/\//i.test(u) || u.startsWith("data:") ? u : `${(plan.baseUrl ?? "").replace(/\/$/, "")}${u.startsWith("/") ? "" : "/"}${u}`;
  let peak = 0; const track = () => { const r = process.memoryUsage().rss; if (r > peak) peak = r; };
  const oks: boolean[] = [];
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const s = await driver.launch(); const p = await s.newPage();
    let ok = true;
    try {
      if (kind === "eye") { await p.goto(EYE_URL, { waitUntil: "load" }); await p.screenshot({ fullPage: true }); }
      else {
        for (const step of plan.steps) {
          if (step.action === "goto") await p.goto(abs(step.url ?? ""), { waitUntil: "load" });
          else if (step.action === "click") await p.click(step.selector ?? "");
          else if (step.action === "fill") await p.fill(step.selector ?? "", step.value ?? "");
          else if (step.action === "wait") await p.waitFor(step.ms ?? 100);
          else if (step.action === "screenshot") await p.screenshot({ fullPage: true });
          else if (step.action === "assert") {
            const got = await p.evaluate(step.expr ?? "false");
            const pass = "expect" in step ? JSON.stringify(got) === JSON.stringify(step.expect) : !!got;
            if (!pass) { ok = false; break; }
          }
        }
      }
    } catch { ok = false; }
    oks.push(ok); track();
    await p.close().catch(() => {}); await s.close().catch(() => {});
  }
  track();
  process.stdout.write(JSON.stringify({ engine, kind, iterations: N, totalMs: Date.now() - t0, peakRssMiB: Math.round(peak / 1048576), oks }) + "\n");
}

void main().catch((e) => { process.stderr.write(String(e instanceof Error ? e.message : e) + "\n"); process.exit(1); });
