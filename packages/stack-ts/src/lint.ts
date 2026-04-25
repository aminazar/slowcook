import { execSync } from "node:child_process";
import type { LintConfig } from "./stack-config.js";

/**
 * 0.11.13+ — lint + typecheck signal runner for brew's iteration loop.
 * Hard signals (eslint rules + tsc errors) catch convention violations
 * the LLM can't talk its way around. Scaffolded since 0.7.0; finally
 * consumed.
 *
 * Both commands optional. Missing command = empty result, no error.
 * Failures here are first-class signals (not exceptions); we always
 * return a structured result so the caller can fold issues into the
 * next-iter prompt.
 */

export interface LintIssue {
  /** Display source — "lint" for eslint output, "typecheck" for tsc. */
  source: "lint" | "typecheck";
  /** Repo-relative path; null when the issue isn't anchored to a file. */
  file: string | null;
  /** 1-based line number; null when not parseable. */
  line: number | null;
  /** 1-based column when known. */
  column: number | null;
  /** Severity flag from the runner. eslint says "error" / "warning"; tsc errors all count. */
  severity: "error" | "warning";
  /** Single-line message. We truncate at 240 chars to avoid prompt bloat. */
  message: string;
}

export interface LintResult {
  /** True if either command was run. False when nothing's configured. */
  ran: boolean;
  /** True when both commands exited 0 (or weren't configured). */
  clean: boolean;
  issues: LintIssue[];
  /** Wall-clock ms across both commands. */
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
   * 0.11.14+ — when set, only return issues whose file path appears
   * in this allowlist (after path normalisation). Lets brew filter
   * out pre-existing lint debt in unrelated files (e.g., generated
   * .next/ output) and only react to issues its own edits caused.
   *
   * Path matching is suffix-based: an issue path like
   * `/abs/repo/src/x.ts` matches a filter entry `src/x.ts` so callers
   * don't need to normalise absolute paths before passing.
   *
   * Issues with `file: null` are kept regardless — they're not
   * anchored to a file so we can't filter them.
   */
  filterToFiles?: string[];
}

