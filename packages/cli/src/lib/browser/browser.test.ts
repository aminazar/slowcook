// Browser-driver seam — selection/failover logic + the replay engine, on a FAKE
// driver (no real browser, deterministic). The engines themselves are covered by
// the integration benchmark.
import { describe, it, expect } from "vitest";
import { satisfies, type BrowserDriver, type DriverCaps, type DriverPage } from "./driver.js";
import { selectDriver } from "./select.js";
import { replayPlan, planNeed, type QaPlan } from "./qa-replay.js";
import { agreementOf } from "./bench.js";

describe("caps / satisfies", () => {
  const full: DriverCaps = { emulation: true, contexts: true, actions: "full" };
  const basic: DriverCaps = { emulation: false, contexts: false, actions: "basic" };
  it("full caps satisfy every need; basic caps only basic needs", () => {
    expect(satisfies(full, { emulation: true, contexts: true, actions: "full" })).toBe(true);
    expect(satisfies(basic, { actions: "basic" })).toBe(true);
    expect(satisfies(basic, { emulation: true })).toBe(false);   // no emulation
    expect(satisfies(basic, { contexts: true })).toBe(false);    // no contexts
    expect(satisfies(basic, { actions: "full" })).toBe(false);   // click+fill only
  });
});

describe("selectDriver", () => {
  it("defaults to playwright with no preference", async () => {
    const s = await selectDriver();
    expect(s.driver.name).toBe("playwright");
    expect(s.usedPreferred).toBe(true);
  });

  it("env SLOWCOOK_BROWSER=playwright forces playwright even if rustwright is preferred", async () => {
    const s = await selectDriver({ prefer: "rustwright", env: { SLOWCOOK_BROWSER: "playwright" } });
    expect(s.driver.name).toBe("playwright");
  });

  it("preferring rustwright for an EMULATION need fails over to playwright (the eye case)", async () => {
    const s = await selectDriver({ prefer: "rustwright", need: { emulation: true }, env: {} });
    expect(s.driver.name).toBe("playwright");
    expect(s.usedPreferred).toBe(false);
    expect(s.reason).toMatch(/can't satisfy/);
  });

  it("preferring rustwright for a BASIC need uses it when installed, else fails over — never throws", async () => {
    // rustwright is a devDependency in this workspace, so it loads; if a CI env
    // lacks it, this still resolves to playwright (the point: no throw).
    const s = await selectDriver({ prefer: "rustwright", need: { actions: "basic" }, env: {} });
    expect(["rustwright", "playwright"]).toContain(s.driver.name);
    expect(s.reason).toBeTruthy();
  });
});

// A fake page that records actions + answers evaluate from a script, so the
// replay engine is testable without a browser.
function fakeDriver(script: { evaluate?: (expr: string) => unknown; failOn?: string }): BrowserDriver {
  const page: DriverPage = {
    goto: async () => {},
    evaluate: async <T>(expr: string) => (script.evaluate ? script.evaluate(expr) : true) as T,
    screenshot: async () => Buffer.from(""),
    click: async (sel) => { if (script.failOn === sel) throw new Error("no such element"); },
    fill: async () => {},
    textContent: async () => null,
    title: async () => "t",
    waitFor: async () => {},
    close: async () => {},
  };
  return {
    name: "playwright",
    caps: { emulation: true, contexts: true, actions: "full" },
    launch: async () => ({ newPage: async () => page, close: async () => {} }),
  };
}

// A page that ALSO exposes url() — Playwright's real page does, DriverPage does
// not declare it. The goto step feature-detects it to skip a same-URL reload.
function fakeDriverWithUrl(currentUrl: string, gotos: string[]): BrowserDriver {
  const page = {
    url: () => currentUrl,
    goto: async (u: string) => { gotos.push(u); },
    evaluate: async <T>() => true as T,
    screenshot: async () => Buffer.from(""),
    click: async () => {},
    fill: async () => {},
    textContent: async () => null,
    title: async () => "t",
    waitFor: async () => {},
    close: async () => {},
  } as DriverPage;
  return {
    name: "playwright",
    caps: { emulation: true, contexts: true, actions: "full" },
    launch: async () => ({ newPage: async () => page, close: async () => {} }),
  };
}

describe("goto same-URL skip (feature-detected url())", () => {
  const gotoPlan: QaPlan = {
    name: "goto", baseUrl: "http://x",
    steps: [{ action: "goto", url: "/login" }],
  };

  // REGRESSION (cli build was broken): the skip used to narrow `page` twice —
  // once as `{ url?: () => string }` and again as `{ url: () => string }`. The
  // second assertion does not compile, because DriverPage has no `url` at all
  // (TS2352), and it took the whole `packages/cli` build down with it. Narrow
  // once, through the optional shape, and call it.
  it("skips the goto when the page is already standing on the target URL", async () => {
    const gotos: string[] = [];
    const r = await replayPlan(fakeDriverWithUrl("http://x/login", gotos), gotoPlan);
    expect(r.ok).toBe(true);
    expect(gotos).toEqual([]);            // skipped — no reload, events survive
  });

  it("navigates when the page is standing somewhere else", async () => {
    const gotos: string[] = [];
    const r = await replayPlan(fakeDriverWithUrl("http://x/elsewhere", gotos), gotoPlan);
    expect(r.ok).toBe(true);
    expect(gotos).toEqual(["http://x/login"]);
  });

  it("navigates when the driver page has no url() at all (DriverPage shape)", async () => {
    // The bug shape: a driver whose page lacks url() must still navigate, not
    // throw on the missing method.
    const r = await replayPlan(fakeDriver({ evaluate: () => true }), gotoPlan);
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.action)).toEqual(["goto"]);
  });
});

