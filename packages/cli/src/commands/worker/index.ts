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
  deriveResubmitJobs,
  deriveRecipeJobs,
  deriveTasteJobs,
  deriveBrewJobs,
  DERIVED_SPEC_REVIEW_TRIGGER,
  summarizeWorkload,
  renderWorkloadLine,
  TRIGGER_LABELS,
  FAILED_LABEL,
  RESULT_LABELS,
  type IssueFact,
  type StoryArtifactFacts,
  type SpecReadyFact,
  type BrewReadyFact,
  type AgentPrFact,
  type WorkerJob,
} from "./plan.js";
import { writeTrace, traceDirName, type JobOutcome } from "./trace.js";
import { checkoutStatusLine, renderWorkloadView } from "./workload.js";
import {
  AWAITING_PM_LABEL,
  ROLLUP_MARKER,
  ROLLUP_TITLE,
  buildRollupItems,
  parseRollupKeys,
  renderRollupBody,
} from "./pm-rollup.js";
import { needsTriageReply, renderTriageReply, STALE_PREMISE_MARKER } from "./stale-premise.js";
import { mapLiveOutcome, commentHeader } from "./live.js";
import { acquireWorkerLock, releaseWorkerLock } from "./worker-lock.js";
import { pmCc } from "../../lib/pm-notify.js";
import type { AgentKind } from "./plan.js";

/** Stages allowed to run live in this build. Widened one phase at a time
 *  (plan §6) — never before the upstream handoff contract is verified. */
const LIVE_STAGES: ReadonlySet<AgentKind> = new Set(["refine", "recipe", "taste", "brew"]);

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
  baseBranch: string;
  json: boolean;
}

