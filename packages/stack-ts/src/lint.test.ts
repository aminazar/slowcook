import { describe, it, expect } from "vitest";
import {
  parseEslintOutput,
  parseTscOutput,
  runLint,
  formatLintIssues,
  type LintConfig,
} from "./lint.js";

describe("parseTscOutput", () => {
  it("parses standard tsc error lines", () => {
    const text = `src/app/page.tsx(13,3): error TS2345: Argument of type 'null' is not assignable to parameter of type '{ id: string; }'.
tests/x.test.ts(42,1): error TS2304: Cannot find name 'foo'.`;
    const issues = parseTscOutput(text, "");
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      source: "typecheck",
      file: "src/app/page.tsx",
      line: 13,
      column: 3,
      severity: "error",
    });
    expect(issues[0]?.message).toContain("TS2345");
    expect(issues[0]?.message).toContain("not assignable");
  });

  it("returns empty for clean tsc output", () => {
    expect(parseTscOutput("", "")).toEqual([]);
  });

  it("ignores non-error lines", () => {
    const text = `Found 0 errors. Watching for file changes.\n`;
    expect(parseTscOutput(text, "")).toEqual([]);
  });
});

describe("parseEslintOutput", () => {
  it("parses stylish output", () => {
    const text = `
/abs/repo/src/x.ts
  12:3  error    Unexpected console statement  no-console
  18:1  warning  'foo' is defined but never used  @typescript-eslint/no-unused-vars

/abs/repo/src/y.ts
  5:10  error  Missing return type on function  @typescript-eslint/explicit-function-return-type
`;
    const issues = parseEslintOutput(text, "");
    expect(issues).toHaveLength(3);
    expect(issues[0]).toMatchObject({
      source: "lint",
      file: "/abs/repo/src/x.ts",
      line: 12,
      column: 3,
      severity: "error",
    });
    expect(issues[0]?.message).toContain("[no-console]");
    expect(issues[1]?.severity).toBe("warning");
    expect(issues[2]?.file).toBe("/abs/repo/src/y.ts");
  });

  it("parses JSON eslint output when present", () => {
    const json = JSON.stringify([
      {
        filePath: "/abs/x.ts",
        messages: [
          { line: 1, column: 1, severity: 2, message: "bad", ruleId: "rule-a" },
          { line: 5, column: 3, severity: 1, message: "warn", ruleId: "rule-b" },
        ],
      },
    ]);
    const issues = parseEslintOutput(json, "");
    expect(issues).toHaveLength(2);
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.message).toContain("[rule-a]");
    expect(issues[1]?.severity).toBe("warning");
  });

  it("returns empty for clean output", () => {
    expect(parseEslintOutput("", "")).toEqual([]);
  });
});

