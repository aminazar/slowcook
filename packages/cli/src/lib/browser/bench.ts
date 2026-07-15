// Browser-driver benchmark (2026-07-16) — the honest comparison that decides a
// default. Forks a FRESH process per engine (peak RSS is order-dependent within a
// process, so it must be isolated), runs the same workload, and reports wall-time,
// peak driver RSS, and — for QA replay — pass/fail AGREEMENT vs the Playwright
// oracle. Turns the vendor's Python "local diagnostic" into real Node evidence on
// slowcook's own workloads.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { rustwrightAvailable } from "./rustwright-driver.js";
import type { QaPlan } from "./qa-replay.js";

export interface BenchRow { engine: string; iterations: number; totalMs: number; msPerIter: number; peakRssMiB: number; oks: boolean[] }
export interface BenchReport {
  kind: "eye" | "qa";
  rows: BenchRow[];
  /** rustwright-vs-playwright pass/fail agreement (qa only); null if single-engine. */
  agreement: number | null;
  note: string;
}

const workerPath = () => fileURLToPath(new URL("./bench-worker.js", import.meta.url));

function runOne(engine: "playwright" | "rustwright", kind: "eye" | "qa", n: number, plan?: QaPlan): Promise<BenchRow> {
  return new Promise((resolve, reject) => {
    const args = [engine, kind, String(n), ...(plan ? [JSON.stringify(plan)] : [])];
    const child = fork(workerPath(), args, { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let out = ""; let err = "";
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { err += d; });
    child.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`${engine} worker failed: ${err.trim() || `exit ${code}`}`));
      try { const j = JSON.parse(out.trim().split("\n").pop() ?? "{}") as Omit<BenchRow, "msPerIter">; resolve({ ...j, msPerIter: Math.round(j.totalMs / j.iterations) }); }
      catch { reject(new Error(`${engine} worker output unparseable: ${out.slice(0, 200)}`)); }
    });
  });
}

/** Run a workload on both engines (each in its own process) and compare.
 *  rustwright is skipped (with a note) when not installed. */
export async function runBench(kind: "eye" | "qa", opts: { iterations?: number; plan?: QaPlan } = {}): Promise<BenchReport> {
  const n = opts.iterations ?? 8;
  const pw = await runOne("playwright", kind, n, opts.plan);
  if (!(await rustwrightAvailable())) {
    return { kind, rows: [pw], agreement: null, note: "rustwright not installed — Playwright only" };
  }
  const rw = await runOne("rustwright", kind, n, opts.plan);
  const agreement = kind === "qa" ? agreementOf(pw.oks, rw.oks) : null;
  const note = kind === "qa" ? `oracle agreement ${Math.round((agreement ?? 0) * 100)}% over ${n} runs` : `${n} captures each`;
  return { kind, rows: [pw, rw], agreement, note };
}

/** fraction of iterations where the two engines produced the same pass/fail. */
export function agreementOf(a: boolean[], b: boolean[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 1;
  let same = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) same++;
  return same / n;
}

export function formatReport(r: BenchReport): string {
  const head = "engine       iters   total(ms)  ms/iter  peak RSS(MiB)";
  const body = r.rows.map((x) => `${x.engine.padEnd(12)} ${String(x.iterations).padStart(5)}   ${String(x.totalMs).padStart(8)}  ${String(x.msPerIter).padStart(7)}  ${String(x.peakRssMiB).padStart(12)}`).join("\n");
  const delta = r.rows.length === 2
    ? `\nΔ rustwright vs playwright: ${pct(r.rows[1]!.totalMs, r.rows[0]!.totalMs)} time · ${pct(r.rows[1]!.peakRssMiB, r.rows[0]!.peakRssMiB)} RSS`
    : "";
  return `[${r.kind}] ${r.note}\n${head}\n${body}${delta}`;
}

const pct = (candidate: number, base: number) => {
  const d = Math.round(((candidate - base) / base) * 100);
  return d <= 0 ? `${d}%` : `+${d}%`;
};
