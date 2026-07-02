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

const defaultRunner: CliRunner = (args, stdin) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      args,
      { maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
    child.stdin?.write(stdin);
    child.stdin?.end();
  });

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

export class ClaudeCliClient implements LlmClient {
  constructor(private readonly run: CliRunner = defaultRunner) {}

  async complete(args: LlmRequest): Promise<LlmResponse> {
    const cliArgs = [
      "-p",
      "--output-format", "json",
      "--model", args.model,
      "--disallowedTools", "*", // pure text model — no host access, ever
      "--system-prompt", args.system,
    ];
    const stdout = await this.run(cliArgs, renderCliPrompt(args.messages));
    let parsed: CliResult;
    try {
      parsed = JSON.parse(stdout) as CliResult;
    } catch {
      throw new Error(`claude-cli returned non-JSON output: ${stdout.slice(0, 200)}`);
    }
    if (parsed.is_error || typeof parsed.result !== "string") {
      throw new Error(
        `claude-cli error (${parsed.subtype ?? "unknown"}): ${parsed.result ?? stdout.slice(0, 200)}`
      );
    }
    const usage = {
      inputTokens: parsed.usage?.input_tokens ?? 0,
      outputTokens: parsed.usage?.output_tokens ?? 0,
      cacheReadTokens: parsed.usage?.cache_read_input_tokens ?? 0,
      cacheCreateTokens: parsed.usage?.cache_creation_input_tokens ?? 0,
    };
    return {
      text: parsed.result,
      usage,
      costUsd: costUsdForUsage(args.model, usage),
      model: args.model,
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
