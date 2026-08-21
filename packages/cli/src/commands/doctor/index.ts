/**
 * `slowcook doctor` — verify and NAME every worker precondition
 * (eleven-defects D5; the "one insight" of the rewo run: the harness
 * must assert its own preconditions out loud, not assume and fail later
 * somewhere else).
 *
 * Each check prints one line: ✓/✗/! name — detail. Live calls where a
 * live call is the only honest check (App token MINTED, not just files
 * present). Exit 1 if any check fails; warnings don't fail the run.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Octokit } from "@octokit/rest";
import { appAuthConfigured, mintInstallationToken } from "@slowcook-ai/forge-github";
import { isModelPriced } from "@slowcook-ai/llm-anthropic";
import { STAGE_DEFAULTS } from "../../lib/model-defaults.js";
import { dirtyDiscoveryPaths } from "../../lib/discovery-hygiene.js";

interface CheckResult {
  name: string;
  status: "ok" | "fail" | "warn";
  detail: string;
}

export async function doctor(argv: string[]): Promise<void> {
  let repoRoot = process.cwd();
  let owner: string | undefined;
  let repo: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--cwd" && next) { repoRoot = next; i++; }
    else if (a === "--owner" && next) { owner = next; i++; }
    else if (a === "--repo" && next) { repo = next; i++; }
  }

  const results: CheckResult[] = [];

  // 1. Checkout: repo, base sync, residue.
  try {
    execSync("git rev-parse --git-dir", { cwd: repoRoot, stdio: ["ignore", "ignore", "ignore"] });
    let base = "main";
    try {
      base = execSync("git remote show origin", { cwd: repoRoot, encoding: "utf8" })
        .match(/HEAD branch: (\S+)/)?.[1] ?? "main";
    } catch { /* offline — assume main */ }
    try {
      const headSha = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
      const originSha = execSync(`git rev-parse origin/${base}`, { cwd: repoRoot, encoding: "utf8" }).trim();
      results.push(
        headSha === originSha
          ? { name: "checkout", status: "ok", detail: `${base} @ ${headSha.slice(0, 9)} matches origin` }
          : { name: "checkout", status: "warn", detail: `HEAD ${headSha.slice(0, 9)} != origin/${base} ${originSha.slice(0, 9)} — worker passes will resync; manual runs may see stale facts` }
      );
    } catch {
      results.push({ name: "checkout", status: "warn", detail: `origin/${base} unknown — fetch first` });
    }
    const dirty = dirtyDiscoveryPaths(repoRoot);
    results.push(
      dirty.length === 0
        ? { name: "worktree-hygiene", status: "ok", detail: "no residue under src|tests" }
        : { name: "worktree-hygiene", status: "fail", detail: `${dirty.length} path(s) could make discovery lie (G20): ${dirty.slice(0, 3).join(", ")}${dirty.length > 3 ? ", …" : ""}` }
    );
  } catch {
    results.push({ name: "checkout", status: "fail", detail: `${repoRoot} is not a git repository` });
  }

  // 2. Forge identity — LIVE mint, not a file check.
  if (!owner || !repo) {
    try {
      const url = execSync("git remote get-url origin", { cwd: repoRoot, encoding: "utf8" }).trim();
      const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
      if (m) { owner = owner ?? m[1]; repo = repo ?? m[2]; }
    } catch { /* reported below */ }
  }
  if (appAuthConfigured()) {
    if (owner && repo) {
      try {
        const minted = await mintInstallationToken(owner, repo);
        results.push({ name: "forge-identity", status: "ok", detail: `GitHub App ${minted.appSlug}[bot] minted a live installation token for ${owner}/${repo}` });
      } catch (e) {
        results.push({ name: "forge-identity", status: "fail", detail: `App configured but cannot mint: ${(e as Error).message}` });
      }
    } else {
      results.push({ name: "forge-identity", status: "warn", detail: "App configured; pass --owner/--repo (or run in a checkout) to live-test minting" });
    }
  } else {
    const tok = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
    if (!tok) {
      results.push({ name: "forge-identity", status: "fail", detail: "no GitHub App configured and no GITHUB_TOKEN/GH_TOKEN set" });
    } else {
      try {
        const { data } = await new Octokit({ auth: tok }).users.getAuthenticated();
        results.push({ name: "forge-identity", status: "warn", detail: `operator token (@${data.login}) — agents will post as this PERSON; run \`slowcook app init\` for a bot identity` });
      } catch (e) {
        results.push({ name: "forge-identity", status: "fail", detail: `token set but rejected by GitHub: ${(e as Error).message}` });
      }
    }
  }

  // 3. LLM seam.
  const llmSeam = process.env["SLOWCOOK_LLM"];
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (llmSeam === "claude-cli") {
    let cliOk = false;
    try {
      execSync("claude --version", { stdio: ["ignore", "ignore", "ignore"] });
      cliOk = true;
    } catch { /* not on PATH */ }
    results.push(
      cliOk
        ? { name: "llm-seam", status: "ok", detail: "SLOWCOOK_LLM=claude-cli and the claude binary is on PATH" }
        : { name: "llm-seam", status: "fail", detail: "SLOWCOOK_LLM=claude-cli but no `claude` binary on PATH" }
    );
    if (apiKey) {
      results.push({ name: "llm-key-conflict", status: "fail", detail: "ANTHROPIC_API_KEY is set and OUTRANKS the CLI OAuth token — unset it in the worker env (the rewo box trap)" });
    }
  } else if (apiKey) {
    results.push({ name: "llm-seam", status: "ok", detail: "ANTHROPIC_API_KEY set (direct API)" });
  } else {
    results.push({ name: "llm-seam", status: "fail", detail: "no LLM configured: set ANTHROPIC_API_KEY, or SLOWCOOK_LLM=claude-cli with a logged-in claude binary" });
  }

  // 4. Pricing covers every default model (ledger G3: an unpriced model
  //    fail-closes the agent at spawn time — catch it here instead).
  const models = [...new Set(Object.values(STAGE_DEFAULTS))];
  const unpriced = models.filter((m) => !isModelPriced(m));
  results.push(
    unpriced.length === 0
      ? { name: "pricing", status: "ok", detail: `all ${models.length} default models priced` }
      : { name: "pricing", status: "fail", detail: `no pricing for: ${unpriced.join(", ")} — agents using them will fail closed (G3)` }
  );

  // 5. Dependencies installed (G12's box face: missing node_modules made
  //    manifest discovery hard-fail mid-run).
  results.push(
    existsSync(join(repoRoot, "node_modules"))
      ? { name: "dependencies", status: "ok", detail: "node_modules present" }
      : { name: "dependencies", status: "fail", detail: "node_modules missing — run npm/pnpm install (manifest discovery hard-fails without it)" }
  );

  const badge = { ok: "✓", fail: "✗", warn: "!" } as const;
  for (const r of results) console.log(`${badge[r.status]} ${r.name} — ${r.detail}`);
  const failed = results.filter((r) => r.status === "fail");
  console.log(
    failed.length === 0
      ? `\ndoctor: all ${results.length} checks passed${results.some((r) => r.status === "warn") ? " (with warnings)" : ""}`
      : `\ndoctor: ${failed.length} of ${results.length} checks FAILED`
  );
  if (failed.length > 0) process.exit(1);
}
