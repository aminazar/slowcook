import { execSync } from "node:child_process";
import { Octokit } from "@octokit/rest";

/**
 * `slowcook dispatch <step>` — trigger a slowcook GitHub Actions
 * workflow remotely. Ops convenience so operators don't have to
 * remember workflow filenames + input schemas.
 *
 * Distinct from running a step LOCALLY (`slowcook brew --story X`
 * runs brew on your workstation with your ANTHROPIC_API_KEY against
 * local git state). This command TRIGGERS the workflow on GitHub
 * Actions with the repo's configured secrets.
 *
 * Supported steps (must have `workflow_dispatch` configured in the
 * template):
 *   - brew     — slowcook-brew.yml (takes --story, --budget-usd,
 *                --max-iterations, --model)
 *   - testgen  — slowcook-testgen.yml (no inputs; runs `testgen --all`)
 *   - refine   — slowcook-refine.yml (takes --issue) [0.7.13+ workflow]
 *
 * on-*-merged hooks aren't supported — they fire from pull_request.closed
 * events and need a PR number, which is ambiguous to "dispatch manually."
 */

type Step = "brew" | "testgen" | "refine";

interface StepConfig {
  workflow: string;
  inputs: Record<string, string>;
  /** Inputs that MUST be present for this step (fail fast with helpful error). */
  requiredInputs: string[];
}

function buildStepConfig(step: Step, args: Record<string, string>): StepConfig {
  switch (step) {
    case "brew":
      return {
        workflow: "slowcook-brew.yml",
        inputs: {
          story_id: args.story ?? args.story_id ?? "",
          budget_usd: args["budget-usd"] ?? args.budget ?? "10",
          max_iterations: args["max-iterations"] ?? args.iterations ?? "10",
          model: args.model ?? "claude-sonnet-4-6",
        },
        requiredInputs: ["story_id"],
      };
    case "testgen":
      return {
        workflow: "slowcook-testgen.yml",
        inputs: {},
        requiredInputs: [],
      };
    case "refine":
      return {
        workflow: "slowcook-refine.yml",
        inputs: {
          issue_number: args.issue ?? args.issue_number ?? "",
        },
        requiredInputs: ["issue_number"],
      };
    default: {
      const exhaustive: never = step;
      throw new Error(`Unknown step: ${exhaustive}`);
    }
  }
}

function parseArgs(argv: string[]): {
  step: Step | null;
  args: Record<string, string>;
  ref: string;
  help: boolean;
} {
  const result = {
    step: null as Step | null,
    args: {} as Record<string, string>,
    ref: "main",
    help: false,
  };
  if (argv.length === 0) {
    result.help = true;
    return result;
  }
  const first = argv[0];
  if (first === "-h" || first === "--help") {
    result.help = true;
    return result;
  }
  // 0.13.0-alpha.1 — `recipe` is the canonical name for the testgen
  // step. Both names dispatch to the same workflow.
  if (first === "recipe") {
    result.step = "testgen";
  } else if (first !== "brew" && first !== "testgen" && first !== "refine") {
    throw new Error(
      `Unknown step '${first}'. Supported: brew, recipe (testgen), refine.`
    );
  } else {
    result.step = first;
  }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      result.help = true;
      return result;
    }
    if (arg === "--ref") {
      const next = argv[i + 1];
      if (!next) throw new Error("--ref requires a value");
      result.ref = next;
      i++;
      continue;
    }
    if (arg && arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        // Boolean flag with no value — rare; treat as "true"
        result.args[key] = "true";
      } else {
        result.args[key] = next;
        i++;
      }
    }
  }
  return result;
}

function printHelp(): void {
  console.log(`
slowcook dispatch — trigger a slowcook GitHub Actions workflow remotely

Usage:
  slowcook dispatch <step> [options]

Steps:
  brew     --story <id> [--budget-usd <n>] [--max-iterations <n>] [--model <id>]
  testgen  (no inputs; runs testgen --all against current main)
  refine   --issue <number>    (requires slowcook-refine.yml with workflow_dispatch; 0.7.13+)

Common options:
  --ref <ref>    Git ref to dispatch against (default: main)
  --help, -h     Show this help

Environment:
  GITHUB_TOKEN   Required. Token with actions:write scope.

Examples:
  slowcook dispatch brew --story 006 --max-iterations 20
  slowcook dispatch brew --story 006 --budget-usd 15 --model claude-opus-4-7
  slowcook dispatch testgen
  slowcook dispatch refine --issue 47

Exit codes:
  0   dispatched successfully
  2   script error (bad args, missing token, API failure)
`);
}

