/**
 * `slowcook worker` — label-triggered agent worker (W0: dry-run only).
 *
 * Plan: docs/plans/rewo-agent-workers.md. This is slowcook's default
 * operating model: the pipeline runs itself and calls a human only at
 * declared HITL gates. The worker is deliberately THIN — scan, evaluate
 * preconditions, trace, (later: spawn) — because logic in the worker is
 * logic that can lie about slowcook.
 *
 * W0 scope (this file): one pass per invocation (systemd oneshot),
 * lockfile, label scan, precondition evaluation, trace + workload
 * output, ZERO GitHub mutations and ZERO agent spawns. Live stages are
 * enabled one at a time in W1+ — until then the command refuses to run
 * without `--dry-run`, loudly, so nothing can quietly spend.
 *
 * Subcommands:
 *   run      one worker pass
 *   systemd  print the service + timer units for a box install
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Octokit } from "@octokit/rest";
import { appAuthConfigured, mintInstallationToken } from "@slowcook-ai/forge-github";
import { readIndex, readSpec } from "../refine/spec-yaml.js";
import {
  deriveJobs,
  summarizeWorkload,
  renderWorkloadLine,
  TRIGGER_LABELS,
  FAILED_LABEL,
  RESULT_LABELS,
  type IssueFact,
  type StoryArtifactFacts,
  type WorkerJob,
} from "./plan.js";
import { writeTrace, traceDirName, type JobOutcome } from "./trace.js";
import { mapLiveOutcome, commentHeader } from "./live.js";
import { acquireWorkerLock, releaseWorkerLock } from "./worker-lock.js";
import { pmCc } from "../../lib/pm-notify.js";
import type { AgentKind } from "./plan.js";

/** Stages allowed to run live in this build. Widened one phase at a time
 *  (plan §6) — never before the upstream handoff contract is verified. */
const LIVE_STAGES: ReadonlySet<AgentKind> = new Set(["refine"]);

interface RunArgs {
  repoRoot: string;
  owner: string | undefined;
  repo: string | undefined;
  dryRun: boolean;
  /** Stages enabled for LIVE execution (W1+). Empty = none. */
  enable: Set<AgentKind>;
  /** Hard wall-clock cap per live job, minutes. */
  jobTimeoutMins: number;
  logsDir: string;
  lockPath: string | undefined;
  json: boolean;
}

export async function worker(argv: string[]): Promise<void> {
  const sub = argv[0];
  switch (sub) {
    case "run":
      return runPass(argv.slice(1));
    case "systemd":
      return printSystemd(argv.slice(1));
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      console.error(`Unknown worker subcommand: ${sub}`);
      printHelp();
      process.exit(64);
  }
}

