/**
 * `slowcook preview deploy --pr <n>` — 0.16.0-α.5.
 *
 * Builds the consumer's mock app remotely on their SSH-reachable box,
 * runs it as a Docker container, posts the preview URL to the PR.
 *
 * Flow:
 *  1. Read `.brewing/preview.yaml` (host, user, key secret, port range,
 *     URL template, remote root)
 *  2. tar the local mock/ directory (excluding node_modules + .next)
 *  3. scp tarball to `${remote_root}/pr-N/`
 *  4. ssh: extract, `docker build`, allocate port, `docker rm -f` old
 *     container if any, `docker run -d`
 *  5. Compose URL via `url_template`; upsert PR comment
 *
 * The container always exposes 3100 internally (matches the mock's
 * Dockerfile from `slowcook init mock`); the host port is allocated
 * from `port_range` and substituted into `url_template`.
 *
 * Error semantics: any sub-step failure throws; the caller prints +
 * exits non-zero. The workflow surfaces the failure as a check on the
 * PR; consumers can re-run via workflow_dispatch.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readPreviewConfig,
  containerNameForPr,
  imageTagForPr,
  remoteDirForPr,
  urlForPort,
  type PreviewConfig,
} from "./config.js";
import {
  sshExec,
  scpUpload,
  pickRemotePort,
  getContainerPort,
  type SshTarget,
} from "./ssh.js";

interface ParsedArgs {
  pr: number | undefined;
  repoRoot: string;
  keyPath: string | undefined;
  owner: string | undefined;
  repo: string | undefined;
  dryRun: boolean;
}

export function parseDeployArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    pr: undefined,
    repoRoot: process.cwd(),
    keyPath: undefined,
    owner: undefined,
    repo: undefined,
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
    else if (a === "--dry-run") { args.dryRun = true; }
  }
  return args;
}

export async function deploy(argv: string[], cliVersion: string): Promise<void> {
  const parsed = parseDeployArgs(argv);
  if (!parsed.pr || Number.isNaN(parsed.pr)) {
    console.error("--pr <number> is required.");
    process.exit(64);
  }

  const cfg = readPreviewConfig(parsed.repoRoot);
  const mockPath = join(parsed.repoRoot, cfg.mockDir);
  if (!existsSync(mockPath) || !statSync(mockPath).isDirectory()) {
    console.error(
      `Mock directory ${cfg.mockDir} not found at ${mockPath}. Run \`slowcook init mock\` first.`
    );
    process.exit(2);
  }

  if (parsed.dryRun) {
    console.log(`slowcook preview deploy · pr ${parsed.pr} (dry-run)`);
    console.log(`  config: host=${cfg.host} user=${cfg.user} port=${cfg.port}`);
    console.log(`  remote: ${remoteDirForPr(cfg, parsed.pr)}`);
    console.log(`  container: ${containerNameForPr(parsed.pr)}`);
    console.log(`  image: ${imageTagForPr(parsed.pr)}`);
    console.log(`  url_template: ${cfg.urlTemplate}`);
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

  console.log(
    `slowcook preview deploy · pr ${parsed.pr} → ${cfg.user}@${cfg.host}:${cfg.port}`
  );

  // Step 1: tar the mock directory locally. Exclude node_modules, .next,
  // .turbo (we'll rebuild on the box). Keeps the tarball small + the
  // remote build deterministic.
  const tarball = join(tmpdir(), `slowcook-mock-pr-${parsed.pr}.tgz`);
  console.log(`  tar    → ${tarball}`);
  const tarResult = spawnSync(
    "tar",
    [
      "czf", tarball,
      "-C", parsed.repoRoot,
      "--exclude=node_modules",
      "--exclude=.next",
      "--exclude=.turbo",
      "--exclude=out",
      cfg.mockDir,
    ],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }
  );
  if (tarResult.status !== 0) {
    throw new Error(`tar failed (status ${tarResult.status}): ${tarResult.stderr}`);
  }

  const remoteDir = remoteDirForPr(cfg, parsed.pr);
  const remoteTarball = `${remoteDir}/mock-src.tgz`;
  const containerName = containerNameForPr(parsed.pr);
  const imageTag = imageTagForPr(parsed.pr);

  // Step 2: ensure remote dir exists, scp tarball.
  console.log(`  ssh    mkdir -p ${remoteDir}`);
  sshExec(target, `mkdir -p ${shellQuote(remoteDir)}`);
  console.log(`  scp    → ${cfg.host}:${remoteTarball}`);
  scpUpload(target, tarball, remoteTarball);

  // Step 3: extract + build remotely.
  console.log(`  ssh    docker build ${imageTag}`);
  const buildScript = [
    `cd ${shellQuote(remoteDir)}`,
    `rm -rf ${shellQuote(cfg.mockDir)}`,
    `tar xzf mock-src.tgz`,
    `cd ${shellQuote(cfg.mockDir)}`,
    `docker build -t ${shellQuote(imageTag)} -f Dockerfile ..`,
  ].join(" && ");
  sshExec(target, buildScript);

  // Step 4: stop existing container (idempotent), allocate port, run.
  console.log(`  ssh    docker rm -f ${containerName} (if present)`);
  sshExec(target, `docker rm -f ${shellQuote(containerName)} 2>/dev/null || true`);

  console.log(`  ssh    pick free port in ${cfg.portRange[0]}..${cfg.portRange[1]}`);
  const hostPort = pickRemotePort(target, cfg.portRange[0], cfg.portRange[1]);
  console.log(`         → ${hostPort}`);

  console.log(`  ssh    docker run -d --name ${containerName} -p ${hostPort}:3100`);
  sshExec(
    target,
    `docker run -d --name ${shellQuote(containerName)} ` +
      `--restart unless-stopped ` +
      `--label slowcook.pr=${parsed.pr} ` +
      `-p ${hostPort}:3100 ${shellQuote(imageTag)}`
  );

  // Step 5: compose URL + upsert PR comment.
  const url = urlForPort(cfg, hostPort);
  console.log(`  url    ${url}`);

  const githubToken = process.env["GITHUB_TOKEN"];
  const owner = parsed.owner ?? detectOwner(parsed.repoRoot);
  const repo = parsed.repo ?? detectRepo(parsed.repoRoot);
  if (githubToken && owner && repo) {
    await upsertPreviewComment({
      owner, repo, pr: parsed.pr, url, hostPort, cliVersion, githubToken,
    });
  } else {
    console.log(
      `  (skipped PR comment: no GITHUB_TOKEN or unknown owner/repo. URL: ${url})`
    );
  }

  console.log(`Done. Preview ready at ${url}`);
}

const PREVIEW_COMMENT_MARKER = "<!-- slowcook-preview-deploy -->";

interface UpsertArgs {
  owner: string;
  repo: string;
  pr: number;
  url: string;
  hostPort: number;
  cliVersion: string;
  githubToken: string;
}

async function upsertPreviewComment(args: UpsertArgs): Promise<void> {
  // Use Octokit transitively via dynamic import to avoid pulling it
  // for the dry-run path.
  const { Octokit } = await import("@octokit/rest");
  const octokit = new Octokit({ auth: args.githubToken });

  const body = [
    PREVIEW_COMMENT_MARKER,
    `## 🍳 Mockup preview ready`,
    ``,
    `**Live URL:** ${args.url}`,
    ``,
    `Open the scenario picker; click any \`?scenario=story-N\` link to deep-link into a specific story's mock.`,
    ``,
    `_Deployed by \`slowcook preview deploy@${args.cliVersion}\` on host port ${args.hostPort}. Updated each time the mockup branch changes._`,
  ].join("\n");

  const list = await octokit.rest.issues.listComments({
    owner: args.owner,
    repo: args.repo,
    issue_number: args.pr,
    per_page: 100,
  });
  const existing = list.data.find((c) => c.body?.includes(PREVIEW_COMMENT_MARKER));
  if (existing) {
    await octokit.rest.issues.updateComment({
      owner: args.owner,
      repo: args.repo,
      comment_id: existing.id,
      body,
    });
    console.log(`  pr     comment ${existing.id} updated`);
  } else {
    const created = await octokit.rest.issues.createComment({
      owner: args.owner,
      repo: args.repo,
      issue_number: args.pr,
      body,
    });
    console.log(`  pr     comment ${created.data.id} created`);
  }
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
  // Minimal quoting for ssh-side bash. Single-quote everything; escape
  // existing single-quotes via the close-quote-then-escape pattern.
  return `'${s.replace(/'/g, "'\\''")}'`;
}

