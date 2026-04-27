/**
 * Thin shell wrappers around `ssh` + `scp` so deploy/teardown can talk
 * to the consumer's box without pulling in a JS ssh library.
 *
 * Why shell out: ops people debug `ssh` + `scp` invocations daily; if a
 * deploy fails, the failing command is something they can copy + paste.
 * Pulling in a JS library for marginal API ergonomics adds a maintenance
 * surface for a feature that's already box-specific.
 *
 * All wrappers use BatchMode=yes (no interactive password prompts) and
 * StrictHostKeyChecking=accept-new (first connect adds the key, future
 * connects verify against it). Failures throw with stderr captured so
 * the workflow logs surface the underlying error.
 */

import { spawnSync } from "node:child_process";

export interface SshTarget {
  host: string;
  user: string;
  port: number;
  /** Absolute path to the private key file on the runner's filesystem. */
  keyPath: string;
}

export interface SshResult {
  stdout: string;
  stderr: string;
}

/**
 * Standard ssh options: non-interactive, accept-new host keys, dedicated
 * key file. Returns the array form spawnSync wants.
 */
function sshArgs(target: SshTarget, extra: string[]): string[] {
  return [
    "-i", target.keyPath,
    "-p", String(target.port),
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=15",
    `${target.user}@${target.host}`,
    ...extra,
  ];
}

/**
 * Run a remote command via ssh. Throws on non-zero exit with the
 * captured stderr inlined into the error message.
 */
export function sshExec(target: SshTarget, command: string): SshResult {
  const result = spawnSync("ssh", sshArgs(target, [command]), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`ssh spawn failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `ssh exited ${result.status} for command:\n  ${command}\nstderr:\n${(result.stderr || "").trim()}`
    );
  }
  return { stdout: result.stdout || "", stderr: result.stderr || "" };
}

/**
 * scp a local file to a remote path. Throws on non-zero exit.
 */
export function scpUpload(target: SshTarget, localPath: string, remotePath: string): void {
  const result = spawnSync(
    "scp",
    [
      "-i", target.keyPath,
      "-P", String(target.port),
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=15",
      localPath,
      `${target.user}@${target.host}:${remotePath}`,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  if (result.error) {
    throw new Error(`scp spawn failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `scp exited ${result.status} uploading ${localPath} → ${target.user}@${target.host}:${remotePath}\nstderr:\n${(result.stderr || "").trim()}`
    );
  }
}

/**
 * Find the first free TCP port in [lo, hi] on the remote box. Uses
 * `ss -ltn` (universally available on modern Linux) to enumerate
 * already-bound ports.
 *
 * Returns the chosen port. Throws if every port in the range is in use.
 */
export function pickRemotePort(target: SshTarget, lo: number, hi: number): number {
  const cmd = `ss -ltn 'sport = :0' 2>/dev/null | awk 'NR>1 {split($4,a,":"); print a[length(a)]}' | sort -un`;
  const { stdout } = sshExec(target, cmd);
  const used = new Set<number>(
    stdout
      .split("\n")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n))
  );
  for (let p = lo; p <= hi; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error(
    `No free port in range ${lo}..${hi} on ${target.host}. Increase port_range or teardown stale containers.`
  );
}

/**
 * Get the host port a running container is publishing to (the value
 * after `0.0.0.0:` in `docker port` output). Returns null if the
 * container isn't running or doesn't publish 3100.
 */
export function getContainerPort(target: SshTarget, containerName: string): number | null {
  const cmd = `docker port ${containerName} 3100/tcp 2>/dev/null || true`;
  const { stdout } = sshExec(target, cmd);
  const m = stdout.trim().match(/:(\d+)\s*$/m);
  return m ? parseInt(m[1]!, 10) : null;
}