async function runPass(argv: string[]): Promise<void> {
  const args = parseRunArgs(argv);

  // Live mode requires an explicit --enable; nothing spends by accident.
  if (!args.dryRun && args.enable.size === 0) {
    console.error(
      "slowcook worker: no stage is enabled for live execution.\n" +
        "  Pass --dry-run for a zero-spend pass, or --enable refine to run the\n" +
        "  W1 stage live. Stages beyond W1 are enabled one at a time, each only\n" +
        "  after its upstream handoff contract is verified (plan §6)."
    );
    process.exit(2);
  }
  for (const stage of args.enable) {
    if (!LIVE_STAGES.has(stage)) {
      console.error(
        `slowcook worker: live mode for "${stage}" is not enabled in this build ` +
          `(currently: ${[...LIVE_STAGES].join(", ")}). Refusing rather than pretending.`
      );
      process.exit(2);
    }
  }

  const { owner, repo } = resolveOwnerRepo(args);
  if (!owner || !repo) {
    console.error(
      "slowcook worker: cannot resolve the target repo.\n" +
        "  Pass --owner and --repo, or run inside a checkout whose origin points at GitHub."
    );
    process.exit(2);
  }

  // Forge identity, in preference order (ledger O2):
  //   1. GitHub App installation token — agents post as <app-slug>[bot],
  //      the identity that scales to every consumer org.
  //   2. Operator token (GITHUB_TOKEN / GH_TOKEN) — comments show the
  //      OPERATOR as author; fine for bootstrap, wrong attribution at scale.
  // An App that is CONFIGURED but cannot mint is a hard stop — silently
  // posting as the operator would defeat the reason the App exists.
  let token: string;
  let forgeIdentity: string;
  if (appAuthConfigured()) {
    try {
      const minted = await mintInstallationToken(owner, repo);
      token = minted.token;
      forgeIdentity = `${minted.appSlug}[bot]`;
    } catch (e) {
      console.error((e as Error).message);
      process.exit(2);
    }
  } else {
    const envToken = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
    if (!envToken) {
      console.error(
        "slowcook worker: no forge identity configured.\n" +
          "  Either set the GitHub App identity (SLOWCOOK_GITHUB_APP_ID +\n" +
          "  SLOWCOOK_GITHUB_APP_PRIVATE_KEY_PATH — agents then post as the App's\n" +
          "  [bot] user), or set GITHUB_TOKEN / GH_TOKEN (posts as that account):\n" +
          "  GH_TOKEN=$(gh auth token) slowcook worker run --dry-run"
      );
      process.exit(2);
    }
    token = envToken;
    forgeIdentity = "operator-token";
  }
  console.log(`identity: ${forgeIdentity}`);

  mkdirSync(args.logsDir, { recursive: true });
  const lockPath = args.lockPath ?? join(args.logsDir, "worker.lock");
  const lock = acquireWorkerLock(lockPath);
  if (!lock.acquired) {
    console.error(`slowcook worker: ${lock.message}`);
    process.exit(3);
  }
  if (lock.tookOverFrom) {
    console.error(
      `note: took over a stale lock from pid ${lock.tookOverFrom.pid}@${lock.tookOverFrom.host} (started ${lock.tookOverFrom.startedAt})`
    );
  }

  try {
    const issues = await fetchTriggerIssues({ owner, repo, token });
    const jobs = deriveJobs(issues, (issue) => gatherFacts(args.repoRoot, issue));
    const summary = summarizeWorkload(issues, jobs);

    // Publish the workload every pass — the reportable state labels can't express.
    writeFileSync(
      join(args.logsDir, "workload.json"),
      JSON.stringify(
        { generatedAt: new Date().toISOString(), repo: `${owner}/${repo}`, ...summary },
        null,
        2
      ) + "\n",
      "utf8"
    );

    let processed: { job: WorkerJob; traceDir: string; outcome: JobOutcome } | null = null;
    if (jobs.length > 0) {
      // One job per pass (plan §2). The ordering policy already put the
      // most urgent first: blocked jobs surface their upstream gap before
      // fresh work advances. In live mode, only enabled stages execute —
      // the rest stay visible in the workload and untouched.
      if (args.dryRun) {
        const job = jobs[0]!;
        processed = processDry(job, args, forgeIdentity);
      } else {
        const job = jobs.find((j) => args.enable.has(j.agent));
        if (job) {
          processed = await processLive(job, args, { owner, repo, token }, forgeIdentity);
        }
      }
    }

    if (args.json) {
      console.log(JSON.stringify({ workload: summary, processed }, null, 2));
      return;
    }

    console.log(`workload: ${renderWorkloadLine(summary)}`);
    for (const j of summary.jobs) {
      console.log(
        `  #${j.issue} ${j.agent}${j.storyId ? ` (story-${j.storyId})` : ""} — ${j.runnable ? "runnable" : "BLOCKED: precondition missing"}`
      );
    }
    if (processed) {
      console.log(
        `\nprocessed (${args.dryRun ? "dry-run" : "live"}) #${processed.job.issue} → ${processed.outcome}\n  trace: ${processed.traceDir}`
      );
      if (processed.outcome === "precondition-missing") {
        for (const c of processed.job.preconditions.filter((x) => x.status === "fail")) {
          console.log(
            `  MISSING ${c.name}${c.upstream ? ` (upstream: ${c.upstream})` : ""}: ${c.detail}`
          );
        }
      }
    } else {
      console.log("nothing to do — no trigger labels found.");
    }
  } finally {
    releaseWorkerLock(lockPath);
  }
}

