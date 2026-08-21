import { execFile } from "node:child_process";
import type { LlmClient, LlmRequest, LlmResponse } from "@slowcook-ai/core";
import { costUsdForUsage } from "./pricing.js";

/**
 * Key-less Claude adapter: drives the `claude` CLI's headless print mode,
 * authenticated by the machine's Claude Code subscription — no
 * ANTHROPIC_API_KEY anywhere. Implements the same `LlmClient` contract as
 * `AnthropicClient`, so agents (refine, testgen, …) run unchanged on either.
 *
 * Runs as a PURE text model: our system prompt replaces Claude Code's
 * (`--system-prompt`) and all tools are disallowed (`--disallowedTools '*'`)
 * — the CLI can never touch the host from here.
 *
 * Proven pattern: this mirrors the dash server's claude-cli provider
 * (dogfooded 2026-07 on the rewo box; a subscription login or a
 * CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token` is all it needs).
 *
 * Text-only: `LlmMessage.content` block arrays (images) need the API
 * adapter — this one refuses them explicitly rather than dropping data.
 */

/** shell-out seam, injectable so tests never spawn a process. */
export type CliRunner = (args: string[], stdin: string) => Promise<string>;

const runOnce = (args: string[], stdin: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      args,
      { maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        // stderr is the only diagnostic the CLI gives on a crash — carry it.
        const tail = String(stderr ?? "").trim().slice(-500);
        reject(new Error(`claude CLI exited abnormally: ${err.message}${tail ? `\nstderr: ${tail}` : ""}`));
      }
    );
    child.stdin?.write(stdin);
    child.stdin?.end();
  });

// Long generations occasionally die in-flight (observed on multi-minute
// testgen bundles: one truncated reply, one abnormal exit). One retry
// absorbs the transient class; a second failure surfaces with diagnostics.
const defaultRunner: CliRunner = async (args, stdin) => {
  try {
    return await runOnce(args, stdin);
  } catch {
    return runOnce(args, stdin);
  }
};

interface CliResult {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/** the transcript folded into one prompt — the CLI is single-shot per call. */
export function renderCliPrompt(messages: LlmRequest["messages"]): string {
  const parts = messages.map((m) => {
    if (typeof m.content !== "string") {
      throw new Error(
        "claude-cli adapter is text-only — image/content-block messages need the ANTHROPIC_API_KEY adapter"
      );
    }
    return `[${m.role}]\n${m.content}`;
  });
  return parts.join("\n\n") + "\n\n[assistant]\n";
}

/**
 * WHOSE LOGIN, AND WHERE? (dovizir handover §6)
 *
 * A not-logged-in CLI backend surfaced the child process's own words verbatim:
 * "Not logged in · Please run /login". `/login` is a slash command inside an
 * interactive Claude session — an operator reading it from a slowcook log has
 * no session to type it into, and no clue which host or which account is
 * meant. Name all three.
 */
export function annotateCliError(subtype: string | undefined, detail: string): string {
  const base = `claude-cli error (${subtype ?? "unknown"}): ${detail}`;
  if (/not logged in|\/login|unauthor|authentication|401/i.test(detail)) {
    return (
      `${base}\n` +
      `  This is the local \`claude\` CLI on THIS host, not slowcook or your Anthropic API key.\n` +
      `  Authenticate it non-interactively with:  claude setup-token\n` +
      `  (it prints a CLAUDE_CODE_OAUTH_TOKEN — export it where slowcook runs.)\n` +
      `  Or drop SLOWCOOK_LLM=claude-cli and set ANTHROPIC_API_KEY instead.`
    );
  }
  return base;
}

export class ClaudeCliClient implements LlmClient {
  constructor(private readonly run: CliRunner = defaultRunner) {}

  async complete(args: LlmRequest): Promise<LlmResponse> {
    // stream-json, NOT json: on long replies the CLI's aggregate `result`
    // field carries only the FINAL text block (observed thrice on dash —
    // replies arriving mid-word). Concatenating the assistant events' text
    // blocks recovers the full reply.
    const cliArgs = [
      "-p",
      "--output-format", "stream-json",
      "--verbose", // stream-json in print mode requires it
      "--model", args.model,
      "--disallowedTools", "*", // pure text model — no host access, ever
      "--system-prompt", args.system,
    ];
    const stdout = await this.run(cliArgs, renderCliPrompt(args.messages));
    let text = "";
    let parsed: CliResult | null = null;
    let stopReason: string | undefined;
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (evt.type === "assistant") {
        const message = evt.message as
          | { content?: Array<{ type?: string; text?: string }>; stop_reason?: string | null }
          | undefined;
        for (const block of message?.content ?? []) {
          if (block.type === "text" && typeof block.text === "string") text += block.text;
        }
        if (typeof message?.stop_reason === "string") stopReason = message.stop_reason;
      } else if (evt.type === "result") {
        parsed = evt as unknown as CliResult;
      }
    }
    if (!parsed) {
      throw new Error(`claude-cli emitted no result event: ${stdout.slice(0, 200)}`);
    }
    if (parsed.is_error) {
      const detail = String(parsed.result ?? stdout.slice(0, 200));
      throw new Error(annotateCliError(parsed.subtype, detail));
    }
    if (!text) text = typeof parsed.result === "string" ? parsed.result : "";
    const usage = {
      inputTokens: parsed.usage?.input_tokens ?? 0,
      outputTokens: parsed.usage?.output_tokens ?? 0,
      cacheReadTokens: parsed.usage?.cache_read_input_tokens ?? 0,
      cacheCreateTokens: parsed.usage?.cache_creation_input_tokens ?? 0,
    };
    return {
      text,
      usage,
      costUsd: costUsdForUsage(args.model, usage),
      model: args.model,
      stopReason,
    };
  }
}

/**
 * Environment-decided adapter selection (the dash-proven pattern):
 *   SLOWCOOK_LLM=claude-cli      → key-less subscription runtime
 *   ANTHROPIC_API_KEY set        → the API adapter
 *   neither                      → a helpful error naming BOTH options
 */
export async function createLlmClient(
  env: NodeJS.ProcessEnv = process.env
): Promise<LlmClient> {
  if (env.SLOWCOOK_LLM?.trim().toLowerCase() === "claude-cli") {
    return new ClaudeCliClient();
  }
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (key) {
    const { AnthropicClient } = await import("./client.js");
    return new AnthropicClient(key);
  }
  throw new Error(
    "No LLM runtime configured. Either set ANTHROPIC_API_KEY, or set SLOWCOOK_LLM=claude-cli to use the local `claude` CLI's subscription auth (requires `claude` installed and logged in)."
  );
}
