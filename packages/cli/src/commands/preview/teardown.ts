/**
 * `slowcook preview teardown --pr <n>` — 0.16.0-α.5.
 *
 * Removes the running container + cleans up the staging directory for
 * a given PR. Idempotent — running it twice is fine. Updates the PR
 * comment to reflect the teardown.
 *
 * Triggered by the slowcook-preview-teardown.yml workflow on
 * `pull_request: closed`. Safe to also run manually via
 * workflow_dispatch when a stale container needs purging.
 */

import { execSync } from "node:child_process";
import {
  readPreviewConfig,
  containerNameForPr,
  imageTagForPr,
  remoteDirForPr,
} from "./config.js";
import { sshExec, type SshTarget } from "./ssh.js";

interface ParsedArgs {
  pr: number | undefined;
  repoRoot: string;
  keyPath: string | undefined;
  owner: string | undefined;
  repo: string | undefined;
  /** Also remove the docker image (frees disk on the box). Default: keep image for fast redeploy. */
  pruneImage: boolean;
  dryRun: boolean;
}

export function parseTeardownArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    pr: undefined,
    repoRoot: process.cwd(),
    keyPath: undefined,
    owner: undefined,
    repo: undefined,
    pruneImage: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--pr" && next) { args.pr = parseInt(next, 10); i++; }
    else if (a === "--cwd" && next) { args.repoRoot = next; i++; }
    else if (a === "--ssh-key" && next) { args.keyPath = next; i++; }
    else if (a === "--owner" && next) { args.owner = next; i++; }
    else if (a === "--repo" && next) { args.repo = next; i++; }
    else if (a === "--prune-image") { args.pruneImage = true; }
    else if (a === "--dry-run") { args.dryRun = true; }
  }
  return args;
}

export async function teardown(argv: string[], cliVersion: string): Promise<void> {
  const parsed = parseTeardownArgs(argv);
  if (!parsed.pr || Number.isNaN(parsed.pr)) {
    console.error("--pr <number> is required.");
    process.exit(64);
  }

  const cfg = readPreviewConfig(parsed.repoRoot);
  const containerName = containerNameForPr(parsed.pr);
  const imageTag = imageTagForPr(parsed.pr);
  const remoteDir = remoteDirForPr(cfg, parsed.pr);

  if (parsed.dryRun) {
    console.log(`slowcook preview teardown · pr ${parsed.pr} (dry-run)`);
    console.log(`  would: docker rm -f ${containerName}`);
    console.log(`  would: rm -rf ${remoteDir}`);
    if (parsed.pruneImage) {
      console.log(`  would: docker rmi ${imageTag}`);
    }
    return;
  }

  const keyPath = parsed.keyPath ?? process.env["SLOWCOOK_PREVIEW_SSH_KEY_PATH"];
  if (!keyPath) {
    console.error(
      "SSH key path not provided. Pass --ssh-key <path> or set SLOWCOOK_PREVIEW_SSH_KEY_PATH."
    );
    process.exit(2);
  }

  const target: SshTarget = {
    host: cfg.host,
    user: cfg.user,
    port: cfg.port,
    keyPath,
  };

  console.log(`slowcook preview teardown · pr ${parsed.pr} → ${cfg.user}@${cfg.host}`);

  console.log(`  ssh    docker rm -f ${containerName}`);
  sshExec(target, `docker rm -f ${shellQuote(containerName)} 2>/dev/null || true`);

  if (parsed.pruneImage) {
    console.log(`  ssh    docker rmi ${imageTag}`);
    sshExec(target, `docker rmi ${shellQuote(imageTag)} 2>/dev/null || true`);
  }

  console.log(`  ssh    rm -rf ${remoteDir}`);
  sshExec(target, `rm -rf ${shellQuote(remoteDir)}`);

  // Update the PR comment to indicate teardown.
  const githubToken = process.env["GITHUB_TOKEN"];
  const owner = parsed.owner ?? detectOwner(parsed.repoRoot);
  const repo = parsed.repo ?? detectRepo(parsed.repoRoot);
  if (githubToken && owner && repo) {
    await markCommentTornDown({
      owner, repo, pr: parsed.pr, githubToken, cliVersion,
    });
  } else {
    console.log(`  (skipped PR comment: no GITHUB_TOKEN or unknown owner/repo)`);
  }

  console.log(`Done. Preview for PR #${parsed.pr} is offline.`);
}

const PREVIEW_COMMENT_MARKER = "<!-- slowcook-preview-deploy -->";

async function markCommentTornDown(args: {
  owner: string;
  repo: string;
  pr: number;
  githubToken: string;
  cliVersion: string;
}): Promise<void> {
  const { Octokit } = await import("@octokit/rest");
  const octokit = new Octokit({ auth: args.githubToken });
  const list = await octokit.rest.issues.listComments({
    owner: args.owner,
    repo: args.repo,
    issue_number: args.pr,
    per_page: 100,
  });
  const existing = list.data.find((c) => c.body?.includes(PREVIEW_COMMENT_MARKER));
  if (!existing) return;
  const body = [
    PREVIEW_COMMENT_MARKER,
    `## 🍳 Mockup preview torn down`,
    ``,
    `The preview container for PR #${args.pr} has been removed (PR closed).`,
    ``,
    `_Torn down by \`slowcook preview teardown@${args.cliVersion}\`._`,
  ].join("\n");
  await octokit.rest.issues.updateComment({
    owner: args.owner,
    repo: args.repo,
    comment_id: existing.id,
    body,
  });
  console.log(`  pr     comment ${existing.id} marked torn-down`);
}

function detectOwner(repoRoot: string): string | undefined {
  return detectOwnerRepo(repoRoot)?.owner;
}
function detectRepo(repoRoot: string): string | undefined {
  return detectOwnerRepo(repoRoot)?.repo;
}
function detectOwnerRepo(repoRoot: string): { owner: string; repo: string } | undefined {
  try {
    const url = execSync("git remote get-url origin", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (m && m[1] && m[2]) return { owner: m[1], repo: m[2] };
  } catch {
    // not a git repo
  }
  return undefined;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