function detectOwnerRepo(cwd: string): { owner: string; repo: string } | null {
  try {
    const url = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (m && m[1] && m[2]) return { owner: m[1], repo: m[2] };
  } catch {
    /* ignore */
  }
  return null;
}

export async function dispatch(argv: string[]): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    printHelp();
    process.exit(2);
  }

  if (parsed.help || !parsed.step) {
    printHelp();
    process.exit(parsed.step ? 0 : (parsed.help ? 0 : 2));
  }

  const token = process.env["GITHUB_TOKEN"];
  if (!token) {
    console.error("GITHUB_TOKEN environment variable is not set.");
    console.error("Get one with `gh auth token` or create a PAT with `actions:write` scope.");
    process.exit(2);
  }

  const detected = detectOwnerRepo(process.cwd());
  if (!detected) {
    console.error(
      "Could not detect owner/repo from git remote 'origin'. Run from inside a git repo with a GitHub remote."
    );
    process.exit(2);
  }
  const { owner, repo } = detected;

  const cfg = buildStepConfig(parsed.step, parsed.args);
  const missing = cfg.requiredInputs.filter((k) => !cfg.inputs[k]);
  if (missing.length > 0) {
    console.error(
      `Missing required input(s) for '${parsed.step}': ${missing.join(", ")}.`
    );
    printHelp();
    process.exit(2);
  }

  const octokit = new Octokit({ auth: token, userAgent: "slowcook-ai/cli" });

  try {
    await octokit.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: cfg.workflow,
      ref: parsed.ref,
      inputs: cfg.inputs,
    });
  } catch (e) {
    const status = (e as { status?: number }).status;
    const msg = (e as Error).message;
    if (status === 404) {
      console.error(
        `Workflow '${cfg.workflow}' not found in ${owner}/${repo} (or missing 'workflow_dispatch' trigger). Verify the workflow exists on the ${parsed.ref} branch.`
      );
    } else if (status === 403) {
      console.error(
        `GITHUB_TOKEN lacks permission to dispatch workflows in ${owner}/${repo}. Needs 'actions:write' scope.`
      );
    } else {
      console.error(`Dispatch failed (${status ?? "no-status"}): ${msg}`);
    }
    process.exit(2);
  }

  console.log(
    `Dispatched '${parsed.step}' (${cfg.workflow}) on ${owner}/${repo} @ ${parsed.ref}.`
  );
  const inputLines = Object.entries(cfg.inputs).filter(([, v]) => v);
  if (inputLines.length > 0) {
    console.log("Inputs:");
    for (const [k, v] of inputLines) console.log(`  ${k}: ${v}`);
  }

  // Best-effort: fetch the most recent run for this workflow and print
  // its URL so the operator can click through without hunting. Polls a
  // couple of times because the dispatched run may not appear instantly.
  const runUrl = await findRecentRunUrl(octokit, owner, repo, cfg.workflow);
  if (runUrl) {
    console.log(`\nRun: ${runUrl}`);
  } else {
    console.log(
      `\nVisit https://github.com/${owner}/${repo}/actions/workflows/${cfg.workflow} to watch.`
    );
  }
}

async function findRecentRunUrl(
  octokit: Octokit,
  owner: string,
  repo: string,
  workflow: string
): Promise<string | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 500 + attempt * 500));
    try {
      const res = await octokit.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id: workflow,
        per_page: 3,
      });
      const run = res.data.workflow_runs.find(
        (r) =>
          r.event === "workflow_dispatch" &&
          (r.status === "queued" || r.status === "in_progress")
      );
      if (run) return run.html_url;
    } catch {
      /* ignore; try again */
    }
  }
  return null;
}
