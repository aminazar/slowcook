import { execSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BranchOperations } from "@slowcook-ai/core";

/**
 * Minimal `git` wrapper. Works against whatever repo the process is running
 * in (by default, process.cwd at construction time). Keeps the
 * "branch + stage + commit + push" flow the refinement agent needs without
 * pulling in a full git library.
 */
export class LocalGitOps implements BranchOperations {
  constructor(private readonly cwd: string = process.cwd()) {}

  private run(cmd: string): string {
    return execSync(cmd, { cwd: this.cwd, encoding: "utf8" }).trim();
  }

  async createBranch(name: string): Promise<void> {
    this.run(`git checkout -b ${shellQuote(name)}`);
  }

  async stage(path: string): Promise<void> {
    this.run(`git add ${shellQuote(path)}`);
  }

  async commit(message: string): Promise<void> {
    // -F <tempfile>: multi-line messages and shell metacharacters arrive
    // byte-identical (eleven-defects D3 — the -m "…" escaping supported
    // single-line messages only).
    const file = join(tmpdir(), `slowcook-commit-${process.pid}-${Date.now()}.txt`);
    writeFileSync(file, message, "utf8");
    try {
      this.run(`git commit -F ${shellQuote(file)}`);
    } finally {
      rmSync(file, { force: true });
    }
  }

  async push(branch: string): Promise<void> {
    this.run(`git push --set-upstream origin ${shellQuote(branch)}`);
  }

  async hasStagedChanges(): Promise<boolean> {
    // `git diff --cached --quiet` exits 0 when no staged changes, 1 when
    // there are staged changes, or other non-zero on error. execSync
    // throws on any non-zero exit, so the try/catch here is the
    // idiomatic way to read a boolean out of it without shelling out
    // through a shell pipeline.
    try {
      execSync("git diff --cached --quiet", {
        cwd: this.cwd,
        encoding: "utf8",
        stdio: ["ignore", "ignore", "ignore"],
      });
      return false;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 1) return true;
      // Any other status is a real error — re-throw so callers don't
      // silently proceed on (say) a detached-HEAD or no-repo condition.
      throw e;
    }
  }
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
