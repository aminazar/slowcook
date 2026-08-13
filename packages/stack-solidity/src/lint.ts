// Lint signal runner for Foundry projects. Structurally identical to
// stack-ts's LintResult/LintIssue (re-declared — adapters never import
// each other) so brew's iteration loop and formatLintIssues consume
// either stack unchanged.
//
// The canonical Solidity lint command is `forge fmt --check`: exit 0 =
// clean, exit 1 + "Diff in <file>:" blocks = files needing formatting.
// Solidity has no separate typecheck channel — solc runs inside
// `forge test` — so issues here are always source: "lint".

import { execSync } from "node:child_process";
import type { SolidityLintConfig } from "./stack-config.js";

export interface LintIssue {
  /** Display source. Always "lint" for Solidity (no typecheck channel). */
  source: "lint" | "typecheck";
  /** Repo-relative path; null when the issue isn't anchored to a file. */
  file: string | null;
  /** 1-based line number; null when not parseable. */
  line: number | null;
  /** 1-based column when known. */
  column: number | null;
  /** Severity flag from the runner. */
  severity: "error" | "warning";
  /** Single-line message. Truncated at 240 chars to avoid prompt bloat. */
  message: string;
}

export interface LintResult {
  /** True if the command was run. False when nothing's configured. */
  ran: boolean;
  /** True when the command exited 0 (or wasn't configured). */
  clean: boolean;
  issues: LintIssue[];
  /** Wall-clock ms. */
  duration_ms: number;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

type Exec = (cmd: string, cwd: string) => ExecResult;

const defaultExec: Exec = (cmd, cwd) => {
  try {
    const stdout = execSync(cmd, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
      code: err.status ?? 1,
    };
  }
};

export interface RunLintOptions {
  cwd: string;
  exec?: Exec;
  /** Cap on returned issues to avoid prompt bloat. Default 50. */
  maxIssues?: number;
  /**
   * When set, only return issues whose file path appears in this
   * allowlist (suffix-matched, mirroring stack-ts). Issues with
   * `file: null` are kept regardless.
   */
  filterToFiles?: string[];
}

export function runLint(
  config: SolidityLintConfig | undefined,
  options: RunLintOptions
): LintResult {
  const start = Date.now();
  if (!config || !config.lint_command) {
    return { ran: false, clean: true, issues: [], duration_ms: 0 };
  }

  const exec = options.exec ?? defaultExec;
  const max = options.maxIssues ?? 50;

  const out = exec(config.lint_command, options.cwd);
  let issues = parseForgeFmtOutput(out.stdout, out.stderr);
  if (issues.length === 0 && out.code !== 0) {
    // Non-zero exit with no parseable diff blocks — surface the raw
    // output as one unanchored issue so brew still sees the signal.
    issues = [
      {
        source: "lint",
        file: null,
        line: null,
        column: null,
        severity: "error",
        message: truncate(
          `lint command exited ${out.code}: ${(out.stderr.trim() || out.stdout.trim()) || "(no output)"}`,
          240
        ),
      },
    ];
  }

  const filtered =
    options.filterToFiles && options.filterToFiles.length > 0
      ? issues.filter((i) => {
          if (i.file === null) return true; // unanchored — keep
          return options.filterToFiles!.some((f) => i.file!.endsWith(f));
        })
      : issues;

  const truncated = filtered.slice(0, max);
  return {
    ran: true,
    clean: truncated.every((i) => i.severity !== "error"),
    issues: truncated,
    duration_ms: Date.now() - start,
  };
}

/**
 * Parse `forge fmt --check` output. Fixture-verified format (forge 1.3.2):
 *
 *   Diff in src/Messy.sol:
 *   1   1    | // SPDX-License-Identifier: MIT
 *   4        |-    uint256   public x;
 *       5    |+    uint256 public x;
 *   ...
 *
 * One issue per "Diff in <file>:" block. Line anchors aren't stable
 * across the diff so we report file-level issues (line: null).
 */
export function parseForgeFmtOutput(stdout: string, stderr: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const text = stdout + "\n" + stderr;
  const re = /^Diff in (.+?):\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    issues.push({
      source: "lint",
      file: m[1]!.trim(),
      line: null,
      column: null,
      severity: "error",
      message: "file is not formatted (forge fmt --check); run `forge fmt` to fix",
    });
  }
  return issues;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