function processDry(
  job: WorkerJob,
  args: RunArgs,
  forgeIdentity: string
): { job: WorkerJob; traceDir: string; outcome: JobOutcome } {
  const outcome: JobOutcome = job.runnable ? "dry-run" : "precondition-missing";
  const failed = job.preconditions.filter((c) => c.status === "fail");
  const now = new Date();
  const traceDir = writeTrace(
    args.logsDir,
    {
      job,
      cmd: {
        argv: job.cmd,
        envNames: presentEnvNames(),
        backend: detectBackend(),
    forgeIdentity,
        cwd: args.repoRoot,
        gitSha: gitShaOf(args.repoRoot),
        startedAt: now.toISOString(),
      },
      outcome: {
        outcome,
        ...(failed.length > 0 ? { failedPreconditions: failed } : {}),
        detail:
          outcome === "dry-run"
            ? `dry-run: would remove ${job.triggerLabel}, run \`${job.cmd.join(" ")}\`, then apply ${RESULT_LABELS[job.agent]} on success or ${FAILED_LABEL} on failure. No mutation performed.`
            : `precondition missing — the worker records and stops; repairing would hide the upstream defect. Failed: ${failed.map((c) => c.name).join(", ")}.`,
        finishedAt: new Date().toISOString(),
      },
      handoff: {
        producedFor: nextAgentOf(job.agent),
        artifacts: [],
        hash: null,
      },
    },
    now
  );
  return { job, traceDir, outcome };
}

/**
 * Execute one job live (W1+). The worker stays thin: remove the trigger
 * label (crash-safe — a stuck job never re-fires), spawn the agent,
 * capture everything, map the agent's OWN output to worker state, apply
 * the result label, trace. A missing precondition is recorded and
 * terminal — never repaired (plan §3).
 */
