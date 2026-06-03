/**
 * Shell-command execution layer for `slowcook serve`.
 *
 * Closes sc#173 finding #1: prior to this, planners emitted command
 * strings into `output[]` and exited without executing them, even when
 * `profile.ssh_target` was set. Operators had to copy-paste the emitted
 * command and run it themselves — the verb was documentation, not
 * automation.
 *
 * Now planners populate `result.commands[]` with structured ShellCommand
 * records; `runCommands()` wraps `remote: true` commands in
 * `ssh user@host 'cd checkout_dir && <cmd>'` and executes (unless
 * --dry-run, in which case the wrapped form is just printed).
 *
 * Local commands run via execSync in the repoRoot. Remote commands run
 * via execSync of an ssh invocation. Either way: stdio inherited so the
 * operator sees docker / git output in real time.
 */

import { execSync } from "node:child_process";
import type { ProfileConfig } from "./config.js";

export interface ShellCommand {
  /** The local-shell-shape command (e.g. `docker compose -f a.yml up -d`). */
  cmd: string;
  /**
   * When true AND `profile.ssh_target` is set, wrap the command in
   * `ssh <user>@<host> 'cd <checkout_dir> && <cmd>'`. When `ssh_target`
   * is absent, runs locally regardless. Use for docker / box-side
   * operations (up, down, logs). Local-only operations like `git push`
   * should pass `remote: false`.
   */
  remote?: boolean;
  /** Optional label printed before the command (e.g. "bring up", "seed"). */
  label?: string;
}

export interface RunCommandsArgs {
  commands: ShellCommand[];
  profile: ProfileConfig;
  repoRoot: string;
  /** When true: print the resolved command but don't execute. */
  dryRun?: boolean;
}

export interface RunCommandsResult {
  exitCode: number;
  /** Additional human-readable lines emitted by the runner (resolved cmds, errors). */
  output: string[];
}

/**
 * Resolve a single ShellCommand into the wire-form string we'd actually
 * pass to /bin/sh. Pure; useful for tests + the dry-run print path.
 */
export function resolveCommand(cmd: ShellCommand, profile: ProfileConfig): string {
  if (cmd.remote && profile.ssh_target) {
    const { user, host, checkout_dir } = profile.ssh_target;
    // Single-quote the remote command. Inner single quotes get escaped via
    // the bash `'\''` trick so paths/cmds containing `'` survive.
    const inner = cmd.cmd.replace(/'/g, `'\\''`);
    return `ssh ${user}@${host} 'cd ${checkout_dir} && ${inner}'`;
  }
  return cmd.cmd;
}

export function runCommands(args: RunCommandsArgs): RunCommandsResult {
  const out: string[] = [];
  for (const c of args.commands) {
    const wire = resolveCommand(c, args.profile);
    if (c.label) out.push(`  ${c.label}:`);
    out.push(`  ${args.dryRun ? "would run" : "run"}: ${wire}`);
    if (args.dryRun) continue;
    try {
      execSync(wire, { cwd: args.repoRoot, stdio: "inherit" });
    } catch {
      out.push(`  ✗ command failed: ${wire}`);
      return { exitCode: 1, output: out };
    }
  }
  return { exitCode: 0, output: out };
}
