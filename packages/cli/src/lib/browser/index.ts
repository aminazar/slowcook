// Browser-driver seam — public surface.
export type { BrowserDriver, DriverSession, DriverPage, DriverCaps, DriverNeed, EmuOptions, WaitUntil } from "./driver.js";
export { satisfies } from "./driver.js";
export { playwrightDriver } from "./playwright-driver.js";
export { rustwrightDriver, rustwrightAvailable } from "./rustwright-driver.js";
export { selectDriver, type SelectOptions, type Selection } from "./select.js";
export { replayPlan, replayPlanAuto, planNeed, type QaPlan, type QaStep, type ReplayResult, type StepResult } from "./qa-replay.js";
export { runBench, agreementOf, formatReport, type BenchReport, type BenchRow } from "./bench.js";
