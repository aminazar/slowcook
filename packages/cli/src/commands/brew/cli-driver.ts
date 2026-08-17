/**
 * CLAUDE-CLI TURN DRIVER (#393) — brew on subscription auth.
 *
 * Instead of the Anthropic SDK loop, one iteration = one `claude -p` headless
 * session with brew's tools mounted over MCP (see mcp-server.ts). The CLI
 * owns the tool loop; slowcook keeps everything that makes brew brew: the
 * ratchet, the diff caps, budgets, halt reports, and the ledger.
 *
 * DOLLARS ARE KEPT (Amin's ruling, 2026-08-15): every session's usage is
 * priced at Anthropic LIST PRICE into the same cost sidecar — "use cli but
 * keep the dollar estimate nonetheless." The subscription only changes who
 * pays, not what the work costs; budgets and calibration stay trustworthy.
 * The run log alone notes `auth=subscription`.
 *
 * #399 maps cleanly: the persistent conversation is the CLI SESSION
 * (`--resume <id>` each iteration); a recovery reset just drops the id.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { BREW_TOOLS, costEntryUsd } from "@slowcook-ai/llm-anthropic";

export interface CliTurnArgs {
  iteration: number;
  /** Model for THIS turn (multi-model: plan vs emit). */
  model: string;
  /** First turn (or post-reset): send the full cached prefix; later turns
   *  ride the resumed session and send only the dynamic body. */
  promptText: string;
  runDir: string;
  repoRoot: string;
  /** claude session to resume; undefined starts fresh (reset = drop it). */
  sessionId?: string;
  maxTurns: number;
  /** Injected for tests. */
  exec?: (cmd: string, args: string[], cwd: string) => { stdout: string; status: number | null };
}

/** An expired/absent CLI login is an OPERATOR problem, not an agent stall —
 *  brew must say so instead of burning iterations and blaming the model. */
export function isAuthFailure(text: string | undefined): boolean {
  return /authenticate|oauth|not logged in|unauthorized|invalid api key/i.test(text ?? "");
}

export interface CliTurnResult {
  rationale: string;
  spendUsd: number;            // LIST PRICE — never zero because of auth
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreateTokens: number };
  toolCallCount: number;
  toolTrace: string[];
  sessionId?: string;
  truncatedAtMaxTurns: boolean;
  /** The CLI could not authenticate — halt immediately, don't retry. */
  authFailed?: boolean;
  overflowJustification?: { reason_category: string; affected_scope: string[]; narrative: string };
  errorText?: string;
}

/** The server reads schemas from a file so it stays dependency-free. */
export function writeMcpFiles(runDir: string, repoRoot: string, serverJs: string): string {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "mcp-tools.json"), JSON.stringify(
    (BREW_TOOLS as { name: string; description?: string; input_schema?: unknown }[]).map((t) => ({
      name: t.name, description: t.description ?? "", inputSchema: t.input_schema ?? { type: "object" },
    })), null, 2), "utf8");
  const cfgPath = join(runDir, "mcp-config.json");
  writeFileSync(cfgPath, JSON.stringify({
    mcpServers: { slowcook: { command: process.execPath, args: [serverJs, "--repo", repoRoot, "--run", runDir] } },
  }, null, 2), "utf8");
  return cfgPath;
}