async function processLive(
  job: WorkerJob,
  args: RunArgs,
  gh: { owner: string; repo: string; token: string },
  forgeIdentity: string
): Promise<{ job: WorkerJob; traceDir: string; outcome: JobOutcome }> {
  const octokit = new Octokit({ auth: gh.token, userAgent: "slowcook-ai/cli worker" });
  const now = new Date();
  const runId = traceDirName(job, now);

  // Trigger label off FIRST. If this fails, abort the job — a pass that
  // runs without consuming its trigger can double-fire on the next timer.
  await octokit.issues.removeLabel({
    owner: gh.owner,
    repo: gh.repo,
    issue_number: job.issue,
    name: job.triggerLabel,
  });

  const cmdRecord = {
    argv: job.cmd,
    envNames: presentEnvNames(),
    backend: detectBackend(),
    forgeIdentity,
    cwd: args.repoRoot,
    gitSha: gitShaOf(args.repoRoot),
    startedAt: now.toISOString(),
  };

  if (!job.runnable) {
    const failed = job.preconditions.filter((c) => c.status === "fail");
    const traceDir = writeTrace(
      args.logsDir,
      {
        job,
        cmd: cmdRecord,
        outcome: {
          outcome: "precondition-missing",
          failedPreconditions: failed,
          detail: `precondition missing — recorded, not repaired. Failed: ${failed.map((c) => c.name).join(", ")}.`,
          finishedAt: new Date().toISOString(),
        },
        handoff: { producedFor: nextAgentOf(job.agent), artifacts: [], hash: null },
      },
      now
    );
    await octokit.issues.addLabels({
      owner: gh.owner,
      repo: gh.repo,
      issue_number: job.issue,
      labels: [FAILED_LABEL],
    });
    await octokit.issues.createComment({
      owner: gh.owner,
      repo: gh.repo,
      issue_number: job.issue,
      body:
        `${commentHeader(job.agent, job.issue, runId)}\n\n` +
        `🛑 **Precondition missing** — the worker records and stops; repairing would hide the upstream defect.\n\n` +
        failed
          .map((c) => `- \`${c.name}\`${c.upstream ? ` (upstream: **${c.upstream}**)` : ""}: ${c.detail}`)
          .join("\n") +
        `\n\nRelabel \`${job.triggerLabel}\` to retry once the upstream artifact exists.` +
        pmCc(args.repoRoot),
    });
    return { job, traceDir, outcome: "precondition-missing" };
  }

  // refine acts ONLY on issues carrying needs-refinement — that label is a
  // precondition by design (dovizir §4), and --no-require-label means
  // "missing label = quiet skip", NOT "act anyway" (ledger G5: the first
  // live run nooped politely because we misread that contract). A human
  // applying agent:refine has declared the issue needs refinement, so the
  // worker publishes that derived state as the label refine requires —
  // label reconciliation per plan §1, not a repair.
  if (job.agent === "refine") {
    await octokit.issues.addLabels({
      owner: gh.owner,
      repo: gh.repo,
      issue_number: job.issue,
      labels: ["needs-refinement"],
    });
  }

  // Spawn the agent through this same CLI entrypoint.
  const spawnArgs = [...job.cmd.slice(1), "--cwd", args.repoRoot];
  const result = spawnSync(process.execPath, [process.argv[1]!, ...spawnArgs], {
    cwd: args.repoRoot,
    encoding: "utf8",
    timeout: args.jobTimeoutMins * 60_000,
    maxBuffer: 64 * 1024 * 1024,
    // The worker resolved ONE forge identity; hand it to the agent under
    // both names — agents disagree on which they read (refine hard-requires
    // GITHUB_TOKEN while gh-based envs export GH_TOKEN; ledger G4).
    env: { ...process.env, GITHUB_TOKEN: gh.token, GH_TOKEN: gh.token },
  });
  const timedOut = result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  const exitCode = result.status ?? -1;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  const mapped = timedOut
    ? {
        outcome: "failed" as const,
        resultLabel: FAILED_LABEL,
        artifacts: [],
        detail: `job exceeded the ${args.jobTimeoutMins}min wall-clock cap and was killed.`,
      }
    : mapLiveOutcome(job.agent, exitCode, stdout);

  // Hash the primary artifact when it is a file we can see; else the
  // stdout fingerprint. Null only when nothing was produced.
  let hash: string | null = null;
  const fileArtifact = mapped.artifacts.find((a) => existsSync(join(args.repoRoot, a)) || existsSync(a));
  if (fileArtifact) {
    const p = existsSync(fileArtifact) ? fileArtifact : join(args.repoRoot, fileArtifact);
    hash = "sha256:" + createHash("sha256").update(readFileSync(p)).digest("hex");
  } else if (mapped.artifacts.length > 0) {
    hash = "sha256(stdout):" + createHash("sha256").update(stdout).digest("hex");
  }

  const traceDir = writeTrace(
    args.logsDir,
    {
      job,
      cmd: cmdRecord,
      outcome: {
        outcome: mapped.outcome,
        detail: mapped.detail,
        finishedAt: new Date().toISOString(),
      },
      handoff: {
        producedFor: nextAgentOf(job.agent),
        artifacts: mapped.artifacts,
        hash,
      },
    },
    now
  );
  writeFileSync(join(traceDir, "stdout"), stdout, "utf8");
  writeFileSync(join(traceDir, "stderr"), stderr, "utf8");

  if (mapped.resultLabel) {
    await octokit.issues.addLabels({
      owner: gh.owner,
      repo: gh.repo,
      issue_number: job.issue,
      labels: [mapped.resultLabel],
    });
  }
  // Chain continuation onto issues the agent filed (approved split): the
  // human gate was the PM's 👍; labeling the children is transport, not a
  // decision, so the worker does it (plan §1 — no human as transport layer).
  for (const n of mapped.advanceIssues ?? []) {
    await octokit.issues.addLabels({
      owner: gh.owner,
      repo: gh.repo,
      issue_number: n,
      labels: ["agent:refine"],
    });
  }
  if (mapped.outcome === "failed") {
    const tail = (s: string, n: number) => s.split("\n").slice(-n).join("\n");
    await octokit.issues.createComment({
      owner: gh.owner,
      repo: gh.repo,
      issue_number: job.issue,
      body:
        `${commentHeader(job.agent, job.issue, runId)}\n\n` +
        `🛑 **${job.agent} failed** — ${mapped.detail}\n\n` +
        `<details><summary>stderr tail</summary>\n\n\`\`\`\n${tail(stderr, 30)}\n\`\`\`\n</details>\n\n` +
        `Terminal until a human relabels \`${job.triggerLabel}\`.` + pmCc(args.repoRoot),
    });
  }
  return { job, traceDir, outcome: mapped.outcome };
}

