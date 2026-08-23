import { describe, it, expect } from "vitest";
import {
  toolProtocolSystemSuffix,
  parseEmulatedToolCalls,
  renderCliPrompt,
} from "./claude-cli.js";

describe("tool-protocol emulation over the claude CLI (2026-08-23)", () => {
  it("system suffix carries the catalog and the calling contract", () => {
    const s = toolProtocolSystemSuffix([
      { name: "read_file", description: "read a repo file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
    ]);
    expect(s).toContain("read_file");
    expect(s).toContain("```tool_calls");
    expect(s).toContain("WITHOUT a tool_calls block");
  });

  it("parses a trailing tool_calls block and strips it from the text", () => {
    const raw = 'I will inspect the file.\n\n```tool_calls\n[{"name": "read_file", "input": {"path": "src/a.ts"}}]\n```\n';
    const { text, toolUses } = parseEmulatedToolCalls(raw);
    expect(text).toBe("I will inspect the file.");
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]).toMatchObject({ name: "read_file", input: { path: "src/a.ts" } });
    expect(toolUses[0]!.id).toMatch(/^emul_/);
  });

  it("no block / malformed JSON = plain text, zero calls", () => {
    expect(parseEmulatedToolCalls("all done, no more tools").toolUses).toHaveLength(0);
    const bad = "x\n```tool_calls\n[{broken]\n```";
    const r = parseEmulatedToolCalls(bad);
    expect(r.toolUses).toHaveLength(0);
    expect(r.text).toBe(bad);
  });

  it("tool_result blocks serialize into the transcript", () => {
    const prompt = renderCliPrompt([
      { role: "user", content: "start" },
      { role: "assistant", content: "calling" },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "emul_1", content: "file contents here" },
          { type: "text", text: "continue" },
        ],
      },
    ]);
    expect(prompt).toContain('<tool_result id="emul_1">');
    expect(prompt).toContain("file contents here");
    expect(prompt).toContain("continue");
  });
});
