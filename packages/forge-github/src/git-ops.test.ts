import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalGitOps } from "./git-ops.js";

describe("LocalGitOps.commit (D3)", () => {
  it("multi-line messages with quotes and backticks land byte-identical", async () => {
    const r = mkdtempSync(join(tmpdir(), "gitops-"));
    execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: r });
    writeFileSync(join(r, "a.txt"), "x");
    const ops = new LocalGitOps(r);
    await ops.stage("a.txt");
    const msg = 'slowcook: tests for story-1\n\nRemoves "superseded": `story-0` $(echo unsafe)';
    await ops.commit(msg);
    const logged = execSync("git log -1 --pretty=%B", { cwd: r, encoding: "utf8" }).trim();
    expect(logged).toBe(msg);
  });
});
