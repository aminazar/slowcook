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

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Octokit } from "@octokit/rest";
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
import { writeTrace, type JobOutcome } from "./trace.js";
import { acquireWorkerLock, releaseWorkerLock } from "./worker-lock.js";

interface RunArgs {
  repoRoot: string;
  owner: string | undefined;
  repo: string | undefined;
  dryRun: boolean;
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

  // W0: live mode does not exist yet. Refuse loudly rather than pretend.
  if (!args.dryRun) {
    console.error(
      "slowcook worker: live mode is W1+ and not enabled in this build.\n" +
        "  W0 proves the trigger/lock/trace path with zero spend. Run with --dry-run."
    );
    process.exit(2);
  }

  // The worker is inert without auth — by design. Name the missing thing.
  const token = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  if (!token) {
    console.error(
      "slowcook worker: GITHUB_TOKEN / GH_TOKEN is not set.\n" +
        "  The worker reads trigger labels from the forge; without a token it can\n" +
        "  see nothing and will not guess. `gh auth token` supplies one on a box\n" +
        "  where gh is logged in:  GH_TOKEN=$(gh auth token) slowcook worker run --dry-run"
    );
    process.exit(2);
  }

  const { owner, repo } = resolveOwnerRepo(args);
  if (!owner || !repo) {
    console.error(
      "slowcook worker: cannot resolve the target repo.\n" +
        "  Pass --owner and --repo, or run inside a checkout whose origin points at GitHub."
    );
    process.exit(2);
  }

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
      // fresh work advances.
      const job = jobs[0]!;
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
      processed = { job, traceDir, outcome };
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
        `\nprocessed (dry-run) #${processed.job.issue} → ${processed.outcome}\n  trace: ${processed.traceDir}`
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
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "SLOWCOOK_LLM",
  ].filter((n) => process.env[n] !== undefined);
}

/**
 * Which model backend a live run would use. A stale ANTHROPIC_API_KEY
 * silently outranks the OAuth token (the trap in plan §7) — when both
 * are present, SAY SO rather than let a later stage fail opaquely.
 */
function detectBackend(): string {
  const hasKey = process.env["ANTHROPIC_API_KEY"] !== undefined;
  const hasOauth = process.env["CLAUDE_CODE_OAUTH_TOKEN"] !== undefined;
  if (hasKey && hasOauth) return "conflict: ANTHROPIC_API_KEY outranks CLAUDE_CODE_OAUTH_TOKEN — unset one";
  if (hasKey) return "api";
  if (hasOauth) return "claude-cli";
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
#   journalctl -u slowcook-worker.service -f`);
}

function printHelp(): void {
  console.log(`
slowcook worker — label-triggered agent worker (W0: dry-run only)

Usage:
  slowcook worker run --dry-run [--cwd <path>] [--owner <login>] [--repo <name>]
                      [--logs-dir <path>] [--lock <path>] [--json]
  slowcook worker systemd [--repo-path <p>] [--logs-dir <p>] [--env-file <p>] [--interval <t>]

run     One worker pass: scan agent:* trigger labels on open issues,
        derive the workload, evaluate each triggered agent's
        preconditions, and process at most ONE job. In --dry-run
        (mandatory in W0) nothing is mutated and nothing is spawned;
        the pass writes a trace directory per job and workload.json.

        Trigger labels: ${Object.keys(TRIGGER_LABELS).join(", ")}
        Terminal label: ${FAILED_LABEL} (excluded until a human relabels)

        Outcomes: dry-run | precondition-missing. A missing precondition
        NAMES the upstream agent that under-delivered — the worker
        records and stops; it never repairs.

systemd Print the service + timer units for a box install (oneshot
        pass every 3min, lock at /run/slowcook-worker.lock).

Environment:
  GITHUB_TOKEN | GH_TOKEN   required — the worker is inert without auth.
  CLAUDE_CODE_OAUTH_TOKEN   model backend for live runs (W1+): claude-cli.
  ANTHROPIC_API_KEY         model backend for live runs (W1+): api.
                            Both set = a named conflict in the trace.

Plan: docs/plans/rewo-agent-workers.md
`);
}
