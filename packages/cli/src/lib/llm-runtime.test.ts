// The error must name the REAL cause (dovizir handover §1).
//
// Field symptom: `SLOWCOOK_LLM=claude-cli` set, no API key. `refine` works;
// `brew` dies with "ANTHROPIC_API_KEY environment variable is not set." —
// which reads as "you forgot a key" when the truth is "you chose a backend
// this command cannot use." The operator has no way to learn that from the
// message, so they go looking for a key they deliberately didn't set.
import { describe, it, expect } from "vitest";
import { apiKeyRequiredMessage, isClaudeCliBackend, CLI_BACKEND_SUPPORTED } from "./llm-runtime.js";

describe("apiKeyRequiredMessage", () => {
  it("names the backend conflict for a command claude-cli genuinely cannot serve", () => {
    const msg = apiKeyRequiredMessage("testgen", { SLOWCOOK_LLM: "claude-cli" } as NodeJS.ProcessEnv);
    expect(msg).toContain("claude-cli backend is not supported by this command");
    expect(msg).toContain("testgen");
    expect(msg).toContain("tool-use");            // says WHY, not just "no"
    expect(msg).toContain("refine");              // names what DOES work
  });

  it("never tells a cli-capable command that claude-cli won't serve it", () => {
    // brew gained claude-cli support; both branches hardcoded the exclusion
    // and produced "available for refine, brew, but not brew".
    for (const cmd of CLI_BACKEND_SUPPORTED) {
      for (const env of [{}, { SLOWCOOK_LLM: "claude-cli" }]) {
        const msg = apiKeyRequiredMessage(cmd, env as NodeJS.ProcessEnv);
        expect(msg, `${cmd} / ${JSON.stringify(env)}`).not.toContain("not supported by this command");
        expect(msg, `${cmd} / ${JSON.stringify(env)}`).not.toContain(`but not ${cmd}`);
      }
    }
  });

  it("offers the free path first when the command can run on the local login", () => {
    const msg = apiKeyRequiredMessage("brew", {} as NodeJS.ProcessEnv);
    expect(msg).toContain("SLOWCOOK_LLM=claude-cli");
    expect(msg).toContain("no API billing");
    expect(msg.indexOf("SLOWCOOK_LLM=claude-cli")).toBeLessThan(msg.indexOf("ANTHROPIC_API_KEY"));
  });

  it("is case/whitespace tolerant about the backend value", () => {
    expect(isClaudeCliBackend({ SLOWCOOK_LLM: "  Claude-CLI " } as NodeJS.ProcessEnv)).toBe(true);
    expect(isClaudeCliBackend({ SLOWCOOK_LLM: "anthropic" } as NodeJS.ProcessEnv)).toBe(false);
    expect(isClaudeCliBackend({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("falls back to a plain missing-key message when no backend was chosen", () => {
    const msg = apiKeyRequiredMessage("brew", {} as NodeJS.ProcessEnv);
    expect(msg).toContain("no LLM runtime configured");
    expect(msg).not.toContain("not supported by this command");
  });

  it("keeps the supported-command list honest", () => {
    // If a command gains claude-cli support, this list must grow with it —
    // the message is the contract operators read.
    expect([...CLI_BACKEND_SUPPORTED]).toContain("refine");
  });
});
