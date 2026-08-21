/**
 * `slowcook worker deploy` — ship the slowcook checkout to a worker box
 * (eleven-defects D7). Mechanizes the deploy recipe that ledger G1 made
 * habit: rsync with the exclusions that prevented the stale-dist lie,
 * remote `tsc -b --force`, then a DETERMINISTIC freshness assertion —
 * no file under packages/*\/dist may predate the build we just ran.
 *
 *   slowcook worker deploy --host <ssh-host> [--dir <remote-dir>]
 *                          [--source <local-repo-root>]
 *
 * Fail closed at every step; the last line is the receipt
 * ("deployed <sha> to <host>:<dir> — dist fresh").
 */

import { execSync } from "node:child_process";

/** The G1 exclusions: tsbuildinfo shipped = remote tsc believes it's
 *  up-to-date and leaves a stale dist that LIES about the deploy. */
export const DEPLOY_EXCLUSIONS = [
  ".git",
  "node_modules",
  "dist",
  "*.tsbuildinfo",
  ".slowcook",
] as const;

export function rsyncArgs(source: string, host: string, dir: string): string[] {
  return [
    "-az",
    "--delete",
    ...DEPLOY_EXCLUSIONS.flatMap((e) => ["--exclude", e]),
    source.endsWith("/") ? source : source + "/",
    `${host}:${dir.endsWith("/") ? dir : dir + "/"}`,
  ];
}

/** Remote build + freshness assertion, one shell. A stamp file marks the
 *  build start; any dist file NOT newer than the stamp is stale — the
 *  build claimed success while leaving old artifacts (G1's exact lie). */
export function remoteBuildScript(dir: string): string {
  return [
    `cd ${shq(dir)}`,
    `touch .deploy-build-stamp`,
    // Orphaned dist files (source deleted, artifact remains) survive any
    // rebuild and are importable lies — the first dogfood deploy caught
    // four of them. Clean slate, then force-build.
    `rm -rf packages/*/dist`,
    `npx tsc -b --force`,
    `stale=$(find packages/*/dist -type f -name '*.js' ! -newer .deploy-build-stamp | head -5)`,
    `if [ -n "$stale" ]; then echo "STALE DIST after build:"; echo "$stale"; exit 9; fi`,
    `rm -f .deploy-build-stamp`,
    `echo DIST_FRESH`,
  ].join(" && ");
}

function shq(s: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export async function workerDeploy(argv: string[]): Promise<void> {
  let host = "";
  let dir = "/root/slowcook-head";
  let source = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--host" && next) { host = next; i++; }
    else if (a === "--dir" && next) { dir = next; i++; }
    else if (a === "--source" && next) { source = next; i++; }
  }
  if (!host) {
    console.error("slowcook worker deploy: --host <ssh-host> is required.");
    process.exit(64);
  }

  // The deploy ships THE TREE AS IT STANDS — say out loud what that is.
  let sha = "unknown";
  let dirty = false;
  try {
    sha = execSync("git rev-parse --short=9 HEAD", { cwd: source, encoding: "utf8" }).trim();
    dirty =
      execSync("git status --porcelain", { cwd: source, encoding: "utf8" })
        .split("\n")
        .filter((l) => l.trim() && l.slice(3).startsWith("packages/")).length > 0;
  } catch {
    /* non-git source — sha stays unknown */
  }
  if (dirty) {
    console.error(
      `slowcook worker deploy: uncommitted changes under packages/ in ${source} — ` +
        `deploy ships committed state only (commit or stash first).`
    );
    process.exit(2);
  }
  console.log(`deploying ${sha} from ${source} → ${host}:${dir}`);

  try {
    execSync(`rsync ${rsyncArgs(source, host, dir).map(shq).join(" ")}`, {
      stdio: ["ignore", "inherit", "inherit"],
    });
  } catch {
    console.error("slowcook worker deploy: rsync failed.");
    process.exit(2);
  }

  try {
    const out = execSync(`ssh ${shq(host)} ${shq(remoteBuildScript(dir))}`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!out.includes("DIST_FRESH")) {
      console.error(`slowcook worker deploy: build did not report DIST_FRESH:\n${out.slice(-500)}`);
      process.exit(2);
    }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    console.error(
      `slowcook worker deploy: remote build/assert FAILED:\n` +
        `${(err.stdout ?? "").slice(-800)}\n${(err.stderr ?? "").slice(-400)}`
    );
    process.exit(2);
  }

  console.log(`deployed ${sha} to ${host}:${dir} — dist fresh`);
}
