import { describe, it, expect } from "vitest";
import { parseFileBlocks, suiteWriteRoots } from "./resubmit.js";

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

describe("suiteWriteRoots (2026-08-23 — db-tier write scope)", () => {
  it("derives declared suite directories from discover commands", () => {
    const roots = suiteWriteRoots({
      test: {
        backend: { discover_command: "npx vitest list" },
        db: { discover_command: "ls supabase/tests/database/*.test.sql" },
        acceptance: { discover_command: "npx playwright test --list" },
      },
    });
    expect(roots).toEqual(["supabase/tests/database/"]);
  });

  it("never yields src/ or absolute or traversal roots", () => {
    const roots = suiteWriteRoots({
      test: {
        a: { discover_command: "ls src/evil/*.ts" },
        b: { discover_command: "ls /etc/*.conf" },
        c: { discover_command: "ls ../up/*.sql" },
      },
    });
    expect(roots).toEqual([]);
  });

  it("parseFileBlocks admits declared roots and still refuses others", () => {
    const text =
      '<file path="supabase/tests/database/story-9-x.test.sql">select 1;</file>' +
      '<file path="supabase/migrations/999_evil.sql">drop table x;</file>' +
      '<file path="tests/integration/a.test.ts">ok</file>';
    const blocks = parseFileBlocks(text, { allowRoots: ["supabase/tests/database/"] });
    expect(blocks.map((b) => b.path)).toEqual([
      "supabase/tests/database/story-9-x.test.sql",
      "tests/integration/a.test.ts",
    ]);
  });
});
