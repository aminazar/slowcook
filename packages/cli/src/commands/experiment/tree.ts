/**
 * Git plumbing for the harness: a detached worktree per run, hiding and
 * restoring a story's slowcook artifacts, and small read helpers. Every
 * function takes an injectable `exec` so the flow unit-tests without git.
 */
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { join, relative } from "node:path";

export type Exec = (cmd: string, cwd: string) => string;

export const defaultExec: Exec = (cmd, cwd) =>
  execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });

export function gitSha(cwd: string, ref: string, exec: Exec = defaultExec): string {
  return exec(`git rev-parse --verify ${JSON.stringify(ref + "^{commit}")}`, cwd).trim();
}

export function isClean(cwd: string, exec: Exec = defaultExec): boolean {
  return exec("git status --porcelain", cwd).trim() === "";
}

export function currentBranch(cwd: string, exec: Exec = defaultExec): string {
  return exec("git rev-parse --abbrev-ref HEAD", cwd).trim();
}

/** A detached worktree at `sha` under `treePath`, node_modules linked from the main checkout. */
export function ensureTree(repoRoot: string, treePath: string, sha: string, exec: Exec = defaultExec): string {
  if (!existsSync(join(treePath, ".git"))) {
    exec(`git worktree add --force --detach ${JSON.stringify(treePath)} ${sha}`, repoRoot);
  } else {
    exec(`git checkout --detach ${sha}`, treePath);
    exec(`git reset --hard ${sha}`, treePath);
    exec(`git clean -fdq`, treePath);
  }
  const nm = join(treePath, "node_modules");
  if (!existsSync(nm) && existsSync(join(repoRoot, "node_modules"))) symlinkSync(join(repoRoot, "node_modules"), nm, "dir");
  // Gitignored local config the suites read (never committed, never leaves
  // the box): the first dogfood worktree had no .env.local and every suite
  // that needed it broke.
  for (const f of LOCAL_ENV_FILES) {
    if (existsSync(join(repoRoot, f)) && !existsSync(join(treePath, f))) copyFileSync(join(repoRoot, f), join(treePath, f));
  }
  return treePath;
}

export const LOCAL_ENV_FILES = [".env", ".env.local", ".env.test", ".env.test.local", ".env.acceptance"];

/**
 * The slowcook artifacts of one story: its spec, cost sidecar, manifest and
 * every test file the manifest names or whose path carries `story-<id>`.
 * Pure over a file list + manifest; exported for tests.
 */
export function storyArtifactPaths(
  storyId: string,
  manifestTests: Array<{ file: string }>,
  allFiles: string[]
): string[] {
  const bare = storyId.replace(/^0+/, "") || "0";
  const re = new RegExp(`(^|[/_.-])story-0*${bare}([/_.-]|$)`);
  const set = new Set<string>();
  for (const t of manifestTests) set.add(t.file);
  for (const f of allFiles) {
    if (
      f === `specs/story-${storyId}.yaml` ||
      f === `specs/story-${storyId}.cost.jsonl` ||
      f === `.brewing/manifests/story-${storyId}.json` ||
      ((f.startsWith("tests/") || f.startsWith("supabase/tests/") || f.startsWith("specs/") || f.startsWith(".brewing/manifests/")) && re.test(f))
    ) set.add(f);
  }
  return [...set].sort();
}

export function trackedFiles(cwd: string, exec: Exec = defaultExec): string[] {
  return exec("git ls-files", cwd).split("\n").map((l) => l.trim()).filter(Boolean);
}

export function readManifestTests(tree: string, storyId: string): Array<{ id: string; file: string }> {
  const p = join(tree, ".brewing", "manifests", `story-${storyId}.json`);
  if (!existsSync(p)) return [];
  try { return (JSON.parse(readFileSync(p, "utf8")) as { tests?: Array<{ id: string; file: string }> }).tests ?? []; } catch { return []; }
}

/** `git rm` the artifacts and commit, so the plain arm's tree has no trace of them. */
export function hideArtifacts(tree: string, paths: string[], exec: Exec = defaultExec): void {
  if (paths.length === 0) return;
  exec(`git rm -rq --ignore-unmatch -- ${paths.map((p) => JSON.stringify(p)).join(" ")}`, tree);
  exec(`git -c user.name=slowcook-experiment -c user.email=experiment@slowcook.local commit -qm "experiment: hide slowcook artifacts from the plain arm"`, tree);
}

/** Bring the artifacts back from `sha` for the hidden oracle (working tree only; not committed). */
export function restoreArtifacts(tree: string, sha: string, paths: string[], exec: Exec = defaultExec): void {
  if (paths.length === 0) return;
  exec(`git checkout ${sha} -- ${paths.map((p) => JSON.stringify(p)).join(" ")}`, tree);
}

export function commitAll(tree: string, message: string, exec: Exec = defaultExec): boolean {
  if (isClean(tree, exec)) return false;
  exec("git add -A", tree);
  exec(`git -c user.name=slowcook-experiment -c user.email=experiment@slowcook.local commit -qm ${JSON.stringify(message)}`, tree);
  return true;
}

export function changedFiles(tree: string, fromSha: string, exec: Exec = defaultExec): string[] {
  return exec(`git diff --name-only ${fromSha} HEAD`, tree).split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Newest file in `dir` matching `re`, by mtime; null when none. */
export function newestFile(dir: string, re: RegExp): string | null {
  if (!existsSync(dir)) return null;
  const cands = readdirSync(dir).filter((f) => re.test(f)).map((f) => join(dir, f));
  cands.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return cands[0] ?? null;
}

export function relPath(root: string, p: string): string {
  return relative(root, p) || ".";
}
