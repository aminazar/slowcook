import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { runLint, parseForgeFmtOutput } from "./lint.js";

const loadFixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");

describe("parseForgeFmtOutput", () => {
  it("parses real forge fmt --check output (one issue per unformatted file)", () => {
    const issues = parseForgeFmtOutput(loadFixture("fmt-check-fail.txt"), "");
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      source: "lint",
      file: "src/Messy.sol",
      line: null,
      column: null,
      severity: "error",
    });
    expect(issues[1]?.file).toBe("src/Counter.sol");
  });

  it("returns [] on clean output", () => {
    expect(parseForgeFmtOutput("", "")).toEqual([]);
  });
});

describe("runLint", () => {
  it("is a no-op when nothing is configured (ran=false, clean)", () => {
    expect(runLint(undefined, { cwd: "/repo" })).toEqual({
      ran: false,
      clean: true,
      issues: [],
      duration_ms: 0,
    });
    expect(runLint({}, { cwd: "/repo" })).toEqual({
      ran: false,
      clean: true,
      issues: [],
      duration_ms: 0,
    });
  });

  it("reports clean when the lint command exits 0", () => {
    const result = runLint(
      { lint_command: "forge fmt --check" },
      {
        cwd: "/repo",
        exec: (cmd) => {
          expect(cmd).toBe("forge fmt --check");
          return { stdout: "", stderr: "", code: 0 };
        },
      }
    );
    expect(result.ran).toBe(true);
    expect(result.clean).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("turns real fmt --check diffs into error issues (not clean)", () => {
    const result = runLint(
      { lint_command: "forge fmt --check" },
      {
        cwd: "/repo",
        exec: () => ({ stdout: loadFixture("fmt-check-fail.txt"), stderr: "", code: 1 }),
      }
    );
    expect(result.ran).toBe(true);
    expect(result.clean).toBe(false);
    expect(result.issues.map((i) => i.file)).toEqual([
      "src/Messy.sol",
      "src/Counter.sol",
    ]);
  });

  it("filters issues to touched files (suffix match), keeping unanchored ones", () => {
    const result = runLint(
      { lint_command: "forge fmt --check" },
      {
        cwd: "/repo",
        exec: () => ({ stdout: loadFixture("fmt-check-fail.txt"), stderr: "", code: 1 }),
        filterToFiles: ["src/Counter.sol"],
      }
    );
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.file).toBe("src/Counter.sol");
  });

  it("surfaces an unparseable non-zero exit as a single unanchored error", () => {
    const result = runLint(
      { lint_command: "solhint 'src/**/*.sol'" },
      {
        cwd: "/repo",
        exec: () => ({ stdout: "", stderr: "solhint: not found", code: 127 }),
      }
    );
    expect(result.clean).toBe(false);
    expect(result.issues).toEqual([
      {
        source: "lint",
        file: null,
        line: null,
        column: null,
        severity: "error",
        message: "lint command exited 127: solhint: not found",
      },
    ]);
  });

  it("caps issues at maxIssues", () => {
    const many = Array.from({ length: 60 }, (_, i) => `Diff in src/F${i}.sol:`).join("\n");
    const result = runLint(
      { lint_command: "forge fmt --check" },
      {
        cwd: "/repo",
        exec: () => ({ stdout: many, stderr: "", code: 1 }),
      }
    );
    expect(result.issues).toHaveLength(50);
  });
});
