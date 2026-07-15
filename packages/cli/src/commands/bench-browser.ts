// `slowcook bench-browser [eye|qa|both] [--iters N] [--plan file.json]`
// Honest comparison of the two browser engines on slowcook's own workloads —
// each engine in its own process (RSS is order-dependent otherwise), same
// browser where PW_EXECUTABLE_PATH/RUSTWRIGHT_CHROMIUM point at one. Playwright
// is the oracle; the QA run reports pass/fail agreement.
import { readFileSync } from "node:fs";
import { runBench, formatReport } from "../lib/browser/bench.js";
import type { QaPlan } from "../lib/browser/qa-replay.js";

export async function benchBrowser(args: string[], _version: string): Promise<void> {
  const which = args[0] && !args[0].startsWith("--") ? args[0] : "both";
  const itersArg = args.indexOf("--iters");
  const iterations = itersArg >= 0 ? Math.max(1, Number(args[itersArg + 1]) || 8) : 8;
  const planArg = args.indexOf("--plan");
  const plan: QaPlan | undefined = planArg >= 0 ? JSON.parse(readFileSync(args[planArg + 1]!, "utf8")) as QaPlan : undefined;

  const kinds: ("eye" | "qa")[] = which === "eye" ? ["eye"] : which === "qa" ? ["qa"] : ["eye", "qa"];
  console.log("browser-engine benchmark — playwright (default/oracle) vs rustwright (option)");
  console.log("tip: point both at one browser via PW_EXECUTABLE_PATH + RUSTWRIGHT_CHROMIUM for apples-to-apples\n");
  let anyDisagree = false;
  for (const kind of kinds) {
    const report = await runBench(kind, { iterations, plan });
    console.log(formatReport(report));
    console.log();
    if (report.agreement !== null && report.agreement < 1) anyDisagree = true;
  }
  // a QA-replay engine that disagrees with the oracle is not adoptable — signal it.
  if (anyDisagree) { console.error("⚠ rustwright disagreed with the Playwright oracle on some runs — do not default it for QA until this is understood."); process.exitCode = 1; }
}
