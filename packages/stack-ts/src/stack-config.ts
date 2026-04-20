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
}

export interface StackConfig {
  language: "typescript" | "javascript";
  package_manager?: string;
  test?: Record<string, SuiteConfig>;
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
    }
    config.test = suites;
  }
  return config;
}
