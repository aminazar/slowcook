// Playwright driver — the DEFAULT and the failover. Full capabilities: a fresh
// isolated context per page with colorScheme/viewport/DPI emulation.
import { chromium, type Browser, type Page } from "@playwright/test";
import type { BrowserDriver, DriverCaps, DriverPage, DriverSession, EmuOptions } from "./driver.js";

const CAPS: DriverCaps = { emulation: true, contexts: true, actions: "full" };

function wrapPage(page: Page, onClose: () => Promise<void>): DriverPage {
  return {
    goto: async (url, opts) => { await page.goto(url, { waitUntil: opts?.waitUntil ?? "load" }); },
    evaluate: <T>(expr: string) => page.evaluate(expr) as Promise<T>,
    screenshot: (opts) => page.screenshot({ path: opts.path, fullPage: opts.fullPage ?? false }),
    click: (sel) => page.click(sel),
    fill: (sel, v) => page.fill(sel, v),
    textContent: (sel) => page.textContent(sel),
    title: () => page.title(),
    waitFor: (ms) => page.waitForTimeout(ms),
    close: onClose,
  };
}

export function playwrightDriver(): BrowserDriver {
  return {
    name: "playwright",
    caps: CAPS,
    async launch(): Promise<DriverSession> {
      // PW_EXECUTABLE_PATH lets a benchmark pin the SAME browser both engines
      // drive (apples-to-apples); unset = Playwright's bundled Chromium.
      const exe = process.env["PW_EXECUTABLE_PATH"];
      const browser: Browser = await chromium.launch(exe ? { executablePath: exe } : {});
      return {
        async newPage(emu?: EmuOptions): Promise<DriverPage> {
          // a fresh context per page = isolation + emulation, exactly like the
          // eye matrix relies on (colorScheme + retina DPI).
          const ctx = await browser.newContext({
            ...(emu?.colorScheme ? { colorScheme: emu.colorScheme } : {}),
            ...(emu?.viewport ? { viewport: emu.viewport } : {}),
            ...(emu?.deviceScaleFactor ? { deviceScaleFactor: emu.deviceScaleFactor } : {}),
          });
          const page = await ctx.newPage();
          return wrapPage(page, () => ctx.close());
        },
        close: () => browser.close(),
      };
    },
  };
}
