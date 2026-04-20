import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { execSync } from "node:child_process";
import { buildPlan, InitError, type FileAction, type FileReader } from "./plan.js";

interface InitArgs {
  cwd: string;
  owner: string | undefined;
  force: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): InitArgs {
  const args: InitArgs = {
    cwd: process.cwd(),
    owner: undefined,
    force: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--cwd" && next) {
      args.cwd = resolve(next);
      i++;
    } else if (arg === "--owner" && next) {
      args.owner = next;
      i++;
    } else if (arg === "--force") {
      args.force = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`
slowcook init — scaffold slowcook configuration in a consumer project

Usage:
  slowcook init [options]

Options:
  --cwd <path>       Target project directory (default: current directory)
  --owner <handle>   CODEOWNERS handle/team, e.g. "@aminazar" or "@acme/frontend".
                     If omitted, slowcook tries to detect from \`git remote get-url origin\`;
                     falls back to "@TODO-OWNER" with a warning.
  --force            Overwrite existing slowcook files (default: skip existing)
  --dry-run          Print the plan without writing anything to disk
  --help, -h         Show this help

Writes:
  .brewing/frozen-paths.json
  .brewing/stack.json
  .brewing/README.md
  .brewing/manifests/.gitkeep
  .github/workflows/slowcook.yml
  CODEOWNERS (appends slowcook section if file exists)

Exit codes:
  0  success (or dry-run completed)
  2  script error (no package.json, vitest not detected, etc.)
`);
}

function makeReader(cwd: string): FileReader {
  return {
    exists: (p: string) => existsSync(resolveIn(cwd, p)),
    read: (p: string) => readFileSync(resolveIn(cwd, p), "utf8"),
  };
}

function resolveIn(cwd: string, path: string): string {
  if (isAbsolute(path)) return path;
  return resolve(cwd, path);
}

function detectOwnerFromGitRemote(cwd: string): string | null {
  try {
    const url = execSync("git remote get-url origin", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // https://github.com/USER/REPO.git  |  git@github.com:USER/REPO.git
    const m =
      url.match(/github\.com[:/]([^/]+)\/[^/.]+(?:\.git)?$/) ??
      url.match(/gitlab\.com[:/]([^/]+)\/[^/.]+(?:\.git)?$/);
    if (m && m[1]) return `@${m[1]}`;
  } catch {
    // not a git repo, or no origin — fine, fall through
  }
  return null;
}

function formatAction(a: FileAction): string {
  switch (a.kind) {
    case "create":
      return `  CREATE      ${a.path}`;
    case "overwrite":
      return `  OVERWRITE   ${a.path}`;
    case "append":
      return `  APPEND      ${a.path}  (preserving existing content)`;
    case "skip-exists":
      return `  SKIP        ${a.path}  (${a.reason})`;
    case "conflict":
      return `  CONFLICT    ${a.path}  (${a.reason})`;
  }
}

function applyAction(cwd: string, a: FileAction): void {
  if (a.kind === "skip-exists" || a.kind === "conflict") return;
  const full = resolveIn(cwd, a.path);
  mkdirSync(dirname(full), { recursive: true });
  const contents =
    a.kind === "create" || a.kind === "overwrite" || a.kind === "append"
      ? a.contents
      : "";
  writeFileSync(full, contents, "utf8");
}

export async function init(argv: string[], cliVersion: string): Promise<void> {
  const args = parseArgs(argv);
  const reader = makeReader(args.cwd);

  let owner = args.owner;
  if (!owner) {
    const detected = detectOwnerFromGitRemote(args.cwd);
    if (detected) {
      owner = detected;
      console.log(`Detected CODEOWNERS handle from git remote: ${owner}`);
    } else {
      owner = "@TODO-OWNER";
      console.log(
        "::warning::Could not detect a CODEOWNERS handle from git remote. Using @TODO-OWNER as a placeholder — replace it after init."
      );
    }
  }

  let plan;
  try {
    plan = buildPlan(reader, {
      cwd: args.cwd,
      owner,
      force: args.force,
      cliVersion,
    });
  } catch (e) {
    if (e instanceof InitError) {
      console.error(`slowcook init: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }

  console.log(`Detected stack:`);
  console.log(`  language: ${plan.detected.language}`);
  console.log(`  vitest: ${plan.detected.hasVitest}`);
  console.log(`  playwright: ${plan.detected.hasPlaywright}`);
  console.log();

  if (plan.warnings.length > 0) {
    console.log("Warnings:");
    for (const w of plan.warnings) console.log(`  - ${w}`);
    console.log();
  }

  console.log(`Planned file actions (cwd: ${relative(process.cwd(), args.cwd) || "."}):`);
  for (const a of plan.actions) console.log(formatAction(a));
  console.log();

  if (args.dryRun) {
    console.log("Dry-run complete — no files written.");
    return;
  }

  for (const a of plan.actions) applyAction(args.cwd, a);

  const skippedCount = plan.actions.filter((a) => a.kind === "skip-exists").length;
  console.log(
    `slowcook init: ${plan.actions.length - skippedCount} file(s) written, ${skippedCount} skipped.`
  );
  console.log();
  console.log("Next steps:");
  console.log(
    `  1. Review .brewing/frozen-paths.json — add/remove directories to match your repo.`
  );
  if (owner === "@TODO-OWNER") {
    console.log(`  2. Replace @TODO-OWNER in CODEOWNERS with your GitHub handle/team.`);
  }
  console.log(
    `  ${owner === "@TODO-OWNER" ? "3." : "2."} Run \`slowcook manifest record\` once your test set is stable.`
  );
  console.log(
    `  ${owner === "@TODO-OWNER" ? "4." : "3."} Commit and open a PR; slowcook CI will run on it.`
  );
}
