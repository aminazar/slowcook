// Rustwright driver — the OPTION. A native Rust CDP engine with a ~65% smaller
// Node-side memory footprint (benchmarked on slowcook's workloads), but a LIMITED
// surface: no contexts, no emulation, click+fill only. So it's loaded lazily
// (optionalDependency) and the selector only routes here when the workload's
// needs fit (see select.ts) — otherwise Playwright is used.
import type { BrowserDriver, DriverCaps, DriverPage, DriverSession, EmuOptions } from "./driver.js";

// rustwright can't emulate (newPage takes no options) and has no contexts; its
// action surface is click + fill only.
const CAPS: DriverCaps = { emulation: false, contexts: false, actions: "basic" };

// The minimal shape we use from rustwright's napi binding (kept local so the
// hard dependency stays optional + lazy).
interface RwPage {
  goto(url: string, opts?: { waitUntil?: string }): Promise<unknown>;
  evaluate(expr: string): Promise<unknown>;
  screenshot(opts?: { path?: string; fullPage?: boolean; type?: string }): Promise<Buffer>;
  click(selector: string, opts?: unknown): Promise<void>;
  fill(selector: string, value: string, opts?: unknown): Promise<void>;
  textContent(selector: string, opts?: unknown): Promise<string | null>;
  title(opts?: unknown): Promise<string>;
}
interface RwBrowser { newPage(): Promise<RwPage>; close(): Promise<void> }
interface RwModule { chromium: { launch(): Promise<RwBrowser> } }

/** true if the rustwright package is installed AND loads on this platform. */
export async function rustwrightAvailable(): Promise<boolean> {
  try { await import("rustwright" as string); return true; } catch { return false; }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function wrapPage(page: RwPage, onClose: () => Promise<void>): DriverPage {
  return {
    goto: async (url, opts) => { await page.goto(url, { waitUntil: opts?.waitUntil ?? "load" }); },
    evaluate: <T>(expr: string) => page.evaluate(expr) as Promise<T>,
    screenshot: (opts) => page.screenshot({ path: opts.path, fullPage: opts.fullPage ?? false }),
    click: (sel) => page.click(sel),
    fill: (sel, v) => page.fill(sel, v),
    textContent: (sel) => page.textContent(sel),
    title: () => page.title(),
    // rustwright has no waitForTimeout — a plain sleep is equivalent for
    // "let styles settle" waits.
    waitFor: (ms) => sleep(ms),
    close: onClose,
  };
}

export function rustwrightDriver(): BrowserDriver {
  return {
    name: "rustwright",
    caps: CAPS,
    async launch(): Promise<DriverSession> {
      const rw = (await import("rustwright" as string)) as unknown as RwModule;
      const browser = await rw.chromium.launch();
      return {
        // no contexts: each page is a bare newPage on the shared browser. `emu`
        // is IGNORED by design — the selector never routes an emulation-needing
        // workload here, so this only runs for needs that don't require it.
        async newPage(_emu?: EmuOptions): Promise<DriverPage> {
          const page = await browser.newPage();
          return wrapPage(page, async () => { /* rustwright pages close with the browser */ });
        },
        close: () => browser.close(),
      };
    },
  };
}
