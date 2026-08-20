import { describe, it, expect } from "vitest";
import { parseFileBlocks } from "./resubmit.js";

describe("parseFileBlocks", () => {
  it("parses file blocks and confines writes to tests/", () => {
    const blocks = parseFileBlocks(
      '<file path="tests/schema/story-021.test.ts">\ncontent A\n</file>\n' +
        '<file path="src/evil.ts">\nnope\n</file>\n' +
        '<file path="tests/../escape.ts">\nnope\n</file>\n' +
        '<file path="tests/integration/story-021.test.ts">\ncontent B</file>'
    );
    expect(blocks.map((b) => b.path)).toEqual([
      "tests/schema/story-021.test.ts",
      "tests/integration/story-021.test.ts",
    ]);
    expect(blocks[1]!.content.endsWith("\n")).toBe(true);
  });

  it("no blocks = empty (caller fails closed)", () => {
    expect(parseFileBlocks("I would change nothing.")).toEqual([]);
  });
});
