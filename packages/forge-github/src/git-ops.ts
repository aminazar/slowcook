import { execSync } from "node:child_process";
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
    // Use -F with a temp file would be safer for multi-line; for now, single-line messages only.
    const safe = message.replace(/"/g, '\\"');
    this.run(`git commit -m "${safe}"`);
  }

  async push(branch: string): Promise<void> {
    this.run(`git push --set-upstream origin ${shellQuote(branch)}`);
  }
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