describe("replayPlan", () => {
  const plan: QaPlan = {
    name: "login smoke", baseUrl: "http://x",
    steps: [
      { action: "goto", url: "/login" },
      { action: "fill", selector: "#email", value: "a@b.c" },
      { action: "click", selector: "#submit" },
      { action: "assert", expr: "location.pathname === '/home'", expect: true },
      { action: "screenshot", path: "/tmp/x.png" },
    ],
  };

  it("a passing plan runs every step in order and reports ok", async () => {
    const r = await replayPlan(fakeDriver({ evaluate: () => true }), plan);
    expect(r.ok).toBe(true);
    expect(r.steps).toHaveLength(5);
    expect(r.steps.map((s) => s.action)).toEqual(["goto", "fill", "click", "assert", "screenshot"]);
    expect(r.failedAt).toBeUndefined();
  });

  it("a failing assert stops the run at that step and records why", async () => {
    const r = await replayPlan(fakeDriver({ evaluate: () => false }), plan);
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe(3);                 // the assert
    expect(r.steps).toHaveLength(4);            // stopped — screenshot never ran
    expect(r.steps[3]!.detail).toMatch(/assert failed/);
  });

  it("a failing action (missing element) stops and records the error", async () => {
    const r = await replayPlan(fakeDriver({ failOn: "#submit" }), plan);
    expect(r.ok).toBe(false);
    expect(r.failedAt).toBe(2);                 // the click
    expect(r.steps[2]!.detail).toMatch(/no such element/);
  });

  it("planNeed is basic — a plain replay fits rustwright", () => {
    expect(planNeed(plan)).toEqual({ actions: "basic" });
  });
});

describe("agreementOf (bench oracle gate)", () => {
  it("is 1 when every pass/fail matches, and drops with each disagreement", () => {
    expect(agreementOf([true, true, false], [true, true, false])).toBe(1);
    expect(agreementOf([true, true, true, true], [true, false, true, false])).toBe(0.5);
    expect(agreementOf([], [])).toBe(1);               // vacuously agree
    expect(agreementOf([true], [true, false])).toBe(1); // compares the common prefix
  });
});
