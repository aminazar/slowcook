import { describe, expect, it } from "vitest";
import { ProfileConfigSchema } from "./config.js";
import { planWatchdog, recoveryShell, watchdogScript, watchdogTargets } from "./watchdog.js";

/**
 * The watchdog exists for the wedged-alive dev server (delgoosh blank-portal
 * incident): HMR storm → mid-flood self-restart → every MODULE request 504s
 * while `/` still serves 200 and the container reports healthy. These tests
 * pin the two load-bearing decisions:
 *   1. the probe must hit the TRANSFORM pipeline (`probe_path`), and
 *   2. recovery is cache-clear + restart, TWICE — a single restart has come
 *      back wedged in the field.
 */

const profile = (apps: Record<string, unknown>) =>
  ProfileConfigSchema.parse({ apps });

const viteApp = {
  mode: "vite-dev",
  port: 3010,
  probe_path: "/src/main.tsx",
  recover_clear: ["apps/web/node_modules/.vite"],
};

describe("watchdogTargets", () => {
  it("only watches apps that opted in via probe_path", () => {
    const p = profile({
      web: viteApp,
      api: { mode: "nest-watch", port: 4002 }, // no probe_path
    });
    expect(watchdogTargets(p).map((t) => t.app)).toEqual(["web"]);
  });

  it("never watches static or none apps — nothing serve could restart into health", () => {
    const p = profile({
      site: { mode: "static", port: 3003, probe_path: "/index.html" },
      cron: { mode: "none", port: 9999, probe_path: "/x" },
    });
    expect(watchdogTargets(p)).toEqual([]);
  });

  it("resolves the container override and the documented defaults", () => {
    const p = profile({ web: { ...viteApp, container: "acme-web" } });
    const [t] = watchdogTargets(p);
    expect(t.container).toBe("acme-web");
    expect(t.strikes).toBe(2);
    expect(t.recoverRestarts).toBe(2);
    expect(t.cooldownS).toBe(300);
  });
});

describe("recoveryShell", () => {
  it("clears the cache before EVERY restart, twice by default", () => {
    const [t] = watchdogTargets(profile({ web: viteApp }));
    const shell = recoveryShell(t);
    // Two full cycles with a settle between: the first post-wedge boot
    // re-optimizes against a poisoned module graph and can come back wedged.
    expect(shell.match(/rm -rf 'apps\/web\/node_modules\/\.vite'/g)).toHaveLength(2);
    expect(shell.match(/docker restart 'web'/g)).toHaveLength(2);
    expect(shell).toContain("sleep 25");
  });

  it("honours recover_restarts: 1 for apps where a single restart suffices", () => {
    const [t] = watchdogTargets(profile({ web: { ...viteApp, recover_restarts: 1 } }));
    const shell = recoveryShell(t);
    expect(shell.match(/docker restart/g)).toHaveLength(1);
    expect(shell).not.toContain("sleep 25");
  });
});

describe("watchdogScript", () => {
  it("probes the transform pipeline, not the homepage", () => {
    const script = watchdogScript(watchdogTargets(profile({ web: viteApp })));
    expect(script).toContain("http://localhost:3010/src/main.tsx");
    expect(script).not.toContain("http://localhost:3010/ ");
  });

  it("encodes strikes and cooldown so one blip never restarts and a recovery can't loop", () => {
    const script = watchdogScript(
      watchdogTargets(profile({ web: { ...viteApp, probe_strikes: 3, recover_cooldown_s: 600 } })),
    );
    expect(script).toContain("-ge 3");
    expect(script).toContain("+ 600");
  });

  it("--once probes a single round and exits nonzero when anything is unhealthy", () => {
    const script = watchdogScript(watchdogTargets(profile({ web: viteApp })), { once: true });
    expect(script).toContain("exit $UNHEALTHY");
    expect(script).not.toContain("while true");
  });

  it("the resident loop paces at the fastest configured interval", () => {
    const script = watchdogScript(
      watchdogTargets(
        profile({
          a: { ...viteApp, probe_interval_s: 45 },
          b: { ...viteApp, port: 3011, probe_interval_s: 15 },
        }),
      ),
    );
    expect(script).toContain("sleep 15");
  });
});

describe("planWatchdog", () => {
  const args = { verb: "watchdog", repoRoot: "/tmp" };

  it("is a clear config error when no app opted in", () => {
    const res = planWatchdog(args as never, profile({ api: { mode: "nest-watch", port: 4002 } }));
    expect(res.exitCode).toBe(64);
    expect(res.output.join("\n")).toContain("probe_path");
  });

  it("emits one remote resident command wrapping the generated script", () => {
    const res = planWatchdog(args as never, profile({ web: viteApp }));
    expect(res.exitCode).toBe(0);
    expect(res.commands).toHaveLength(1);
    expect(res.commands?.[0].remote).toBe(true);
    expect(res.commands?.[0].cmd).toContain("/src/main.tsx");
  });
});