export async function worker(argv: string[]): Promise<void> {
  const sub = argv[0];
  switch (sub) {
    case "run":
      return runPass(argv.slice(1));
    case "workload":
      return inspectWorkload(argv.slice(1));
    case "deploy": {
      const { workerDeploy } = await import("./deploy.js");
      return workerDeploy(argv.slice(1));
    }
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

/** `slowcook worker workload` (also exposed as top-level `slowcook
 *  workload`) — read-only view of the derived workload (D5). Never
 *  mutates the checkout; a mismatched checkout is reported, not fixed. */
async function inspectWorkload(argv: string[]): Promise<void> {
  const args = parseRunArgs(argv);
  const { owner, repo } = resolveOwnerRepo(args);
  if (!owner || !repo) {
    console.error("slowcook workload: cannot resolve the target repo (pass --owner/--repo).");
    process.exit(2);
  }
  const identity = await resolveForgeIdentity(owner, repo);
  const checkoutLine = checkoutStatusLine(args.repoRoot, args.baseBranch);
  const fetchArgs = { owner, repo, token: identity.token };
  const issues = await fetchTriggerIssues(fetchArgs);
  const { agentPrFacts, openHeadRefs } = await fetchOpenPrFacts(fetchArgs);
  const specReady = gatherSpecReadyFacts(args.repoRoot, openHeadRefs);
  const jobs = [
    ...deriveResubmitJobs(agentPrFacts),
    ...deriveTasteJobs(agentPrFacts),
    ...deriveRecipeJobs(specReady),
    ...deriveBrewJobs(await gatherBrewReadyFacts(fetchArgs, specReady, openHeadRefs)),
    ...deriveJobs(issues, (issue) => gatherFacts(args.repoRoot, issue)),
  ];
  if (args.json) {
    console.log(
      JSON.stringify(
        { identity: identity.forgeIdentity, checkout: checkoutLine, workload: summarizeWorkload(issues, jobs), jobs },
        null,
        2
      )
    );
    return;
  }
  console.log(
    renderWorkloadView({ identity: identity.forgeIdentity, checkoutLine, issues, jobs })
  );
}

/** Forge identity, in preference order (ledger O2): App installation
 *  token (posts as <app-slug>[bot]; configured-but-broken is a hard
 *  stop) → operator token. Shared by run and workload. */
async function resolveForgeIdentity(
  owner: string,
  repo: string
): Promise<{ token: string; forgeIdentity: string }> {
  if (appAuthConfigured()) {
    try {
      const minted = await mintInstallationToken(owner, repo);
      return { token: minted.token, forgeIdentity: `${minted.appSlug}[bot]` };
    } catch (e) {
      console.error((e as Error).message);
      process.exit(2);
    }
  }
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
  return { token: envToken, forgeIdentity: "operator-token" };
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
  const { token, forgeIdentity } = await resolveForgeIdentity(owner, repo);
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
    // THE WORKER OWNS THE CHECKOUT STATE BETWEEN JOBS (G9 family): repo
    // facts (specs, manifests) are only meaningful on an up-to-date base
    // branch. Agents may leave the checkout on their work branches; every
    // pass puts it back and pulls. Fail closed on a dirty tree.
    ensureBaseCheckout(args.repoRoot, args.baseBranch);

    const issues = await fetchTriggerIssues({ owner, repo, token });
    const { agentPrFacts, openHeadRefs } = await fetchOpenPrFacts({ owner, repo, token });
    // Unanswered spec-PR feedback outranks fresh triggers (plan §1 rule 1).
    const specReady = gatherSpecReadyFacts(args.repoRoot, openHeadRefs);
    const jobs = [
      ...deriveResubmitJobs(agentPrFacts),
      ...deriveTasteJobs(agentPrFacts),
      ...deriveRecipeJobs(specReady),
      ...deriveBrewJobs(
        await gatherBrewReadyFacts({ owner, repo, token }, specReady, openHeadRefs)
      ),
      ...deriveJobs(issues, (issue) => gatherFacts(args.repoRoot, issue)),
    ];
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

    // PM halt roll-up (D6): reconcile the one "waiting on the PM" issue
    // from derived state. Live passes only (dry-run mutates nothing);
    // best-effort — a roll-up failure must never kill the pass.
    if (!args.dryRun) {
      try {
        await reconcilePmRollup(
          { owner, repo, token },
          args.repoRoot,
          issues,
          agentPrFacts
        );
      } catch (e) {
        console.error(`warn: pm-rollup reconcile failed: ${(e as Error).message}`);
      }
      try {
        await triageStalePremiseComments({ owner, repo, token }, args.repoRoot, openHeadRefs);
      } catch (e) {
        console.error(`warn: stale-premise triage failed: ${(e as Error).message}`);
      }
    }

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


/**
 * Post-spawn forge mutation with a fresh client + one retry (ledger G7).
 * A pass blocks in spawnSync for minutes; the pre-spawn Octokit's
 * keep-alive socket goes stale and the first write after the spawn dies
 * with EPIPE. Each attempt gets a NEW client, and one transient failure
 * (EPIPE/ECONNRESET/timeout/5xx) is retried once after a short pause.
 */
async function forgeMutate<T>(
  token: string,
  fn: (o: Octokit) => Promise<T>
): Promise<T> {
  const attempt = () =>
    fn(new Octokit({ auth: token, userAgent: "slowcook-ai/cli worker" }));
  try {
    return await attempt();
  } catch (e) {
    const msg = (e as Error).message ?? "";
    const status = (e as { status?: number }).status ?? 0;
    const transient =
      /EPIPE|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(msg) || status >= 500;
    if (!transient) throw e;
    await new Promise((r) => setTimeout(r, 2000));
    return attempt();
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

  const derived = job.triggerLabel.startsWith("(derived)");
  // Trigger label off FIRST. If this fails, abort the job — a pass that
  // runs without consuming its trigger can double-fire on the next timer.
  // (Derived jobs have no label; their re-fire guard is the derivation
  // itself — once refine pushes, the review is older than the commit.)
  if (!derived) {
    await octokit.issues.removeLabel({
      owner: gh.owner,
      repo: gh.repo,
      issue_number: job.issue,
      name: job.triggerLabel,
    });
  }

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
  if (job.agent === "refine" && !derived) {
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
    timeout: (job.agent === "brew" ? Math.max(60, args.jobTimeoutMins) : args.jobTimeoutMins) * 60_000,
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

  // Post-spawn mutations must not kill a pass whose artifacts are already
  // on the forge and in the trace — warn and continue on final failure (G7).
  try {
    if (mapped.resultLabel && job.triggerLabel !== DERIVED_SPEC_REVIEW_TRIGGER) {
      await forgeMutate(gh.token, (o) =>
        o.issues.addLabels({
          owner: gh.owner,
          repo: gh.repo,
          issue_number: job.issue,
          labels: [mapped.resultLabel!],
        })
      );
    }
  if (mapped.openPrFromBranch) {
    try {
      const { data: createdPr } = await forgeMutate(gh.token, (o) =>
        o.pulls.create({
          owner: gh.owner,
          repo: gh.repo,
          head: mapped.openPrFromBranch!,
          base: "main",
          draft: true,
          title: `brew: ${job.storyId ? `story-${job.storyId}` : `#${job.issue}`} — ${job.issueTitle}`,
          body:
            `${commentHeader(job.agent, job.issue, runId)}\n\n` +
            `Implementation branch pushed by brew; all story tests green in the run. ` +
            `Closes #${job.issue}.`,
        })
      );
      console.log(`  impl PR opened: #${createdPr.number}`);
    } catch (e) {
      console.error(
        `warning: could not open the impl PR from ${mapped.openPrFromBranch}: ${(e as Error).message}`
      );
    }
  }
  // Chain continuation onto issues the agent filed (approved split): the
  // human gate was the PM's 👍; labeling the children is transport, not a
  // decision, so the worker does it (plan §1 — no human as transport layer).
    for (const n of mapped.advanceIssues ?? []) {
      await forgeMutate(gh.token, (o) =>
        o.issues.addLabels({
          owner: gh.owner,
          repo: gh.repo,
          issue_number: n,
          labels: ["agent:refine"],
        })
      );
    }
    if (mapped.outcome === "failed") {
      const tail = (s: string, n: number) => s.split("\n").slice(-n).join("\n");
      await forgeMutate(gh.token, (o) =>
        o.issues.createComment({
          owner: gh.owner,
          repo: gh.repo,
          issue_number: job.issue,
          body:
        `${commentHeader(job.agent, job.issue, runId)}\n\n` +
        `🛑 **${job.agent} failed** — ${mapped.detail}\n\n` +
        `<details><summary>output tail</summary>\n\n\`\`\`\n${tail(stderr.trim() ? stderr : stdout, 30)}\n\`\`\`\n</details>\n\n` +
        `Terminal until a human relabels \`${job.triggerLabel}\`.` + pmCc(args.repoRoot),
        })
      );
    }
  } catch (e) {
    console.error(
      `warning: post-run forge mutation failed after retry (${(e as Error).message}) — ` +
        `artifacts and trace are intact; label/comment state may lag behind them.`
    );
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
    case "taste":
      return "merge (or the author agent, on requested changes)";
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
 * Put the checkout on the base branch, up to date. Two kinds of "dirt"
 * (ledger G11 — the worker wedged itself for hours over the difference):
 *
 * - MODIFIED/staged tracked files: real uncommitted work → hard stop.
 * - UNTRACKED-only residue: what switching to an older agent branch
 *   leaves behind (files tracked on base but not on that branch become
 *   untracked after reset --hard). Agents commit+push within their job,
 *   so between jobs untracked = branch-switch debris; the checkout's
 *   owner (this worker) cleans it and moves on.
 */
function ensureBaseCheckout(repoRoot: string, base: string): void {
  const lines = execSync("git status --porcelain", { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter((l) => l.trim() && !l.includes(".brewing/history-index"));
  const modified = lines.filter((l) => !l.startsWith("??"));
  if (modified.length > 0) {
    console.error(
      `slowcook worker: checkout at ${repoRoot} has MODIFIED tracked files — refusing to touch it.\n` +
        `  ${modified.slice(0, 5).join("\n  ")}`
    );
    process.exit(2);
  }
  const untracked = lines.filter((l) => l.startsWith("??"));
  if (untracked.length > 0) {
    console.log(
      `note: cleaning ${untracked.length} untracked path(s) — branch-switch residue between jobs`
    );
    execSync(`git checkout -f ${base}`, { cwd: repoRoot, stdio: ["ignore", "ignore", "pipe"] });
    execSync(`git clean -fd -e .brewing/history-index.json`, {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } else {
    execSync(`git checkout ${base}`, { cwd: repoRoot, stdio: ["ignore", "ignore", "pipe"] });
  }
  try {
    execSync(`git pull --ff-only origin ${base}`, {
      cwd: repoRoot,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    // Divergence is a NAMED condition, not an anonymous crash: a local-only
    // commit on base (e.g. crash-recovery residue) means this checkout no
    // longer describes origin — a human must reconcile, the worker must
    // not derive from it.
    const ahead = execSync(`git log --oneline origin/${base}..${base}`, {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);
    console.error(
      `slowcook worker: precondition checkout-ref FAILED — local ${base} diverged from origin/${base}` +
        (ahead.length > 0 ? ` (${ahead.length} local-only commit(s)):\n  ${ahead.slice(0, 5).join("\n  ")}` : ".") +
        `\n  Reconcile (rebase/drop the local commits) before the worker runs again.`
    );
    process.exit(2);
  }
  // The workload describes origin/<base>; assert out loud that we stand
  // there (eleven-defects D2, ledger O1: a pass once derived while the
  // checkout sat on a side branch and nothing said so).
  const headRef = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
  const headSha = execSync("git rev-parse HEAD", { cwd: repoRoot, encoding: "utf8" }).trim();
  const originSha = execSync(`git rev-parse origin/${base}`, { cwd: repoRoot, encoding: "utf8" }).trim();
  if (headRef !== base || headSha !== originSha) {
    console.error(
      `slowcook worker: precondition checkout-ref FAILED — expected ${base} @ ${originSha.slice(0, 9)}, ` +
        `standing on ${headRef} @ ${headSha.slice(0, 9)}. Refusing to derive a workload this checkout does not describe.`
    );
    process.exit(2);
  }
  console.log(`checkout: ${base} @ ${headSha.slice(0, 9)} (matches origin/${base})`);
}


/** D9 — reply once to fresh human comments on merged agent PRs, routing
 *  them to the live venue (nothing watches merged threads otherwise). */
async function triageStalePremiseComments(
  args: FetchArgs,
  repoRoot: string,
  openHeadRefs: string[]
): Promise<void> {
  const octokit = new Octokit({ auth: args.token, userAgent: "slowcook-ai/cli worker" });
  const { data: closed } = await octokit.pulls.list({
    owner: args.owner,
    repo: args.repo,
    state: "closed",
    sort: "updated",
    direction: "desc",
    per_page: 15,
  });
  for (const pr of closed) {
    const m = pr.head?.ref?.match(/slowcook\/(spec|tests|brew)\/story-(.+?)(?:-amend-\d+)?$/);
    if (!m || !pr.merged_at) continue;
    const kind = m[1]!;
    const storyId = m[2]!;
    const { data: comments } = await octokit.issues.listComments({
      owner: args.owner,
      repo: args.repo,
      issue_number: pr.number,
      per_page: 100,
    });
    const mapped = comments.map((c) => ({
      isBot:
        c.user?.type === "Bot" || (c.body ?? "").includes(STALE_PREMISE_MARKER),
      createdAt: c.created_at,
    }));
    if (!needsTriageReply(pr.merged_at, mapped)) continue;
    let sourceIssue: number | null = null;
    try {
      const index = readIndex(repoRoot);
      const src = index.stories?.[storyId]?.source_issue?.match(/(\d+)\s*$/)?.[1];
      if (src) sourceIssue = Number(src);
    } catch { /* venue falls back */ }
    const successor = openHeadRefs.find((r) => r.includes(`story-${storyId}`));
    let successorPr: number | null = null;
    if (successor) {
      try {
        const { data: openPrs } = await octokit.pulls.list({
          owner: args.owner,
          repo: args.repo,
          state: "open",
          head: `${args.owner}:${successor}`,
          per_page: 1,
        });
        successorPr = openPrs[0]?.number ?? null;
      } catch { /* venue falls back */ }
    }
    await octokit.issues.createComment({
      owner: args.owner,
      repo: args.repo,
      issue_number: pr.number,
      body: renderTriageReply({ kind, storyId, sourceIssue, successorPr }),
    });
    console.log(`stale-premise: routed fresh comment on merged PR #${pr.number} (story-${storyId})`);
  }
}

/** D6 — reconcile the single PM roll-up issue from derived state. */
async function reconcilePmRollup(
  args: FetchArgs,
  repoRoot: string,
  issues: IssueFact[],
  prs: AgentPrFact[]
): Promise<void> {
  const octokit = new Octokit({ auth: args.token, userAgent: "slowcook-ai/cli worker" });
  const awaitingPm = (
    await octokit.paginate(octokit.issues.listForRepo, {
      owner: args.owner,
      repo: args.repo,
      state: "open",
      labels: AWAITING_PM_LABEL,
      per_page: 100,
    })
  )
    .filter((i) => !i.pull_request)
    .map((i) => ({ number: i.number, title: i.title }));
  const items = buildRollupItems({ awaitingPm, issues, prs });

  // Find the roll-up issue by its body marker (open first, else the most
  // recent closed one — reopening keeps the thread's history).
  const candidates = await octokit.paginate(octokit.issues.listForRepo, {
    owner: args.owner,
    repo: args.repo,
    state: "all",
    creator: undefined,
    per_page: 100,
  });
  const rollup = candidates.find(
    (i) => !i.pull_request && (i.body ?? "").includes(ROLLUP_MARKER)
  );

  if (!rollup) {
    if (items.length === 0) return; // nothing waiting, nothing to create
    const { data: created } = await octokit.issues.create({
      owner: args.owner,
      repo: args.repo,
      title: ROLLUP_TITLE,
      body: renderRollupBody(items),
    });
    await octokit.issues.createComment({
      owner: args.owner,
      repo: args.repo,
      issue_number: created.number,
      body:
        `New item(s) waiting on the PM:\n` +
        items.map((i) => `- ${i.text}`).join("\n") +
        pmCc(repoRoot),
    });
    console.log(`pm-rollup: created #${created.number} with ${items.length} item(s)`);
    return;
  }

  const previousKeys = parseRollupKeys(rollup.body ?? "");
  const fresh = items.filter((i) => !previousKeys.has(i.key));
  await octokit.issues.update({
    owner: args.owner,
    repo: args.repo,
    issue_number: rollup.number,
    body: renderRollupBody(items),
    state: items.length === 0 ? "closed" : "open",
  });
  if (fresh.length > 0) {
    await octokit.issues.createComment({
      owner: args.owner,
      repo: args.repo,
      issue_number: rollup.number,
      body:
        `New item(s) waiting on the PM:\n` +
        fresh.map((i) => `- ${i.text}`).join("\n") +
        pmCc(repoRoot),
    });
  }
  if (items.length === 0 && rollup.state === "open") {
    console.log(`pm-rollup: all clear — closed #${rollup.number}`);
  } else if (fresh.length > 0) {
    console.log(`pm-rollup: #${rollup.number} updated, ${fresh.length} new item(s) (PM mentioned)`);
  }
}

/** Brew-readiness facts: spec+manifest present, no brew PR, issue unsettled. */
async function gatherBrewReadyFacts(
  args: FetchArgs,
  specReady: SpecReadyFact[],
  openHeadRefs: string[]
): Promise<BrewReadyFact[]> {
  const octokit = new Octokit({ auth: args.token, userAgent: "slowcook-ai/cli worker" });
  const out: BrewReadyFact[] = [];
  for (const f of specReady) {
    if (!f.manifestExists || !f.specParses || f.sourceIssue === null) continue;
    const openBrewPr = openHeadRefs.some((r) => r.includes(`slowcook/brew/story-${f.storyId}`));
    const openTestsPr = openHeadRefs.some((r) =>
      r.includes(`slowcook/tests/story-${f.storyId}`)
    );
    let issueSettled = false;
    if (!openBrewPr) {
      try {
        const { data: issue } = await octokit.issues.get({
          owner: args.owner,
          repo: args.repo,
          issue_number: f.sourceIssue,
        });
        const labels = (issue.labels ?? []).map((l) =>
          typeof l === "string" ? l : (l.name ?? "")
        );
        // Brew follows recipe IN THIS CHAIN: only issues the worker's own
        // recipe stage marked agent:reciped are brew candidates. Old-era
        // stories (shipped before the worker existed) have spec+manifest
        // but never got the label — without this guard the derivation
        // re-implements already-shipped work (ledger G13: the worker
        // started brewing story-001).
        issueSettled =
          issue.state === "closed" ||
          !labels.includes(RESULT_LABELS.recipe) ||
          labels.includes(RESULT_LABELS.brew) ||
          labels.includes(FAILED_LABEL);
      } catch {
        issueSettled = true; // can't verify — do not spend
      }
    }
    out.push({
      storyId: f.storyId,
      sourceIssue: f.sourceIssue,
      title: f.title,
      manifestExists: f.manifestExists,
      specParses: f.specParses,
      openBrewPr,
      openTestsPr,
      specDrifted: f.specDrifted,
      issueSettled,
    });
  }
  return out;
}

/** Stories whose merged spec awaits tests — the recipe derivation facts. */
function gatherSpecReadyFacts(repoRoot: string, openHeadRefs: string[]): SpecReadyFact[] {
  let index;
  try {
    index = readIndex(repoRoot);
  } catch {
    return [];
  }
  const out: SpecReadyFact[] = [];
  for (const [storyId, entry] of Object.entries(index.stories ?? {})) {
    if (entry.superseded_by) continue;
    let specParses = false;
    let invariantsNonEmpty = false;
    try {
      const spec = readSpec(repoRoot, storyId);
      specParses = true;
      invariantsNonEmpty = Array.isArray(spec.invariants) && spec.invariants.length > 0;
    } catch {
      /* not recipe-ready */
    }
    const manifestPath = join(repoRoot, ".brewing", "manifests", `story-${storyId}.json`);
    const manifestExists = existsSync(manifestPath);
    // D10 — drift by content hash: what spec were these tests recorded
    // against, and is that still the spec? Pre-drift manifests carry no
    // hash: that's "unknown", never drift (don't churn old-era stories).
    let specDrifted = false;
    if (manifestExists && specParses) {
      try {
        const recorded = (
          JSON.parse(readFileSync(manifestPath, "utf8")) as { spec_sha256?: string }
        ).spec_sha256;
        if (recorded) {
          const current = createHash("sha256")
            .update(readFileSync(join(repoRoot, "specs", `story-${storyId}.yaml`)))
            .digest("hex");
          specDrifted = recorded !== current;
        }
      } catch { /* unreadable manifest — unknown, not drift */ }
    }
    const openTestsPr = openHeadRefs.some((r) => r.includes(`slowcook/tests/story-${storyId}`));
    const srcNum = entry.source_issue?.match(/(\d+)\s*$/)?.[1];
    out.push({
      storyId,
      sourceIssue: srcNum !== undefined ? Number(srcNum) : null,
      title: entry.title,
      specParses,
      invariantsNonEmpty,
      manifestExists,
      specDrifted,
      openTestsPr,
    });
  }
  return out;
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


/**
 * Open spec PRs with their newest-commit and newest-human-review times —
 * the facts behind derived refine-resubmit jobs (ledger G8). PENDING
 * (draft) reviews are excluded: GitHub shows them only to their author,
 * so acting on one would leak state no other participant can see.
 */
async function fetchOpenPrFacts(
  args: FetchArgs
): Promise<{ agentPrFacts: AgentPrFact[]; openHeadRefs: string[] }> {
  const octokit = new Octokit({ auth: args.token, userAgent: "slowcook-ai/cli worker" });
  const { data: prs } = await octokit.pulls.list({
    owner: args.owner,
    repo: args.repo,
    state: "open",
    per_page: 100,
  });
  const agentPrFacts: AgentPrFact[] = [];
  const openHeadRefs = prs.map((p) => p.head?.ref ?? "").filter(Boolean);
  for (const pr of prs) {
    const ref = pr.head?.ref ?? "";
    if (!ref.includes("slowcook/spec/") && !ref.includes("slowcook/tests/")) continue;
    const [reviews, commits] = await Promise.all([
      octokit.paginate(octokit.pulls.listReviews, {
        owner: args.owner,
        repo: args.repo,
        pull_number: pr.number,
        per_page: 100,
      }),
      octokit.pulls.listCommits({
        owner: args.owner,
        repo: args.repo,
        pull_number: pr.number,
        per_page: 100,
      }),
    ]);
    const submitted = reviews.filter((r) => r.state !== "PENDING" && r.submitted_at);
    const humanReviews = submitted.filter((r) => r.user?.type !== "Bot");
    const lastHumanReviewAt =
      humanReviews.length > 0
        ? humanReviews.map((r) => r.submitted_at!).sort().at(-1)!
        : null;
    const lastAnyReviewAt =
      submitted.length > 0 ? submitted.map((r) => r.submitted_at!).sort().at(-1)! : null;
    const commitDates = commits.data
      .map((c) => c.commit.committer?.date ?? c.commit.author?.date)
      .filter((d): d is string => Boolean(d))
      .sort();
    const lastCommitAt = commitDates.at(-1) ?? pr.created_at;
    agentPrFacts.push({
      prNumber: pr.number,
      headBranch: ref,
      title: pr.title,
      lastCommitAt,
      lastHumanReviewAt,
      lastAnyReviewAt,
      submittedReviewCount: submitted.length,
    });
  }
  return { agentPrFacts, openHeadRefs };
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
    baseBranch: "main",
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
    } else if (a === "--base" && next) {
      out.baseBranch = next;
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