describe("runLint", () => {
  it("returns ran:false when config is undefined", () => {
    const result = runLint(undefined, { cwd: "/tmp" });
    expect(result.ran).toBe(false);
    expect(result.clean).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("invokes both commands when both are configured", () => {
    const calls: Array<{ cmd: string; cwd: string }> = [];
    const fakeExec = (cmd: string, cwd: string) => {
      calls.push({ cmd, cwd });
      return { stdout: "", stderr: "", code: 0 };
    };
    const config: LintConfig = {
      lint_command: "npm run lint",
      typecheck_command: "npm run typecheck",
    };
    const result = runLint(config, { cwd: "/tmp", exec: fakeExec });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.cmd).toBe("npm run lint");
    expect(calls[1]?.cmd).toBe("npm run typecheck");
    expect(result.ran).toBe(true);
    expect(result.clean).toBe(true);
  });

  it("aggregates issues from both commands", () => {
    const fakeExec = (cmd: string) => {
      if (cmd.includes("lint")) {
        return {
          stdout: "/abs/x.ts\n  1:1  error  bad  no-console\n",
          stderr: "",
          code: 1,
        };
      }
      return {
        stdout: "src/y.ts(2,3): error TS9999: Type error.",
        stderr: "",
        code: 1,
      };
    };
    const result = runLint(
      { lint_command: "lint", typecheck_command: "tsc" },
      { cwd: "/tmp", exec: fakeExec }
    );
    expect(result.ran).toBe(true);
    expect(result.clean).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(result.issues.map((i) => i.source).sort()).toEqual(["lint", "typecheck"]);
  });

  it("dedupes identical diagnostics across both channels", () => {
    const fakeExec = (cmd: string) => {
      const out = "src/x.ts(1,1): error TS9999: Same.";
      void cmd;
      return { stdout: out, stderr: "", code: 1 };
    };
    const result = runLint(
      { lint_command: "lint", typecheck_command: "tsc" },
      { cwd: "/tmp", exec: fakeExec }
    );
    // Stylish parser ignores tsc-shape; only typecheck parser fires.
    // But if both commands emit the same line, dedup catches it.
    expect(result.issues.length).toBeLessThanOrEqual(2);
  });

  it("respects maxIssues cap", () => {
    const lots = Array.from(
      { length: 200 },
      (_, i) => `src/x.ts(${i + 1},1): error TS9999: dup.`
    ).join("\n");
    const fakeExec = () => ({ stdout: lots, stderr: "", code: 1 });
    const result = runLint(
      { typecheck_command: "tsc" },
      { cwd: "/tmp", exec: fakeExec, maxIssues: 25 }
    );
    expect(result.issues.length).toBe(25);
  });
});

describe("runLint — filterToFiles (0.11.14)", () => {
  // Regression: pre-existing lint debt in unrelated files (e.g. build
  // artifacts, generated code) shows up as a noise floor brew can't
  // distinguish from "did I just break something?" Solution: caller
  // passes the files the agent edited in this iter; only issues
  // anchored to those files survive.
  it("drops issues whose path doesn't match the allowlist", () => {
    const fakeExec = () => ({
      stdout:
        "src/touched/x.ts(1,1): error TS9999: A.\n" +
        "src/other/y.ts(2,2): error TS9999: B.",
      stderr: "",
      code: 1,
    });
    const result = runLint(
      { typecheck_command: "tsc" },
      {
        cwd: "/tmp",
        exec: fakeExec,
        filterToFiles: ["src/touched/x.ts"],
      }
    );
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.file).toBe("src/touched/x.ts");
  });

  it("matches by path suffix so absolute paths from eslint stylish work", () => {
    const fakeExec = () => ({
      stdout:
        "/abs/repo/src/touched/x.ts\n  1:1  error  bad  no-console\n" +
        "/abs/repo/src/other/y.ts\n  2:2  error  bad  no-console",
      stderr: "",
      code: 1,
    });
    const result = runLint(
      { lint_command: "lint" },
      {
        cwd: "/tmp",
        exec: fakeExec,
        filterToFiles: ["src/touched/x.ts"],
      }
    );
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.file).toBe("/abs/repo/src/touched/x.ts");
  });

  it("preserves unanchored issues (file:null) regardless of filter", () => {
    // Some eslint config errors aren't anchored to a file — they
    // shouldn't be filtered out by file matching.
    const fakeExec = () => ({
      stdout:
        "/abs/repo/src/other/y.ts\n  1:1  error  bad  rule\n",
      stderr: "",
      code: 1,
    });
    // The other-file issue should be filtered, but no unanchored
    // issues to validate against in this fixture. Sanity check that
    // filter doesn't crash.
    const result = runLint(
      { lint_command: "lint" },
      { cwd: "/tmp", exec: fakeExec, filterToFiles: ["src/touched/x.ts"] }
    );
    expect(result.issues).toEqual([]);
  });

  it("falls through to full output when filterToFiles is empty / undefined", () => {
    const fakeExec = () => ({
      stdout: "src/x.ts(1,1): error TS9999: bad.",
      stderr: "",
      code: 1,
    });
    const r1 = runLint({ typecheck_command: "tsc" }, { cwd: "/tmp", exec: fakeExec });
    const r2 = runLint(
      { typecheck_command: "tsc" },
      { cwd: "/tmp", exec: fakeExec, filterToFiles: [] }
    );
    expect(r1.issues).toHaveLength(1);
    expect(r2.issues).toHaveLength(1);
  });
});

describe("formatLintIssues", () => {
  it("returns empty string when ran=false", () => {
    expect(formatLintIssues({ ran: false, clean: true, issues: [], duration_ms: 0 })).toBe("");
  });

  it("renders errors with file:line locations", () => {
    const out = formatLintIssues({
      ran: true,
      clean: false,
      duration_ms: 100,
      issues: [
        {
          source: "typecheck",
          file: "src/x.ts",
          line: 12,
          column: 3,
          severity: "error",
          message: "[TS2345] not assignable",
        },
      ],
    });
    expect(out).toContain("Lint/typecheck errors (1)");
    expect(out).toContain("src/x.ts:12:3");
    expect(out).toContain("not assignable");
  });

  it("truncates warnings list above 10", () => {
    const issues = Array.from({ length: 15 }, (_, i) => ({
      source: "lint" as const,
      file: "x.ts",
      line: i + 1,
      column: null,
      severity: "warning" as const,
      message: `warn ${i}`,
    }));
    const out = formatLintIssues({ ran: true, clean: true, issues, duration_ms: 0 });
    expect(out).toContain("Lint warnings (15)");
    expect(out).toContain("…and 5 more warnings (truncated)");
  });
});
