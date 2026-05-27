/**
 * `slowcook knowledge add` — α.67
 *
 * Appends an agent-discovered insight to `.brewing/repo-knowledge/
 * curated/<topic>.md` with structured evidence trails. The shared
 * primitive every agent (chef / testgen / vibe / brew / human) uses
 * to contribute to the curated knowledge layer.
 *
 * Output line shape:
 *   - (<agent> · PR #<N> · YYYY-MM-DD · last-verified YYYY-MM-DD) <claim>
 *
 * Why this design (per checkpoint design notes):
 *   - Soft staleness: each entry has evidence (PR + file) + last-verified.
 *     `slowcook knowledge verify` (later alpha) may flag [PRECARIOUS]
 *     when evidence file is substantially rewritten, but never deletes.
 *   - Insights are about CLASSES of problems, not commit snapshots —
 *     "vitest/config not found means deps missing" stays valid even if
 *     vitest.config.ts moves.
 *
 * Topic = filename stem under curated/. Standard names so different
 * agents converge on the same file per concern:
 *   - chef-known-fixes      (chef appends fix recipes)
 *   - test-patterns         (testgen appends helper-naming, mock idioms)
 *   - design-conventions    (vibe appends brand-token decisions)
 *   - brew-patterns         (brew records "Component X follows pattern Y")
 *   - recon-shape-contracts (recon emits structural assertions)
 *   - <custom>              (human-authored or one-off)
 *
 * Idempotency: dedup-by-claim. If the SAME claim text already exists
 * in the topic file, update its last-verified date instead of
 * appending a duplicate.
 *
 * Usage:
 *   slowcook knowledge add chef "vitest/config not found in workflow means pnpm install missing" \
 *     --evidence-pr 686 --evidence-file .github/workflows/slowcook-chef-on-brew-halt.yml
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const CURATED_DIR_REL = ".brewing/repo-knowledge/curated";

export interface KnowledgeAddArgs {
  repoRoot: string;
  agent: string;       // chef | testgen | vibe | brew | recon | <name>
  topic: string;       // e.g. "chef-known-fixes", "test-patterns"
  claim: string;       // one-line insight
  evidencePr?: number; // optional PR number
  evidenceFile?: string; // optional file path
  date?: string;       // ISO YYYY-MM-DD; defaults to today
}

export interface KnowledgeAddResult {
  topicPath: string;
  action: "appended" | "verified-existing" | "created";
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultTopicHeader(topic: string): string {
  // Friendly header for new files; agents/humans can edit at will.
  const friendly = topic
    .split("-")
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
  return [
    `# ${friendly}`,
    "",
    "Agent-curated insights about this repo. Soft signal — entries carry evidence trails but staleness is for review, not auto-invalidation. Use `slowcook knowledge add <agent> '<claim>' --evidence-pr N --evidence-file <path>` to append.",
    "",
  ].join("\n");
}

function formatEntry(args: { agent: string; date: string; lastVerified: string; pr?: number; file?: string; claim: string }): string {
  const parts: string[] = [args.agent];
  if (args.pr !== undefined) parts.push(`PR #${args.pr}`);
  parts.push(args.date);
  parts.push(`last-verified ${args.lastVerified}`);
  if (args.file) parts.push(`evidence \`${args.file}\``);
  const provenance = parts.join(" · ");
  return `- (${provenance}) ${args.claim}`;
}

/** Find an existing entry whose claim text matches; returns its line index or -1. */
function findEntryByClaim(body: string, claim: string): number {
  const lines = body.split("\n");
  const claimTrimmed = claim.trim();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^- \(([^)]+)\)\s+(.*)$/);
    if (m && m[2]!.trim() === claimTrimmed) return i;
  }
  return -1;
}

