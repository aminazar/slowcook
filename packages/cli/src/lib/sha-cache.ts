/**
 * THE SHA-KEYED CACHE (WP4, 2026-10-24).
 *
 * The swarm-vs-plain measurement found no knowledge gap in the cheap
 * model's failures — every stall named a contract defect — so the
 * substrate decision (ruling 1) falls to the plain path: memoize what every
 * stage re-derives from the same tree, keyed by what the tree IS, and stop.
 *
 * A value is keyed by (name, version, HEAD sha, a fingerprint of the
 * working-tree dirt). Same key → same bytes, served from
 * `.brewing/local/cache/<name>/<key>.json` with a small receipt (when it
 * was built, how long it took, how often it hit). Anything that changes
 * the tree changes the key; anything that changes the producer bumps
 * `version`. No daemon, no network, no signatures: a repo-local memo.
 *
 * `SLOWCOOK_NO_CACHE=1` bypasses it. Outside a git repo it degrades to a
 * plain build.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CACHE_ROOT_REL = join(".brewing", "local", "cache");

export type CacheExec = (cmd: string, cwd: string) => string;

const defaultExec: CacheExec = (cmd, cwd) =>
  execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });

export interface TreeFingerprint {
  head_sha: string;
  /** sha256 (16 hex) over `git status`, `git diff HEAD` and untracked file metadata. "clean" when nothing is dirty. */
  dirty: string;
}

/** What the tree IS right now. Throws outside a git repo. */
export function treeFingerprint(repoRoot: string, exec: CacheExec = defaultExec): TreeFingerprint {
  const head_sha = exec("git rev-parse HEAD", repoRoot).trim();
  const status = exec("git status --porcelain=v1 -z --untracked-files=all", repoRoot);
  if (status.trim() === "") return { head_sha, dirty: "clean" };
  const diff = exec("git diff HEAD --no-color", repoRoot);
  const untracked = status
    .split("\0")
    .filter((l) => l.startsWith("?? "))
    .map((l) => l.slice(3))
    .map((p) => {
      try { const st = statSync(join(repoRoot, p)); return `${p}:${st.size}:${Math.round(st.mtimeMs)}`; } catch { return `${p}:gone`; }
    })
    .join("\n");
  const dirty = createHash("sha256").update(status).update("\n--diff--\n").update(diff).update("\n--untracked--\n").update(untracked).digest("hex").slice(0, 16);
  return { head_sha, dirty };
}

/** The cache key: name + producer version + tree fingerprint. Pure. */
export function cacheKey(name: string, version: string, fp: TreeFingerprint): string {
  return createHash("sha256").update(`${name}\n${version}\n${fp.head_sha}\n${fp.dirty}`).digest("hex").slice(0, 24);
}

export interface CacheReceipt {
  name: string;
  version: string;
  key: string;
  head_sha: string;
  dirty: string;
  built_at: string;
  built_in_ms: number;
  hits: number;
}

export interface MemoOptions<T> {
  repoRoot: string;
  name: string;
  /** Bump when the producer's output shape or semantics change. */
  version: string;
  build: () => T;
  /** Entries kept per name (oldest pruned). */
  maxEntries?: number;
  exec?: CacheExec;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
}

export interface MemoResult<T> {
  value: T;
  hit: boolean;
  /** null when the cache was bypassed or unavailable (no git). */
  receipt: CacheReceipt | null;
}

export function isCacheDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env["SLOWCOOK_NO_CACHE"]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function memoBySha<T>(opts: MemoOptions<T>): MemoResult<T> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  if (isCacheDisabled(env)) return { value: opts.build(), hit: false, receipt: null };
  let fp: TreeFingerprint;
  try {
    fp = treeFingerprint(opts.repoRoot, opts.exec);
  } catch {
    return { value: opts.build(), hit: false, receipt: null };
  }
  const key = cacheKey(opts.name, opts.version, fp);
  const dir = join(opts.repoRoot, CACHE_ROOT_REL, opts.name);
  const file = join(dir, `${key}.json`);
  if (existsSync(file)) {
    try {
      const stored = JSON.parse(readFileSync(file, "utf8")) as { receipt: CacheReceipt; value: T };
      const receipt = { ...stored.receipt, hits: (stored.receipt.hits ?? 0) + 1 };
      try { writeFileSync(file, JSON.stringify({ receipt, value: stored.value }), "utf8"); } catch { /* best effort */ }
      return { value: stored.value, hit: true, receipt };
    } catch {
      /* corrupt entry: rebuild below and overwrite */
    }
  }
  const t0 = now();
  const value = opts.build();
  const receipt: CacheReceipt = {
    name: opts.name,
    version: opts.version,
    key,
    head_sha: fp.head_sha,
    dirty: fp.dirty,
    built_at: t0.toISOString(),
    built_in_ms: now().getTime() - t0.getTime(),
    hits: 0,
  };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ receipt, value }), "utf8");
    prune(dir, opts.maxEntries ?? 8, file);
  } catch {
    /* a cache that cannot write is a cache miss, never an error */
  }
  return { value, hit: false, receipt };
}

/** Keep the newest `max` entries of one name (by mtime); never the one just written. */
function prune(dir: string, max: number, keep: string): void {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const f of files.slice(max)) {
    if (f !== keep) { try { unlinkSync(f); } catch { /* ignore */ } }
  }
}

/** One line for a run log or console: "history-index: cache hit @abc1234 (built 12:01, 3 hit(s))". */
export function describeMemo(name: string, r: MemoResult<unknown>): string {
  if (!r.receipt) return `${name}: built (cache ${isCacheDisabled() ? "disabled" : "unavailable"})`;
  const sha = r.receipt.head_sha.slice(0, 7) + (r.receipt.dirty === "clean" ? "" : `+${r.receipt.dirty.slice(0, 6)}`);
  return r.hit
    ? `${name}: cache hit @${sha} (built ${r.receipt.built_at.slice(11, 19)}Z in ${r.receipt.built_in_ms}ms, ${r.receipt.hits} hit(s))`
    : `${name}: built in ${r.receipt.built_in_ms}ms, cached @${sha}`;
}