/** The downstream consumer of each agent's output, for the handoff record. */
function nextAgentOf(agent: keyof typeof RESULT_LABELS): string {
  switch (agent) {
    case "refine":
      return "recipe";
    case "recipe":
      return "brew";
    case "brew":
      return "eye";
    case "eye":
      return "human";
  }
}

/** Env var NAMES relevant to the worker that are present. Never values. */
function presentEnvNames(): string[] {
  return [
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "SLOWCOOK_GITHUB_APP_ID",
    "SLOWCOOK_GITHUB_APP_PRIVATE_KEY_PATH",
    "SLOWCOOK_GITHUB_APP_PRIVATE_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "SLOWCOOK_LLM",
  ].filter((n) => process.env[n] !== undefined);
}

/**
 * Which model backend a live run would use — mirroring the REAL seam in
 * @slowcook-ai/llm-anthropic (`createLlmClient`): SLOWCOOK_LLM=claude-cli
 * selects the subscription runtime; otherwise ANTHROPIC_API_KEY selects
 * the API; otherwise agents throw "No LLM runtime configured". An OAuth
 * token alone does NOT configure a backend — say so, don't imply it does.
 */
function detectBackend(): string {
  const hasKey = process.env["ANTHROPIC_API_KEY"] !== undefined;
  const hasOauth = process.env["CLAUDE_CODE_OAUTH_TOKEN"] !== undefined;
  if (process.env["SLOWCOOK_LLM"]?.trim().toLowerCase() === "claude-cli") {
    if (hasKey)
      return "conflict: SLOWCOOK_LLM=claude-cli set but ANTHROPIC_API_KEY also present — unset one";
    return "claude-cli";
  }
  if (hasKey) return "api";
  if (hasOauth)
    return "unconfigured: CLAUDE_CODE_OAUTH_TOKEN present but SLOWCOOK_LLM=claude-cli not set — agents will refuse";
  return "none";
}

function gitShaOf(repoRoot: string): string {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Gather per-issue artifact facts from the consumer repo. Tri-state:
 * anything not checkable is left undefined ("unknown"), never assumed.
 */
function gatherFacts(repoRoot: string, issue: IssueFact): StoryArtifactFacts {
  const facts: StoryArtifactFacts = {};
  let storyId: string | undefined;
  try {
    const index = readIndex(repoRoot);
    for (const [id, entry] of Object.entries(index.stories ?? {})) {
      const src = entry.source_issue;
      if (!src) continue;
      const num = src.match(/(\d+)\s*$/)?.[1];
      if (num !== undefined && Number(num) === issue.number) {
        storyId = id;
        break;
      }
    }
  } catch {
    // no index — facts stay unknown; the planner reports that, not us.
  }
  if (storyId === undefined) return facts;
  facts.storyId = storyId;

  try {
    const spec = readSpec(repoRoot, storyId);
    facts.specParses = true;
    facts.invariantsNonEmpty = Array.isArray(spec.invariants) && spec.invariants.length > 0;
  } catch {
    facts.specParses = false;
  }

  const manifestPath = join(repoRoot, ".brewing", "manifests", `story-${storyId}.json`);
  if (!existsSync(manifestPath)) {
    facts.manifestExists = false;
  } else {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        tests?: Array<{ file?: string }>;
      };
      facts.manifestExists = true;
      const tests = Array.isArray(manifest.tests) ? manifest.tests : [];
      facts.testsDiscoverable =
        tests.length > 0 &&
        tests.every((t) => typeof t.file === "string" && existsSync(join(repoRoot, t.file)));
    } catch {
      facts.manifestExists = false;
    }
  }
  return facts;
}

interface FetchArgs {
  owner: string;
  repo: string;
  token: string;
}

