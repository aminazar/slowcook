/**
 * The PLAIN arm — plain Claude Code, issue text only (ruling 3).
 *
 * Reuses brew's headless `claude -p --output-format stream-json` shape and
 * its stream parser, MINUS the MCP config and the tool fences: the session
 * gets its native Bash/Read/Edit so it is exactly "a developer opened
 * Claude Code on the repo and pasted the issue". No spec, no tests, no
 * manifest are on disk while it runs (`run.ts` hides them).
 *
 * Budget is equalised in USD at list price, the same rule brew applies.
 * The loop resumes the session while it is cut at max-turns and money
 * remains; a session that ends without the done marker gets one nudge.
 */
import type { LlmUsage } from "@slowcook-ai/core";
import { parseStreamJson } from "../brew/cli-driver.js";

export const PLAIN_DONE_MARKER = "SLOWCOOK_PLAIN_DONE";

export interface PlainIssue {
  number: number;
  title: string;
  body: string;
}

/** The whole prompt the plain arm sees. Pure; pinned by tests. */
export function buildPlainPrompt(issue: PlainIssue): string {
  return [
    `Implement GitHub issue #${issue.number} in this repository, on the current branch.`,
    ``,
    `# ${issue.title}`,
    ``,
    issue.body.trim() || "(no body)",
    ``,
    `Work the way you normally would: read the code, make the change, run whatever checks the repo has, and commit your work with a clear message when it is done.`,
    `When you are completely finished, end your final message with the single line:`,
    PLAIN_DONE_MARKER,
  ].join("\n");
}

export const PLAIN_NUDGE =
  `Continue until the issue is fully implemented and committed. When finished, end your final message with the single line ${PLAIN_DONE_MARKER}.`;

/** Native tools only — the exact set brew DISALLOWS, whitelisted so the
 *  headless session never stops on a permission prompt. */
export const PLAIN_ALLOWED_TOOLS = "Bash,Read,Write,Edit,MultiEdit,Glob,Grep,WebFetch";

/** argv for one headless session. Pure; no --mcp-config, no --disallowedTools. */
export function plainArgv(a: { prompt: string; model: string; maxTurns: number; sessionId?: string }): string[] {
  return [
    "-p", a.prompt,
    "--allowedTools", PLAIN_ALLOWED_TOOLS,
    "--output-format", "stream-json", "--verbose",
    "--max-turns", String(a.maxTurns),
    "--model", a.model,
    ...(a.sessionId ? ["--resume", a.sessionId] : []),
  ];
}

export interface PlainRunArgs {
  repoRoot: string;
  issue: PlainIssue;
  model: string;
  budgetUsd: number;
  /** Turns per headless session before the CLI cuts it (resumed while budget remains). */
  maxTurnsPerSession?: number;
  /** Hard cap on sessions (resumes + nudges). */
  maxSessions?: number;
  priceFor: (model: string, usage: LlmUsage) => number | null;
  exec: (cmd: string, args: string[], cwd: string) => { stdout: string; status: number | null };
  log?: (line: string) => void;
  now?: () => Date;
}

export interface PlainRunResult {
  done: boolean;
  sessions: number;
  turns: number;
  usage: LlmUsage;
  /** List price; null when the model is unpriced (budget then stops on sessions only). */
  usd: number | null;
  unpriced: boolean;
  stop: "done" | "budget" | "sessions" | "error";
  sessionId?: string;
  lastText: string;
  errorText?: string;
  started_at: string;
  finished_at: string;
  wall_ms: number;
}

export async function runPlainArm(a: PlainRunArgs): Promise<PlainRunResult> {
  const now = a.now ?? (() => new Date());
  const log = a.log ?? (() => {});
  const maxTurns = a.maxTurnsPerSession ?? 40;
  const maxSessions = a.maxSessions ?? 8;
  const started = now();
  const usage: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
  let usd: number | null = 0;
  let unpriced = false;
  let sessions = 0;
  let turns = 0;
  let sessionId: string | undefined;
  let lastText = "";
  let stop: PlainRunResult["stop"] = "sessions";
  let done = false;
  let errorText: string | undefined;
  let prompt = buildPlainPrompt(a.issue);

  while (sessions < maxSessions) {
    const argv = plainArgv({ prompt, model: a.model, maxTurns, sessionId });
    const { stdout, status } = a.exec("claude", argv, a.repoRoot);
    sessions += 1;
    const parsed = parseStreamJson(stdout);
    if (parsed.sessionId) sessionId = parsed.sessionId;
    turns += parsed.numTurns ?? 0;
    usage.inputTokens += parsed.usage.inputTokens;
    usage.outputTokens += parsed.usage.outputTokens;
    usage.cacheReadTokens += parsed.usage.cacheReadTokens;
    usage.cacheCreateTokens += parsed.usage.cacheCreateTokens;
    const price = a.priceFor(a.model, parsed.usage);
    if (price === null) { unpriced = true; usd = null; }
    else if (usd !== null) usd += price;
    lastText = parsed.resultText;
    log(`PLAIN session ${sessions}  turns=${parsed.numTurns ?? "?"}  usd=${usd === null ? "unpriced" : usd.toFixed(2)}/${a.budgetUsd.toFixed(2)}  subtype=${parsed.subtype ?? "?"}`);

    if (parsed.isError || (status !== 0 && !parsed.resultText)) {
      errorText = parsed.resultText ? parsed.resultText.slice(0, 300) : `claude exited ${status}`;
      stop = "error";
      break;
    }
    if (parsed.resultText.includes(PLAIN_DONE_MARKER)) { done = true; stop = "done"; break; }
    if (usd !== null && usd >= a.budgetUsd) { stop = "budget"; break; }
    // Cut at max-turns → resume silently; ended without the marker → nudge once per session.
    prompt = parsed.subtype === "error_max_turns" ? "Continue." : PLAIN_NUDGE;
  }
  const finished = now();
  return {
    done, sessions, turns, usage, usd, unpriced, stop, sessionId, lastText,
    ...(errorText ? { errorText } : {}),
    started_at: started.toISOString(),
    finished_at: finished.toISOString(),
    wall_ms: finished.getTime() - started.getTime(),
  };
}
