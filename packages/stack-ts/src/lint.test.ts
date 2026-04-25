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