export function knowledgeAddCore(args: KnowledgeAddArgs): KnowledgeAddResult {
  const date = args.date ?? todayISO();
  const topicPath = join(args.repoRoot, CURATED_DIR_REL, `${args.topic}.md`);
  let body: string;
  let action: KnowledgeAddResult["action"];

  if (existsSync(topicPath)) {
    body = readFileSync(topicPath, "utf8");
    action = "appended";
  } else {
    body = defaultTopicHeader(args.topic);
    action = "created";
  }

  const existingIdx = findEntryByClaim(body, args.claim);
  if (existingIdx !== -1) {
    // Refresh last-verified on the existing entry.
    const lines = body.split("\n");
    const old = lines[existingIdx]!;
    // Replace `last-verified YYYY-MM-DD` substring, or insert if absent.
    let updated = old.replace(/last-verified \d{4}-\d{2}-\d{2}/, `last-verified ${date}`);
    if (updated === old) {
      // No last-verified token present in this older entry — inject one.
      updated = old.replace(/\)\s+/, ` · last-verified ${date}) `);
    }
    lines[existingIdx] = updated;
    body = lines.join("\n");
    action = "verified-existing";
  } else {
    const entry = formatEntry({
      agent: args.agent,
      date,
      lastVerified: date,
      pr: args.evidencePr,
      file: args.evidenceFile,
      claim: args.claim,
    });
    // Ensure body ends with newline before append
    if (!body.endsWith("\n")) body += "\n";
    body += entry + "\n";
  }

  mkdirSync(dirname(topicPath), { recursive: true });
  writeFileSync(topicPath, body, "utf8");
  return { topicPath, action };
}

// --- CLI entry ---

export async function knowledgeAdd(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed.help) { printHelp(); return; }
  if (!parsed.agent || !parsed.claim) {
    console.error("usage: slowcook knowledge add <agent> '<claim>' [--topic <name>] [--evidence-pr N] [--evidence-file <path>]");
    process.exit(64);
  }
  // Default topic per agent — keeps the file naming consistent.
  const topic = parsed.topic ?? defaultTopicForAgent(parsed.agent);
  const result = knowledgeAddCore({
    repoRoot: parsed.repoRoot,
    agent: parsed.agent,
    topic,
    claim: parsed.claim,
    evidencePr: parsed.evidencePr,
    evidenceFile: parsed.evidenceFile,
  });
  console.log(`slowcook knowledge add → ${result.action}`);
  console.log(`  ${result.topicPath}`);
}

function defaultTopicForAgent(agent: string): string {
  switch (agent) {
    case "chef": return "chef-known-fixes";
    case "testgen": return "test-patterns";
    case "vibe": return "design-conventions";
    case "brew": return "brew-patterns";
    case "recon": return "recon-shape-contracts";
    default: return "agent-insights";
  }
}

interface ParsedArgs {
  repoRoot: string;
  agent: string | null;
  claim: string | null;
  topic: string | null;
  evidencePr: number | undefined;
  evidenceFile: string | undefined;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  // First two positional args are <agent> + <claim>; rest are flags.
  const out: ParsedArgs = {
    repoRoot: process.cwd(),
    agent: null,
    claim: null,
    topic: null,
    evidencePr: undefined,
    evidenceFile: undefined,
    help: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--cwd" && next) { out.repoRoot = next; i++; }
    else if (a === "--topic" && next) { out.topic = next; i++; }
    else if (a === "--evidence-pr" && next) { out.evidencePr = parseInt(next, 10); i++; }
    else if (a === "--evidence-file" && next) { out.evidenceFile = next; i++; }
    else if (a === "--help" || a === "-h") { out.help = true; }
    else if (a && !a.startsWith("--")) { positional.push(a); }
  }
  if (positional.length >= 1) out.agent = positional[0]!;
  if (positional.length >= 2) out.claim = positional.slice(1).join(" ");
  return out;
}

function printHelp(): void {
  console.log(`
slowcook knowledge add <agent> "<claim>" [options]

Append an agent insight to .brewing/repo-knowledge/curated/<topic>.md
with structured evidence. Insights live as durable soft-signal
organizational memory (TRACKED in git).

Args:
  <agent>          chef | testgen | vibe | brew | recon | <name>
  "<claim>"        one-line insight in quotes

Options:
  --topic <name>          override default topic file
                          (chef → chef-known-fixes, etc.)
  --evidence-pr N         link to the PR that motivated the insight
  --evidence-file <path>  path to the file the insight is about
  --cwd <path>            consumer repo root (default: cwd)

Examples:
  slowcook knowledge add chef "vitest/config not found means pnpm install missing in workflow" \\
    --evidence-pr 686 --evidence-file .github/workflows/slowcook-chef-on-brew-halt.yml

  slowcook knowledge add testgen "use renderWithProviders, not raw render — Layout context needs to wrap" \\
    --evidence-file tests/helpers/render.ts

Idempotency: appending the same claim twice updates last-verified
instead of creating a duplicate.
`);
}
