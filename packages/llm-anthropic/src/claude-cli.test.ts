import { describe, it, expect } from "vitest";
import { ClaudeCliClient, createLlmClient, renderCliPrompt } from "./claude-cli.js";

const cliStream = (opts: { blocks?: string[]; resultOver?: Record<string, unknown> } = {}) => {
  const blocks = opts.blocks ?? ["the reply"];
  const events = [
    ...blocks.map((b) =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: b }] } })
    ),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: blocks[blocks.length - 1],
      usage: {
        input_tokens: 12,
        output_tokens: 7,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
      },
      ...(opts.resultOver ?? {}),
    }),
  ];
  return events.join("\n") + "\n";
};
const cliJson = (over: Record<string, unknown> = {}) => cliStream({ resultOver: over });

describe("ClaudeCliClient", () => {
  it("runs the CLI as a pure text model and maps usage + cost", async () => {
    let seen: { args: string[]; stdin: string } | null = null;
    const client = new ClaudeCliClient(async (args, stdin) => {
      seen = { args, stdin };
      return cliJson();
    });
    const res = await client.complete({
      system: "you are testgen",
      messages: [{ role: "user", content: "generate tests for story-054" }],
      model: "claude-opus-4-7",
    });

    expect(res.text).toBe("the reply");
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 7, cacheReadTokens: 3, cacheCreateTokens: 2 });
    expect(res.costUsd).toBeGreaterThan(0); // adapter owns price arithmetic (LlmResponse contract)
    expect(res.model).toBe("claude-opus-4-7");

    const { args, stdin } = seen!;
    expect(args).toContain("--disallowedTools");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-4-7");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("you are testgen");
    expect(stdin).toContain("[user]\ngenerate tests for story-054");
  });

  it("refuses content-block (image) messages explicitly — text-only adapter", async () => {
    const client = new ClaudeCliClient(async () => cliJson());
    await expect(
      client.complete({
        system: "s",
        messages: [{ role: "user", content: [{ type: "text", text: "x" }] as never }],
        model: "claude-opus-4-7",
      })
    ).rejects.toThrow(/text-only/);
  });

  it("surfaces CLI errors and non-JSON explicitly — never a fabricated reply", async () => {
    const errClient = new ClaudeCliClient(async () =>
      cliJson({ is_error: true, subtype: "error_during_execution", result: "Not logged in" })
    );
    await expect(
      errClient.complete({ system: "s", messages: [{ role: "user", content: "x" }], model: "m" })
    ).rejects.toThrow(/claude-cli error/);

    const garbage = new ClaudeCliClient(async () => "definitely not json");
    await expect(
      garbage.complete({ system: "s", messages: [{ role: "user", content: "x" }], model: "m" })
    ).rejects.toThrow(/no result event/);
  });

  it("concatenates MULTI-BLOCK replies — the aggregate result field only carries the last block", async () => {
    const client = new ClaudeCliClient(async () => cliStream({ blocks: ["<test_file>\nlots of code\n", "more code\n</test_file>"] }));
    const res = await client.complete({ system: "s", messages: [{ role: "user", content: "x" }], model: "m" });
    expect(res.text).toBe("<test_file>\nlots of code\nmore code\n</test_file>");
  });

  it("folds a multi-turn transcript into one prompt", () => {
    expect(
      renderCliPrompt([
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ])
    ).toBe("[user]\na\n\n[assistant]\nb\n\n[user]\nc\n\n[assistant]\n");
  });
});

describe("createLlmClient", () => {
  it("selects claude-cli when SLOWCOOK_LLM says so — no key needed", async () => {
    const client = await createLlmClient({ SLOWCOOK_LLM: "claude-cli" } as NodeJS.ProcessEnv);
    expect(client).toBeInstanceOf(ClaudeCliClient);
  });

  it("prefers the API adapter when a key is present and no override", async () => {
    const client = await createLlmClient({ ANTHROPIC_API_KEY: "sk-ant-test" } as NodeJS.ProcessEnv);
    expect(client).not.toBeInstanceOf(ClaudeCliClient);
  });

  it("names BOTH options when nothing is configured", async () => {
    await expect(createLlmClient({} as NodeJS.ProcessEnv)).rejects.toThrow(/SLOWCOOK_LLM=claude-cli/);
  });
});