export function runLint(
  config: LintConfig | undefined,
  options: RunLintOptions
): LintResult {
  const start = Date.now();
  if (!config) return { ran: false, clean: true, issues: [], duration_ms: 0 };

  const exec = options.exec ?? defaultExec;
  const max = options.maxIssues ?? 50;
  const issues: LintIssue[] = [];

  if (config.lint_command) {
    const out = exec(config.lint_command, options.cwd);
    issues.push(...parseEslintOutput(out.stdout, out.stderr));
  }

  if (config.typecheck_command) {
    const out = exec(config.typecheck_command, options.cwd);
    issues.push(...parseTscOutput(out.stdout, out.stderr));
  }

  // Deduplicate identical issues (some configs emit the same diagnostic
  // through both lint and typecheck channels) so the prompt doesn't show
  // twins.
  const seen = new Set<string>();
  const deduped: LintIssue[] = [];
  for (const issue of issues) {
    const key = `${issue.source}|${issue.file ?? ""}|${issue.line ?? ""}|${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(issue);
  }

  // 0.11.14+ — file filter. When the caller supplies a list of files
  // brew touched in the current iteration, drop issues anchored to
  // OTHER files. Without this, pre-existing lint debt elsewhere in
  // the project (e.g., generated .next/ output, debt in test files)
  // shows up as a constant noise floor that brew can't distinguish
  // from new errors it just introduced.
  const filtered =
    options.filterToFiles && options.filterToFiles.length > 0
      ? deduped.filter((i) => {
          if (i.file === null) return true; // unanchored — keep
          return options.filterToFiles!.some((f) => i.file!.endsWith(f));
        })
      : deduped;

  const truncated = filtered.slice(0, max);
  return {
    ran: true,
    clean: truncated.every((i) => i.severity !== "error"),
    issues: truncated,
    duration_ms: Date.now() - start,
  };
}

/**
 * Parse eslint output. We accept BOTH stylish output ("/abs/path/x.ts:12:3 error  ..."
 * — the human-readable default) and JSON-format output (when consumers
 * configure `eslint --format=json`). Stylish covers most cases; JSON is a
 * future-friendly upgrade path.
 */
export function parseEslintOutput(stdout: string, stderr: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const text = stdout + "\n" + stderr;

  // Try JSON first (if the consumer configured --format=json this will work)
  const jsonStart = text.indexOf("[");
  if (jsonStart !== -1) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart));
      if (Array.isArray(parsed)) {
        for (const file of parsed) {
          const filePath = (file as { filePath?: string }).filePath;
          const messages = (file as { messages?: unknown[] }).messages ?? [];
          for (const m of messages) {
            const msg = m as {
              line?: number;
              column?: number;
              severity?: number;
              message?: string;
              ruleId?: string;
            };
            issues.push({
              source: "lint",
              file: filePath ?? null,
              line: msg.line ?? null,
              column: msg.column ?? null,
              severity: (msg.severity ?? 0) >= 2 ? "error" : "warning",
              message: truncate(
                (msg.ruleId ? `[${msg.ruleId}] ` : "") + (msg.message ?? "(no message)"),
                240
              ),
            });
          }
        }
        if (issues.length > 0) return issues;
      }
    } catch {
      // JSON parse failed — fall through to stylish parser.
    }
  }

  // Stylish: lines like "  12:3  error  Some message  rule-id"
  // We look for lines starting with a path, then collect indented diagnostics
  // that follow.
  const lines = text.split("\n");
  let currentFile: string | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    // Path lines: absolute path that ends with .ts, .tsx, .js, .jsx, .mjs, .cjs
    if (/^\/[^\s]+\.(?:tsx?|jsx?|mjs|cjs)$/.test(line.trim())) {
      currentFile = line.trim();
      continue;
    }
    // Diagnostic line: "  12:3  error  Some message  rule-id"
    // Rule ids may include `@scope/rule` (e.g., `@typescript-eslint/no-unused-vars`),
    // so the rule character class must allow `@`.
    const m = line.match(/^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}([\w@/-]+)$/);
    if (m && m[1] && m[2] && m[3] && m[4]) {
      issues.push({
        source: "lint",
        file: currentFile,
        line: parseInt(m[1], 10),
        column: parseInt(m[2], 10),
        severity: m[3] === "error" ? "error" : "warning",
        message: truncate(`[${m[5]}] ${m[4]}`, 240),
      });
    }
  }
  return issues;
}

/**
 * Parse tsc --noEmit output.
 * Format: "src/x.ts(12,3): error TS2345: Some message"
 */
export function parseTscOutput(stdout: string, stderr: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const text = stdout + "\n" + stderr;
  // Group 1: file (relative or absolute)
  // Group 2: line, Group 3: column
  // Group 4: error code (e.g., TS2345)
  // Group 5: message
  const re = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    issues.push({
      source: "typecheck",
      file: m[1] ?? null,
      line: parseInt(m[2] ?? "0", 10),
      column: parseInt(m[3] ?? "0", 10),
      severity: "error",
      message: truncate(`[${m[4]}] ${m[5]}`, 240),
    });
  }
  return issues;
}

/**
 * Format a LintResult for inclusion in the next-iter prompt. Empty when
 * there's nothing to report. Caller decides where in the prompt to put it.
 */
export function formatLintIssues(result: LintResult): string {
  if (!result.ran || result.issues.length === 0) return "";
  const errors = result.issues.filter((i) => i.severity === "error");
  const warnings = result.issues.filter((i) => i.severity === "warning");
  const lines: string[] = [];
  if (errors.length > 0) {
    lines.push(`### Lint/typecheck errors (${errors.length})`);
    for (const i of errors) {
      const loc = i.file
        ? `${i.file}${i.line ? ":" + i.line : ""}${i.column ? ":" + i.column : ""}`
        : "(no location)";
      lines.push(`- [${i.source}] ${loc} — ${i.message}`);
    }
  }
  if (warnings.length > 0) {
    lines.push(`### Lint warnings (${warnings.length})`);
    for (const i of warnings.slice(0, 10)) {
      const loc = i.file ? `${i.file}${i.line ? ":" + i.line : ""}` : "(no location)";
      lines.push(`- [${i.source}] ${loc} — ${i.message}`);
    }
    if (warnings.length > 10) {
      lines.push(`  …and ${warnings.length - 10} more warnings (truncated)`);
    }
  }
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
