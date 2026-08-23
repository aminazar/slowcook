/**
 * WHICH RUNTIME DOES THIS COMMAND ACTUALLY SUPPORT? (dovizir handover §1)
 *
 * `createLlmClient()` advertises a key-less contract: set
 * `SLOWCOOK_LLM=claude-cli` and slowcook runs on the local CLI's subscription
 * auth. That contract is real for `refine` — and silently false for `brew`,
 * which constructs the Anthropic SDK directly because it needs API tool-use
 * blocks (`BREW_TOOLS`), something `ClaudeCliClient` deliberately cannot do
 * (it runs `--disallowedTools '*'` and is a pure text model).
 *
 * Field symptom: with `SLOWCOOK_LLM=claude-cli` and no key, refine works and
 * brew dies on `ANTHROPIC_API_KEY environment variable is not set.` — an
 * error that names the wrong problem. The operator configured a backend the
 * command cannot use, and nothing said so.
 *
 * Until the tool-use bridge lands (tracked separately), the honest behaviour
 * is to fail fast and SAY WHICH: name the command, name the backend they
 * chose, name the commands that do support it.
 */

/** Commands that run on `SLOWCOOK_LLM=claude-cli` today (pure-text calls
 *  through the `LlmClient` seam). Everything else needs API tool-use. */
// #393 — brew joined via the MCP bridge: the CLI runs the tool loop with
// slowcook's tools mounted over MCP; dollars stay at list price.
// 2026-08-23 (Amin's ruling): the seam gained tool-protocol emulation, so
// the tool-loop agents joined too; vibe was text-only all along.
export const CLI_BACKEND_SUPPORTED = ["refine", "brew", "vibe", "investigate", "sift"] as const;

/** Does this command run on the local `claude` login? Widened so callers can
 *  ask with a plain command string. */
export function isCliCapable(command: string): boolean {
  return (CLI_BACKEND_SUPPORTED as readonly string[]).includes(command);
}

export function isClaudeCliBackend(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["SLOWCOOK_LLM"]?.trim().toLowerCase() === "claude-cli";
}

/**
 * The message shown when a tool-use command is asked to run on a backend that
 * cannot serve it. Pure so the wording is testable — a message that names the
 * wrong cause is the bug being fixed here.
 */
export function apiKeyRequiredMessage(command: string, env: NodeJS.ProcessEnv = process.env): string {
  if (isClaudeCliBackend(env) && !isCliCapable(command)) {
    return (
      `slowcook ${command}: the claude-cli backend is not supported by this command.\n` +
      `  ${command} drives API tool-use blocks; the local \`claude\` CLI runs as a pure text model, so it cannot serve them.\n` +
      `  Set ANTHROPIC_API_KEY to run ${command}. (SLOWCOOK_LLM=claude-cli works for: ${CLI_BACKEND_SUPPORTED.join(", ")}.)`
    );
  }
  // When the command IS cli-capable, leading with "set ANTHROPIC_API_KEY"
  // sends someone who already has a Claude subscription to go buy API credit.
  // Name the free option first. (This branch used to say "available for
  // refine, brew, but not brew" — a contradiction, since brew became
  // cli-capable and the sentence still hardcoded the exclusion.)
  if (isCliCapable(command)) {
    return (
      `slowcook ${command}: no LLM runtime configured.\n` +
      `  Either set SLOWCOOK_LLM=claude-cli to run on your local \`claude\` login (no API billing),\n` +
      `  or set ANTHROPIC_API_KEY to run against the API.`
    );
  }
  return (
    `slowcook ${command}: no LLM runtime configured.\n` +
    `  Set ANTHROPIC_API_KEY. (SLOWCOOK_LLM=claude-cli is available for ${CLI_BACKEND_SUPPORTED.join(", ")}, but not ${command} — it needs API tool-use.)`
  );
}

/**
 * Resolve the API key for a tool-use command, or exit with a message that
 * names the real cause. Returns the key so call sites read as one line.
 */
export function requireApiKey(command: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = env["ANTHROPIC_API_KEY"]?.trim();
  if (key) return key;
  console.error(apiKeyRequiredMessage(command, env));
  process.exit(2);
}
