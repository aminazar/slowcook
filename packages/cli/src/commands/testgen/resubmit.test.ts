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

describe("isFeedbackComment", () => {
  it("excludes own chatter but keeps discovery-gate errors (G19)", async () => {
    const { isFeedbackComment } = await import("./resubmit.js");
    expect(isFeedbackComment("### slowcook · recipe resubmit\n\nAmended 2 test files")).toBe(false);
    expect(
      isFeedbackComment(
        "### slowcook · recipe resubmit <!-- slowcook-discovery-gate -->\n\n🛑 The amendment failed test discovery"
      )
    ).toBe(true);
    expect(isFeedbackComment("@aminazar: please restore the tie-break test")).toBe(true);
  });
});


describe("stub-file amendment scope (G26b)", () => {
  it("src stub paths pass only when allowlisted; other src writes never", () => {
    const text = '<file path="src/lib/links/process-unification-job.ts">// @slowcook-stub story-019\n</file>\n<file path="src/lib/evil.ts">x</file>\n<file path="tests/integration/a.test.ts">t</file>';
    const blocks = parseFileBlocks(text, {
      allowStubPaths: ["src/lib/links/process-unification-job.ts"],
    });
    expect(blocks.map((b) => b.path)).toEqual([
      "src/lib/links/process-unification-job.ts",
      "tests/integration/a.test.ts",
    ]);
    expect(parseFileBlocks(text).map((b) => b.path)).toEqual(["tests/integration/a.test.ts"]);
  });
});
