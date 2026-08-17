// Shape of .brewing/stack.json as consumed by the stack-ts adapter.
// Mirrors the fields the brewing harness needs; additional fields in the
// file are allowed and ignored (forward compatibility).

export type ReporterFormat =
  | "vitest-list-lines"
  | "playwright-list-lines";

export interface SuiteConfig {
  runner: string;
  run_command: string;
  discover_command: string;
  reporter_format: ReporterFormat | string;
  /**
   * Environment applied to this suite's run AND discover commands.
   *
   * Suites parameterised by env are ordinary (a plug-in implementation, a
   * fixture mode, a base URL). Without this, brew silently ran whatever the
   * suite's DEFAULT was — in the dovizir case a stub that reverts on every
   * call, which no amount of agent work could turn green. Values may
   * reference the ambient environment as `${VAR}` to keep secrets out of
   * the repo.
   */
  env?: Record<string, string>;
}

/**
 * Resolve a suite's declared env, expanding `${VAR}` from the ambient
 * environment. A referenced-but-unset variable is an ERROR naming the
 * variable — expanding to "" hands the runner a plausible empty value and
 * produces a failure far from its cause.
 */
export function resolveSuiteEnv(
  declared: Record<string, string> | undefined,
  ambient: NodeJS.ProcessEnv = process.env
): Record<string, string> | undefined {
  if (!declared) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(declared)) {
    out[key] = raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
      const v = ambient[name];
      if (v === undefined) {
        throw new StackConfigError(
          `stack.json test env ${key} references \${${name}}, which is not set in the environment`
        );
      }
      return v;
    });
  }
  return out;
}

/**
 * 0.11.13+ — lint and typecheck commands surfaced as a hard signal
 * channel for brew's iteration loop. Templates have written this
 * block since 0.7.0 but the schema was silently dropping it on
 * parse, so brew never saw it. Now strongly typed and read.
 */
export interface LintConfig {
  /** Optional. Shell command run after each successful brew edit. Errors fold into the next-iter prompt. */
  lint_command?: string;
  /** Optional. Same shape; for tsc / type-only checking. */
  typecheck_command?: string;
}

export interface StackConfig {
  language: "typescript" | "javascript";
  /**
   * Optional project name for repos holding MORE THAN ONE slowcook project
   * (dovizir handover §3). Story numbering is per-project but git branches are
   * per-repo, so two projects both numbering their first story 001 collided on
   * `slowcook/spec/story-001`. This qualifies the shared namespace:
   * `slowcook/spec/<project_id>/story-001`, and tags PR titles.
   *
   * Omit it in a single-project repo — the scope is then derived from where
   * `.brewing` sits in the worktree, which is empty at the root, so every
   * existing branch name is unchanged.
   */
  project_id?: string;
  package_manager?: string;
  test?: Record<string, SuiteConfig>;
  /** 0.11.13+ — optional lint/typecheck commands. Missing or empty means brew skips lint signals (no-op). */
  lint?: LintConfig;
}

export class StackConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StackConfigError";
  }
}

export function validateStackConfig(raw: unknown): StackConfig {
  if (!raw || typeof raw !== "object") {
    throw new StackConfigError("stack.json must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const language = obj["language"];
  if (language !== "typescript" && language !== "javascript") {
    throw new StackConfigError(
      `stack.json 'language' must be "typescript" or "javascript", got ${JSON.stringify(language)}`
    );
  }
  const config: StackConfig = {
    language,
  };
  if (typeof obj["project_id"] === "string" && obj["project_id"].trim()) {
    config.project_id = obj["project_id"].trim();
  }
  if (typeof obj["package_manager"] === "string") {
    config.package_manager = obj["package_manager"];
  }
  if (obj["test"] && typeof obj["test"] === "object") {
    const suites: Record<string, SuiteConfig> = {};
    for (const [name, suite] of Object.entries(obj["test"] as Record<string, unknown>)) {
      if (!suite || typeof suite !== "object") continue;
      const s = suite as Record<string, unknown>;
      if (
        typeof s["runner"] !== "string" ||
        typeof s["run_command"] !== "string" ||
        typeof s["discover_command"] !== "string" ||
        typeof s["reporter_format"] !== "string"
      ) {
        throw new StackConfigError(
          `stack.json test.${name} missing required fields (runner, run_command, discover_command, reporter_format)`
        );
      }
      suites[name] = {
        runner: s["runner"],
        run_command: s["run_command"],
        discover_command: s["discover_command"],
        reporter_format: s["reporter_format"] as ReporterFormat,
      };
      if (s["env"] !== undefined) {
        if (typeof s["env"] !== "object" || s["env"] === null || Array.isArray(s["env"])) {
          throw new StackConfigError(`stack.json test.${name}.env must be an object of string values`);
        }
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(s["env"] as Record<string, unknown>)) {
          if (typeof v !== "string") {
            throw new StackConfigError(
              `stack.json test.${name}.env.${k} must be a string, got ${typeof v}`
            );
          }
          env[k] = v;
        }
        suites[name]!.env = env;
      }
    }
    config.test = suites;
  }
  // 0.11.13+ — lint block. Tolerate missing or partial blocks; both
  // commands are optional. Brew uses what's set and skips what isn't.
  if (obj["lint"] && typeof obj["lint"] === "object") {
    const l = obj["lint"] as Record<string, unknown>;
    const lint: LintConfig = {};
    if (typeof l["lint_command"] === "string" && l["lint_command"].length > 0) {
      lint.lint_command = l["lint_command"];
    }
    if (typeof l["typecheck_command"] === "string" && l["typecheck_command"].length > 0) {
      lint.typecheck_command = l["typecheck_command"];
    }
    if (lint.lint_command || lint.typecheck_command) {
      config.lint = lint;
    }
  }
  return config;
}
