import { describe, it, expect } from "vitest";
import {
  isInFixScope,
  parseHalt,
  regressionStatus,
  regressionFailureMessage,
} from "./agent.js";
import type { RunResult } from "@slowcook-ai/stack-ts";

describe("isInFixScope", () => {
  it("returns false on empty scope", () => {
    expect(isInFixScope("src/foo.ts", [])).toBe(false);
  });

  it("matches exact paths", () => {
    expect(isInFixScope("src/foo.ts", ["src/foo.ts"])).toBe(true);
    expect(isInFixScope("src/bar.ts", ["src/foo.ts"])).toBe(false);
  });

  it("matches directory prefixes", () => {
    expect(isInFixScope("src/lib/util.ts", ["src/lib/"])).toBe(true);
    expect(isInFixScope("src/lib/util.ts", ["src/lib"])).toBe(true);
    expect(isInFixScope("src/components/foo.tsx", ["src/lib/"])).toBe(false);
  });

  it("normalises ./ prefixes on both sides", () => {
    expect(isInFixScope("./src/foo.ts", ["src/foo.ts"])).toBe(true);
    expect(isInFixScope("src/foo.ts", ["./src/foo.ts"])).toBe(true);
  });

  it("does NOT match siblings of a directory prefix", () => {
    // 'src/lib/' should NOT match 'src/library.ts' (would be a partial-prefix
    // false positive without trailing-slash handling).
    expect(isInFixScope("src/library.ts", ["src/lib/"])).toBe(false);
  });
});

describe("parseHalt", () => {
  it("extracts the reason from the structured form", () => {
    const text = `Some prose then:\n<halt><reason>fix needs files outside fix_scope</reason></halt>\nMore prose.`;
    expect(parseHalt(text)).toBe("fix needs files outside fix_scope");
  });

  it("falls back to bare <halt>X</halt>", () => {
    expect(parseHalt("<halt>budget exceeded</halt>")).toBe("budget exceeded");
  });

  it("returns null when there's no halt block", () => {
    expect(parseHalt("plain text")).toBeNull();
  });

  it("trims whitespace inside the reason", () => {
    expect(parseHalt("<halt><reason>\n  reason here  \n</reason></halt>")).toBe(
      "reason here"
    );
  });
});

function makeRunResult(
  partial: Partial<RunResult["tests"][number]>,
  partials: Array<Partial<RunResult["tests"][number]>> = []
): RunResult {
  const def = {
    id: "tests/regression/B-1-foo.test.ts > some test",
    file: "tests/regression/B-1-foo.test.ts",
    status: "passed" as const,
  };
  const tests = [
    { ...def, ...partial },
    ...partials.map((p) => ({ ...def, ...p })),
  ];
  return { ran: true, tests, suites: [] };
}

describe("regressionStatus", () => {
  const REG = "tests/regression/B-1-foo.test.ts";

  it("returns 'green' when the regression test passed", () => {
    const r = makeRunResult({ status: "passed" });
    expect(regressionStatus(r, REG)).toBe("green");
  });

  it("returns 'red' when the regression test failed", () => {
    const r = makeRunResult({ status: "failed" });
    expect(regressionStatus(r, REG)).toBe("red");
  });

  it("returns 'red' when the regression test errored (vitest crash)", () => {
    const r = makeRunResult({ status: "errored" });
    expect(regressionStatus(r, REG)).toBe("red");
  });

  it("ignores tests OUTSIDE the regression file (sift's contract is only the regression)", () => {
    const r: RunResult = {
      ran: true,
      tests: [
        { id: "regression test", file: REG, status: "passed" },
        { id: "unrelated", file: "tests/integration/story-007.test.ts", status: "failed" },
      ],
      suites: [],
    };
    expect(regressionStatus(r, REG)).toBe("green");
  });

  it("returns 'red' when the regression file produced no tests (vitest crashed)", () => {
    const r: RunResult = { ran: true, tests: [], suites: [] };
    expect(regressionStatus(r, REG)).toBe("red");
  });

  it("treats skipped as effectively passed (regression assertion didn't fail)", () => {
    const r = makeRunResult({ status: "skipped" });
    expect(regressionStatus(r, REG)).toBe("green");
  });
});

describe("regressionFailureMessage", () => {
  const REG = "tests/regression/B-1-foo.test.ts";

  it("returns the failure message of the first failing regression test", () => {
    const r: RunResult = {
      ran: true,
      tests: [
        {
          id: "first",
          file: REG,
          status: "failed",
          failure_message: "expected handle to be present",
        },
        {
          id: "second",
          file: REG,
          status: "failed",
          failure_message: "second message",
        },
      ],
      suites: [],
    };
    expect(regressionFailureMessage(r, REG)).toBe("expected handle to be present");
  });

  it("returns undefined when all regression tests passed", () => {
    const r = makeRunResult({ status: "passed" });
    expect(regressionFailureMessage(r, REG)).toBeUndefined();
  });
});
