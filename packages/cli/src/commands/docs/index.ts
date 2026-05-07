/**
 * `slowcook docs <topic>` — print bundled documentation pages.
 *
 * Useful when an agent (or maintainer) is on a fresh box without
 * cloned slowcook repo — `slowcook docs reporting` prints
 * REPORTING.md straight from the installed package. Same shape as
 * `git help <topic>` or `npm help <topic>`.
 *
 * Topics today:
 *   reporting   — how to file a slowcook bug
 *   agents      — onboarding doc for AI agents using slowcook (stub
 *                 until AGENTS.md ships)
 *   read-only   — read-only mode reference (SLOWCOOK_READ_ONLY env var)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TOPICS: Record<string, string> = {
  reporting: "REPORTING.md",
  agents: "AGENTS.md",
  // 'read-only' is a synthetic topic — content is built inline below.
  "read-only": "",
};

function repoRootDocPath(filename: string): string | null {
  // Walk up from this file's location to find the repo root (where
  // REPORTING.md / AGENTS.md live). When installed via npm, the file
  // sits at `node_modules/@slowcook-ai/cli/dist/commands/docs/index.js`,
  // so the docs would be at `node_modules/@slowcook-ai/cli/REPORTING.md`
  // — we package them as `files` in package.json.
  // When run from the monorepo, files are at the repo root directly.
  const candidates = [
    join(__dirname, "..", "..", "..", filename), // installed: dist/commands/docs/ → package root
    join(__dirname, "..", "..", "..", "..", filename), // monorepo: src/commands/docs/ → cli root
    join(__dirname, "..", "..", "..", "..", "..", filename), // monorepo: cli root → repo root
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

const READ_ONLY_DOC = `# Read-only mode

Set the env var \`SLOWCOOK_READ_ONLY=1\` and slowcook commands will
NOT write to the consumer's GitHub repo. Use this when running
slowcook on someone else's repo to reproduce a bug — you can
exercise the LLM + see verdicts without commenting / committing /
pushing / labeling / closing.

What it gates:

- chef-drift: skips applying edits, committing, pushing, posting
  audit comment.
- chef-orchestrate: skips posting escalation/close comments,
  applying labels, calling \`gh pr close\`. Verdict is still
  computed + persisted to disk (in your local cwd, not the consumer's
  repo).
- chef (PR-CI handler): skips posting any comment + dispatching
  retries.
- recon \`--stub-escalate\`: skips posting PM comments on source
  issues.
- recon \`--write-proposals\` (under \`--reuse-scan\`): skips
  appending to \`.brewing/refactor/proposals.json\` (still prints to
  stdout).

What it does NOT gate (intentional):

- Local file reads (cloning, fetching PR heads, reading source).
- Local artifact writes to the maintainer's own \`/tmp/\` and
  \`.brewing/\` (these aren't pushed anywhere).
- The Anthropic API call itself (you pay your own tokens for
  reproduction).

Use the per-command \`--dry-run\` flag for command-specific gating
when you want SOME writes (e.g., to your local \`.brewing/\`) but no
GitHub-side writes. \`SLOWCOOK_READ_ONLY=1\` is the broader knob.

Example reproducing a chef-drift bug from a downloaded artifact:

\`\`\`bash
gh run download <run-id> -n chef-drift-story-N -D /tmp/repro
gh repo clone <consumer-repo> /tmp/consumer
cd /tmp/consumer && gh pr checkout <pr-num>
SLOWCOOK_READ_ONLY=1 ANTHROPIC_API_KEY=... slowcook chef-drift \\
  --pr <pr-num> --story <id> --trigger brew_halt_class \\
  --trigger-raw /tmp/repro/chef-drift-input/halt-trigger.json
\`\`\`

No edits, no comments, no pushes will hit the consumer's repo. The
verdict prints to stdout + persists to YOUR \`.brewing/chef/\`
locally.
`;

export async function docs(argv: string[], _cliVersion: string): Promise<void> {
  const topic = argv[0];
  if (!topic || topic === "--help" || topic === "-h") {
    console.log(`slowcook docs <topic>`);
    console.log("");
    console.log("Topics:");
    for (const t of Object.keys(TOPICS)) {
      console.log(`  ${t}`);
    }
    console.log("");
    console.log("Example:  slowcook docs reporting");
    process.exit(topic ? 0 : 64);
  }

  if (topic === "read-only") {
    console.log(READ_ONLY_DOC);
    return;
  }

  const filename = TOPICS[topic];
  if (!filename) {
    console.error(`Unknown topic: ${topic}`);
    console.error(`Available: ${Object.keys(TOPICS).join(", ")}`);
    process.exit(64);
  }

  const path = repoRootDocPath(filename);
  if (!path) {
    console.error(`Could not locate ${filename} on disk.`);
    console.error(`(Looked relative to ${__dirname}.)`);
    console.error(`If installed from npm, this likely means the package's`);
    console.error(`files: field doesn't include ${filename}. File a bug.`);
    process.exit(2);
  }
  console.log(readFileSync(path, "utf8"));
}