/** Parse the stream-json lines a headless claude session emits. Pure. */
export function parseStreamJson(out: string): {
  sessionId?: string; resultText: string; subtype?: string; numTurns?: number;
  usage: CliTurnResult["usage"]; toolTrace: string[]; isError: boolean;
} {
  let sessionId: string | undefined; let resultText = ""; let subtype: string | undefined;
  let numTurns: number | undefined; let isError = false;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0 };
  const toolTrace: string[] = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(t); } catch { continue; }
    if (typeof ev["session_id"] === "string") sessionId = ev["session_id"] as string;
    if (ev["type"] === "assistant") {
      const msg = ev["message"] as { content?: { type: string; name?: string; input?: Record<string, unknown> }[] } | undefined;
      for (const b of msg?.content ?? []) {
        if (b.type === "tool_use") {
          const short = String(b.name ?? "").replace(/^mcp__slowcook__/, "");
          const hint = String(b.input?.["path"] ?? b.input?.["symbol"] ?? "");
          toolTrace.push(hint ? `${short}(${hint})` : short);
        }
      }
    }
    if (ev["type"] === "result") {
      subtype = ev["subtype"] as string | undefined;
      numTurns = ev["num_turns"] as number | undefined;
      isError = ev["is_error"] === true;
      if (typeof ev["result"] === "string") resultText = ev["result"] as string;
      const u = ev["usage"] as Record<string, number> | undefined;
      if (u) {
        usage.inputTokens = u["input_tokens"] ?? 0;
        usage.outputTokens = u["output_tokens"] ?? 0;
        usage.cacheReadTokens = u["cache_read_input_tokens"] ?? 0;
        usage.cacheCreateTokens = u["cache_creation_input_tokens"] ?? 0;
      }
    }
  }
  return { sessionId, resultText, subtype, numTurns, usage, toolTrace, isError };
}

export function runCliTurn(a: CliTurnArgs): CliTurnResult {
  const serverJs = join(new URL(".", import.meta.url).pathname, "mcp-server.js");
  const cfg = writeMcpFiles(a.runDir, a.repoRoot, serverJs);
  const overflowPath = join(a.runDir, "mcp-overflow-justification.json");
  rmSync(overflowPath, { force: true });

  const args = [
    "-p", a.promptText,
    "--mcp-config", cfg,
    "--allowedTools", "mcp__slowcook__*",
    // Dogfood finding (2026-08-15, run1 iter1): allowedTools WHITELISTS but
    // does not fence — the session happily ran its built-in Bash/Read beside
    // the MCP tools, bypassing brew's path guards. Disallow the natives so
    // the tool surface is exactly BREW_TOOLS, same as the API path.
    "--disallowedTools", "Bash,Read,Write,Edit,MultiEdit,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite,NotebookEdit,ToolSearch",
    "--output-format", "stream-json", "--verbose",
    "--max-turns", String(a.maxTurns),
    "--model", a.model,
    ...(a.sessionId ? ["--resume", a.sessionId] : []),
  ];
  const exec = a.exec ?? ((cmd: string, xs: string[], cwd: string) => {
    const r = spawnSync(cmd, xs, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60_000 });
    return { stdout: (r.stdout ?? "") + "\n" + (r.stderr ?? ""), status: r.status };
  });
  const { stdout, status } = exec("claude", args, a.repoRoot);
  const parsed = parseStreamJson(stdout);

  let overflowJustification: CliTurnResult["overflowJustification"];
  if (existsSync(overflowPath)) {
    try { overflowJustification = JSON.parse(readFileSync(overflowPath, "utf8")); } catch { /* malformed = absent */ }
  }
  // LIST PRICE, always (the ruling). Unpriced model → null would be dropped
  // silently here; keep 0-guarded via costEntryUsd's own contract.
  const spendUsd = costEntryUsd(a.model, parsed.usage) ?? 0;
  return {
    rationale: parsed.resultText ||
      (parsed.toolTrace.length ? `[tool-only session: ${parsed.toolTrace.length} calls. Trace: ${parsed.toolTrace.slice(0, 8).join(", ")}${parsed.toolTrace.length > 8 ? ", …" : ""}]` : ""),
    spendUsd,
    usage: parsed.usage,
    toolCallCount: parsed.toolTrace.length,
    toolTrace: parsed.toolTrace,
    sessionId: parsed.sessionId,
    truncatedAtMaxTurns: parsed.subtype === "error_max_turns",
    ...(overflowJustification ? { overflowJustification } : {}),
    // The stream's `subtype` says "success" even when is_error is true and the
    // real cause sits in `result` — reporting the subtype printed
    // "claude exited 1 (success)" over an auth failure (rewo dogfood).
    ...(parsed.isError || (status !== 0 && !parsed.resultText)
      ? { errorText: parsed.resultText
            ? `claude session failed: ${parsed.resultText.slice(0, 200)}`
            : `claude exited ${status}` }
      : {}),
    ...(isAuthFailure(parsed.resultText) ? { authFailed: true } : {}),
  };
}
