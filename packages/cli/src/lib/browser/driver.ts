// Browser-driver seam (2026-07-16) — one interface, two engines. Playwright is
// the DEFAULT and the failover; rustwright is an OPTION selected per-workload
// only where its capabilities fit (see select.ts). The seam exists because a
// benchmark on slowcook's own workloads showed rustwright's Node bindings are a
// ~65% smaller memory footprint but a speed tie (the vendor's 2.55× is a
// Python-driver-elimination that doesn't exist in Node) — so it's worth adopting
// where footprint matters (QA-replay fleets) and NOT where it can't fit without
// extra effort (the eye matrix needs contexts/emulation rustwright lacks).

/** Per-page emulation. Playwright honours all of it (via a context); rustwright
 *  IGNORES it (no context/emulation surface) — so a caller that NEEDS emulation
 *  must declare it so the selector routes to Playwright. */
export interface EmuOptions {
  colorScheme?: "light" | "dark";
  viewport?: { width: number; height: number };
  deviceScaleFactor?: number;
}

export type WaitUntil = "load" | "domcontentloaded" | "networkidle" | "commit";

/** The minimal page surface both engines implement — the subset slowcook uses
 *  (no locators/route/tracing; those aren't used anywhere in the codebase). */
export interface DriverPage {
  goto(url: string, opts?: { waitUntil?: WaitUntil }): Promise<void>;
  evaluate<T = unknown>(expression: string): Promise<T>;
  screenshot(opts: { path?: string; fullPage?: boolean }): Promise<Buffer>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  textContent(selector: string): Promise<string | null>;
  title(): Promise<string>;
  waitFor(ms: number): Promise<void>;
  close(): Promise<void>;
}

export interface DriverSession {
  /** A fresh page. `emu` is honoured only if `caps.emulation` is true. */
  newPage(emu?: EmuOptions): Promise<DriverPage>;
  close(): Promise<void>;
}

/** What an engine can do — the selector matches these against a workload's needs. */
export interface DriverCaps {
  /** per-page colorScheme/viewport/DPI (Playwright: yes; rustwright: no). */
  emulation: boolean;
  /** isolated browser contexts (Playwright: yes; rustwright: no → fresh browser per page). */
  contexts: boolean;
  /** "full" = keyboard/hover/press/etc; "basic" = click + fill only (rustwright). */
  actions: "full" | "basic";
}

export interface BrowserDriver {
  readonly name: "playwright" | "rustwright";
  readonly caps: DriverCaps;
  launch(): Promise<DriverSession>;
}

/** A workload's requirements; the selector will only pick an engine whose caps
 *  satisfy ALL of these, else it FAILS OVER to Playwright. */
export interface DriverNeed {
  emulation?: boolean;
  contexts?: boolean;
  actions?: "full" | "basic";
}

/** true if `caps` satisfies every stated need. */
export function satisfies(caps: DriverCaps, need: DriverNeed): boolean {
  if (need.emulation && !caps.emulation) return false;
  if (need.contexts && !caps.contexts) return false;
  if (need.actions === "full" && caps.actions !== "full") return false;
  return true;
}
