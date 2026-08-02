/**
 * `slowcook serve <profile> watchdog` — keep dev servers actually SERVING,
 * not merely running.
 *
 * The failure class this exists for (delgoosh blank-portal incident,
 * 2026-08-02): a large sync burst floods a vite/next dev server with HMR
 * updates, the server restarts itself mid-flood, and afterwards it serves
 * index.html 200 while every MODULE request 504s behind the reverse proxy.
 * `docker ps` says healthy; the app renders a blank root. No container-level
 * healthcheck on `/` can catch this — the probe must exercise the transform
 * pipeline (`probe_path`, e.g. `/src/main.tsx` for vite).
 *
 * Design: the planner emits ONE resident bash script (generated from the
 * profile's `apps` config) that probes each watched app and applies the
 * proven recovery — clear the configured caches AND restart the container,
 * `recover_restarts` times — after `probe_strikes` consecutive failures,
 * then cools down. Resident commands are an existing serve pattern
 * (`logs --follow`); run this verb under systemd/pm2 on the box.
 *
 * Verbs:
 *   watchdog          — resident loop (systemd-friendly)
 *   watchdog --once   — single probe round; exit 0 iff all watched apps
 *                       healthy (cron/CI-friendly, no recovery performed)
 *
 * Everything decision-shaped is a pure, tested helper; the bash is only
 * plumbing around it.
 */

import type { ProfileConfig } from "./config.js";
import type { ShellCommand } from "./runner.js";
import type { DevVerbArgs, DevVerbResult } from "./dev.js";

export interface WatchdogTarget {
  app: string;
  container: string;
  port: number;
  probePath: string;
  intervalS: number;
  timeoutS: number;
  strikes: number;
  recoverClear: string[];
  recoverRestarts: number;
  cooldownS: number;
}

/** Modes a watchdog can meaningfully probe: anything that serves a dev/prod
 *  HTTP process. `static` never re-runs and `none` isn't started by serve. */
const UNWATCHABLE_MODES = new Set(["static", "none"]);

/** Apps that opted in via `probe_path`, with defaults resolved. */
export function watchdogTargets(profile: ProfileConfig): WatchdogTarget[] {
  const targets: WatchdogTarget[] = [];
  for (const [app, cfg] of Object.entries(profile.apps)) {
    if (!cfg.probe_path) continue;
    if (UNWATCHABLE_MODES.has(cfg.mode)) continue;
    targets.push({
      app,
      container: cfg.container ?? app,
      port: cfg.port,
      probePath: cfg.probe_path,
      intervalS: cfg.probe_interval_s,
      timeoutS: cfg.probe_timeout_s,
      strikes: cfg.probe_strikes,
      recoverClear: cfg.recover_clear,
      recoverRestarts: cfg.recover_restarts,
      cooldownS: cfg.recover_cooldown_s,
    });
  }
  return targets;
}

/** The clear+restart cycle for one target, as plain shell. Exported for the
 *  script generator and directly testable. */
export function recoveryShell(t: WatchdogTarget): string {
  const cycle = [
    ...t.recoverClear.map((p) => `rm -rf ${shq(p)}`),
    `docker restart ${shq(t.container)} >/dev/null 2>&1`,
  ].join(" && ");
  // WHY the sleep between cycles: the first post-wedge boot re-optimizes
  // deps against a browser-poisoned module graph and has come back wedged;
  // give it time to settle before the clean-cache second boot.
  const cycles: string[] = [];
  for (let i = 0; i < t.recoverRestarts; i++) {
    if (i > 0) cycles.push("sleep 25");
    cycles.push(cycle);
  }
  return cycles.join("; ");
}

/** Single-quote for bash, safely. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The resident supervision script. Pure string generation — tests assert the
 * load-bearing parts (transform probe per target, strike threshold, cooldown,
 * recovery cycles) without running bash.
 */
export function watchdogScript(targets: WatchdogTarget[], opts?: { once?: boolean }): string {
  const lines: string[] = [
    "#!/usr/bin/env bash",
    "set -u",
    `echo "[serve watchdog] probing ${targets.length} app(s): ${targets.map((t) => t.app).join(", ")}"`,
  ];
  for (const [i, t] of targets.entries()) {
    lines.push(`FAILS_${i}=0`, `COOL_${i}=0`);
  }
  const probeRound = targets
    .map((t, i) => {
      const probe = `curl -s -o /dev/null -m ${t.timeoutS} -w '%{http_code}' http://localhost:${t.port}${t.probePath}`;
      return [
        `  now=$(date +%s)`,
        `  if [ "$now" -ge "$COOL_${i}" ]; then`,
        `    code=$(${probe}) || code=000`,
        `    if [ "$code" = "200" ]; then`,
        `      [ "$FAILS_${i}" -gt 0 ] && echo "[serve watchdog] ${t.app} recovered on its own"`,
        `      FAILS_${i}=0`,
        `    else`,
        `      FAILS_${i}=$((FAILS_${i} + 1))`,
        `      echo "[serve watchdog] ${t.app} transform probe FAILED code=$code ($FAILS_${i}/${t.strikes})"`,
        `      UNHEALTHY=1`,
        `      if [ "$FAILS_${i}" -ge ${t.strikes} ]; then`,
        `        echo "[serve watchdog] RECOVERY: ${t.app} — clearing caches + ${t.recoverRestarts}x restart"`,
        `        ${recoveryShell(t)}`,
        `        COOL_${i}=$(($(date +%s) + ${t.cooldownS}))`,
        `        FAILS_${i}=0`,
        `      fi`,
        `    fi`,
        `  fi`,
      ].join("\n");
    })
    .join("\n");
  if (opts?.once) {
    lines.push("UNHEALTHY=0", probeRound, `exit $UNHEALTHY`);
  } else {
    const interval = Math.min(...targets.map((t) => t.intervalS));
    lines.push("while true; do", "  UNHEALTHY=0", probeRound, `  sleep ${interval}`, "done");
  }
  return lines.join("\n");
}

export function planWatchdog(args: DevVerbArgs, profile: ProfileConfig): DevVerbResult {
  const targets = watchdogTargets(profile);
  if (targets.length === 0) {
    return {
      exitCode: 64,
      output: [
        "[serve watchdog] no app declares a probe_path in serve.yaml — nothing to watch.",
        "  Add e.g. `probe_path: /src/main.tsx` (vite entry) plus `recover_clear:` cache dirs.",
      ],
    };
  }
  const once = args.verb === "watchdog-once";
  const output = [
    `[serve watchdog${once ? " --once" : ""}] ${targets.length} app(s): ` +
      targets
        .map((t) => `${t.app} (:${t.port}${t.probePath}, ${t.strikes} strikes, ${t.recoverRestarts}x restart)`)
        .join(", "),
  ];
  if (!once) {
    output.push("  resident loop — run under systemd/pm2 on the box; stop with ctrl-c / unit stop.");
  }
  const script = watchdogScript(targets, { once });
  const commands: ShellCommand[] = [
    { cmd: `bash -c ${shellQuoteForCmd(script)}`, remote: true, label: once ? "probe once" : "watchdog" },
  ];
  return { exitCode: 0, output, commands };
}

/** Quote a whole script as one bash -c argument. */
function shellQuoteForCmd(script: string): string {
  return `'${script.replace(/'/g, `'\\''`)}'`;
}