/** All open issues carrying a trigger label or agent:failed. */
async function fetchTriggerIssues(args: FetchArgs): Promise<IssueFact[]> {
  const octokit = new Octokit({ auth: args.token, userAgent: "slowcook-ai/cli worker" });
  const byNumber = new Map<number, IssueFact>();
  const labels = [...Object.keys(TRIGGER_LABELS), FAILED_LABEL];
  for (const label of labels) {
    let issues;
    try {
      issues = await octokit.paginate(octokit.issues.listForRepo, {
        owner: args.owner,
        repo: args.repo,
        state: "open",
        labels: label,
        per_page: 100,
      });
    } catch (e) {
      // A label that doesn't exist yet returns []; a real API error must
      // not be swallowed — a worker that half-sees the board acts on lies.
      throw new Error(`label scan for "${label}" failed: ${(e as Error).message}`);
    }
    for (const issue of issues) {
      if (issue.pull_request) continue;
      const existing = byNumber.get(issue.number);
      const labelNames = (issue.labels ?? [])
        .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
        .filter((s): s is string => s.length > 0);
      if (existing) {
        for (const l of labelNames) if (!existing.labels.includes(l)) existing.labels.push(l);
        continue;
      }
      byNumber.set(issue.number, {
        number: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        labels: labelNames,
        createdAt: issue.created_at,
      });
    }
  }
  return Array.from(byNumber.values());
}

function parseRunArgs(argv: string[]): RunArgs {
  const out: RunArgs = {
    repoRoot: process.cwd(),
    owner: undefined,
    repo: undefined,
    dryRun: false,
    enable: new Set<AgentKind>(),
    jobTimeoutMins: 30,
    logsDir: join(process.cwd(), ".slowcook", "worker-logs"),
    lockPath: undefined,
    json: false,
  };
  let logsDirSet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--cwd" && next) {
      out.repoRoot = next;
      if (!logsDirSet) out.logsDir = join(next, ".slowcook", "worker-logs");
      i++;
    } else if (a === "--owner" && next) {
      out.owner = next;
      i++;
    } else if (a === "--repo" && next) {
      out.repo = next;
      i++;
    } else if (a === "--logs-dir" && next) {
      out.logsDir = next;
      logsDirSet = true;
      i++;
    } else if (a === "--lock" && next) {
      out.lockPath = next;
      i++;
    } else if (a === "--dry-run") {
      out.dryRun = true;
    } else if (a === "--enable" && next) {
      for (const s of next.split(",").map((x) => x.trim()).filter(Boolean)) {
        out.enable.add(s as AgentKind);
      }
      i++;
    } else if (a === "--job-timeout-mins" && next) {
      out.jobTimeoutMins = Number(next) || out.jobTimeoutMins;
      i++;
    } else if (a === "--json") {
      out.json = true;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return out;
}

