// Driver selection (2026-07-16) — Playwright is the default + failover; rustwright
// is chosen only when explicitly preferred AND its capabilities fit the workload
// AND it's installed. Anything else falls back to Playwright, with a reason.
import { playwrightDriver } from "./playwright-driver.js";
import { rustwrightDriver, rustwrightAvailable } from "./rustwright-driver.js";
import { satisfies, type BrowserDriver, type DriverNeed } from "./driver.js";

export interface SelectOptions {
  /** what the workload requires; an engine is only picked if it satisfies all. */
  need?: DriverNeed;
  /** caller's preference; overridden by env SLOWCOOK_BROWSER. Default: playwright. */
  prefer?: "playwright" | "rustwright";
  /** override the env lookup (tests). */
  env?: NodeJS.ProcessEnv;
}

export interface Selection {
  driver: BrowserDriver;
  /** true when the preferred engine was used; false when we failed over. */
  usedPreferred: boolean;
  /** human-readable why, for logs. */
  reason: string;
}

/** Resolve which engine to use. env SLOWCOOK_BROWSER (playwright|rustwright) wins
 *  over `prefer`; the result is Playwright unless rustwright is preferred, fits,
 *  and is installed. NEVER throws for a missing rustwright — it fails over. */
export async function selectDriver(opts: SelectOptions = {}): Promise<Selection> {
  const env = opts.env ?? process.env;
  const envChoice = env["SLOWCOOK_BROWSER"]?.trim().toLowerCase();
  const requested = envChoice === "rustwright" || envChoice === "playwright"
    ? envChoice
    : (opts.prefer ?? "playwright");
  const need = opts.need ?? {};

  if (requested !== "rustwright") {
    return { driver: playwrightDriver(), usedPreferred: true, reason: "playwright (default)" };
  }

  // rustwright requested — only if it fits the need AND is installed.
  const rw = rustwrightDriver();
  if (!satisfies(rw.caps, need)) {
    return { driver: playwrightDriver(), usedPreferred: false, reason: `rustwright can't satisfy ${JSON.stringify(need)} — using playwright` };
  }
  if (!(await rustwrightAvailable())) {
    return { driver: playwrightDriver(), usedPreferred: false, reason: "rustwright not installed — using playwright" };
  }
  return { driver: rw, usedPreferred: true, reason: "rustwright (preferred, fits)" };
}