function resolveOwnerRepo(args: RunArgs): {
  owner: string | undefined;
  repo: string | undefined;
} {
  if (args.owner && args.repo) return { owner: args.owner, repo: args.repo };
  try {
    const url = execSync("git remote get-url origin", {
      cwd: args.repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (m) return { owner: args.owner ?? m[1], repo: args.repo ?? m[2] };
  } catch {
    // not a git repo, or no origin — caller reports.
  }
  return { owner: args.owner, repo: args.repo };
}

function printSystemd(argv: string[]): void {
  let repoPath = "/root/rewo";
  let logsDir = "/root/rewo-run/logs";
  let envFile = "/root/.slowcook-worker.env";
  let interval = "3min";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--repo-path" && next) { repoPath = next; i++; }
    else if (a === "--logs-dir" && next) { logsDir = next; i++; }
    else if (a === "--env-file" && next) { envFile = next; i++; }
    else if (a === "--interval" && next) { interval = next; i++; }
  }
  // Two lessons from the first real box install (ledger G2,
  // docs/plans/rewo-run-gaps.md): operator env files are shell-format
  // (`export X=…`), which systemd's EnvironmentFile= cannot parse, and
  // oneshot units get no HOME, so `gh auth token` silently returns nothing.
  console.log(`# /etc/systemd/system/slowcook-worker.service
[Unit]
Description=slowcook agent worker (one pass)

[Service]
Type=oneshot
Environment=HOME=/root
# The env file is sourced (it may use shell \`export X=…\` syntax, which
# EnvironmentFile= cannot parse). A stale ANTHROPIC_API_KEY silently
# outranks the OAuth token — unset it. GH_TOKEN comes from the box's gh
# login so the write identity is exactly whoever the operator authenticated.
ExecStart=/bin/bash -c 'set -a; . ${envFile}; set +a; unset ANTHROPIC_API_KEY; export GH_TOKEN=$(gh auth token); exec /usr/local/bin/slowcook worker run --dry-run --cwd ${repoPath} --logs-dir ${logsDir} --lock /run/slowcook-worker.lock'
WorkingDirectory=${repoPath}

# /etc/systemd/system/slowcook-worker.timer
[Unit]
Description=slowcook agent worker timer

[Timer]
OnBootSec=2min
OnUnitActiveSec=${interval}

[Install]
WantedBy=timers.target

# install:
#   systemctl daemon-reload && systemctl enable --now slowcook-worker.timer
# watch:
#   journalctl -u slowcook-worker.service -f
# go live (W1, spends money): replace --dry-run with --enable refine and add
#   'export SLOWCOOK_LLM=claude-cli' to the env file (an OAuth token alone
#   does not configure a backend — agents refuse without the seam set).
# agent identity (recommended): register a GitHub App for your org, install
#   it on the repo, then add to the env file:
#     export SLOWCOOK_GITHUB_APP_ID=<id>
#     export SLOWCOOK_GITHUB_APP_PRIVATE_KEY_PATH=/root/slowcook-agent.pem
#   Agents then post as <app-slug>[bot] instead of the operator's account.`);
}

function printHelp(): void {
  console.log(`
slowcook worker — label-triggered agent worker (W0: dry-run only)

Usage:
  slowcook worker run (--dry-run | --enable refine) [--cwd <path>] [--owner <login>]
                      [--repo <name>] [--logs-dir <path>] [--lock <path>]
                      [--job-timeout-mins <n>] [--json]
  slowcook worker systemd [--repo-path <p>] [--logs-dir <p>] [--env-file <p>] [--interval <t>]

run     One worker pass: scan agent:* trigger labels on open issues,
        derive the workload, evaluate each triggered agent's
        preconditions, and process at most ONE job. In --dry-run
        nothing is mutated and nothing is spawned; the pass writes a
        trace directory per job and workload.json.

        With --enable <stages> the listed stages execute LIVE: the
        worker removes the trigger label (crash-safe), spawns the
        agent, captures stdout/stderr into the trace, applies the
        result label the agent's own output justifies, and reports
        failures as an issue comment (terminal until a human
        relabels). This build allows: refine (W1). A refine that
        pauses for a human (questions / overlap / split) gets NO
        result label — refine's issue conventions carry on.

        Trigger labels: ${Object.keys(TRIGGER_LABELS).join(", ")}
        Terminal label: ${FAILED_LABEL} (excluded until a human relabels)

        Outcomes: dry-run | precondition-missing. A missing precondition
        NAMES the upstream agent that under-delivered — the worker
        records and stops; it never repairs.

systemd Print the service + timer units for a box install (oneshot
        pass every 3min, lock at /run/slowcook-worker.lock).

Environment:
  SLOWCOOK_GITHUB_APP_ID + SLOWCOOK_GITHUB_APP_PRIVATE_KEY_PATH
                            preferred forge identity — a GitHub App the
                            consumer org installs once; agents post as
                            <app-slug>[bot]. Configured-but-broken is a
                            hard stop (never silently falls back).
  GITHUB_TOKEN | GH_TOKEN   fallback identity — posts as that account.
                            One of the two identities is required.
  CLAUDE_CODE_OAUTH_TOKEN   model backend for live runs (W1+): claude-cli.
  ANTHROPIC_API_KEY         model backend for live runs (W1+): api.
                            Both set = a named conflict in the trace.

Plan: docs/plans/rewo-agent-workers.md
`);
}
